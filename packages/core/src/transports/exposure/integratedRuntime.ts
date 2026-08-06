/**
 * Integrated Edge control-plane runtime composition for local mode.
 * @pk
 */

import path from "node:path";
import {
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgeSetupStatusStore,
} from "../../edge/controlPlane.js";
import {
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
} from "../../edge/inventory.js";
import { EdgeWebSocketGateway } from "../../edge/gateway.js";
import {
  normalizeEdgeControlPlaneConfig,
  type EdgeControlPlaneConfig,
  type NormalizedEdgeControlPlaneConfig,
} from "../../edge/integratedConfig.js";
import { IntegratedEdgeAuthServices } from "../../edge/integratedAuthServices.js";
import {
  EdgeLocalAuthorityStore,
} from "../../edge/integratedLocalStore.js";
import {
  EdgeLocalOperatorServer,
  createEdgeLocalOperatorEndpoint,
} from "../../edge/integratedOperatorChannel.js";
import { edgeError } from "../../edge/errors.js";
import { createEdgeControlPlaneRoutes } from "./edgeControlPlaneRoutes.js";
import { acceptEdgeGatewayWebSocket } from "./edgeGatewayWebSocket.js";
import type { ProxyExposureHttpRoute, ProxyExposureUpgradeRoute } from "./routeRegistry.js";

export type IntegratedEdgeControlPlaneRuntimeOptions = {
  readonly controlPlane: EdgeControlPlaneConfig;
  readonly authDir?: string;
  readonly publicOrigin?: string;
  readonly protectionKey?: string | Buffer;
  readonly listenerHost?: string;
  readonly listenerPort?: number;
};

export type IntegratedEdgeControlPlaneRuntime = {
  readonly config: NormalizedEdgeControlPlaneConfig;
  readonly publicOrigin: string;
  readonly store: EdgeLocalAuthorityStore;
  readonly auth: IntegratedEdgeAuthServices;
  readonly gateway: EdgeWebSocketGateway;
  readonly operator?: EdgeLocalOperatorServer;
  readonly httpRoutes: readonly ProxyExposureHttpRoute[];
  readonly upgradeRoutes: readonly ProxyExposureUpgradeRoute[];
  close(): Promise<void>;
};

/**
 * Open local authority state, authorization services, gateway, operator
 * channel, and exposure routes for an enabled integrated control plane.
 * @pk
 */
export async function startIntegratedEdgeControlPlane(
  options: IntegratedEdgeControlPlaneRuntimeOptions,
): Promise<IntegratedEdgeControlPlaneRuntime> {
  const config = normalizeEdgeControlPlaneConfig(options.controlPlane);
  if (!config) {
    throw edgeError("EDGE_PROTOCOL", "Integrated Edge control plane is not enabled.");
  }
  if (config.mode !== "local") {
    throw edgeError("EDGE_PROTOCOL", "Managed integrated Edge control plane startup is not implemented in this composition path yet.");
  }

  const publicOrigin = resolvePublicOrigin(config, options);
  const authDir = options.authDir ?? ".fentaris";
  const directory = path.resolve(authDir, config.stateDir);
  const protectionKey = options.protectionKey
    ?? process.env.FENTARIS_AUTH_KEY
    ?? `local-edge-authority:${directory}`;
  const store = new EdgeLocalAuthorityStore({ directory, protectionKey });
  await store.open();

  const auth = new IntegratedEdgeAuthServices({
    store,
    config,
    publicOrigin,
  });

  const deviceRegistry = config.adapters?.deviceRegistry ?? new InMemoryEdgeDeviceRegistry();
  const connectionStore = config.adapters?.connectionStore ?? new InMemoryEdgeConnectionStore();
  const desiredStateStore = config.adapters?.desiredStateStore ?? new InMemoryEdgeDesiredStateStore();
  const setupStatusStore = config.adapters?.setupStatusStore ?? new InMemoryEdgeSetupStatusStore();
  const capabilityManifestStore = config.adapters?.capabilityManifestStore ?? new InMemoryEdgeCapabilityManifestStore();
  const presenceStore = config.adapters?.presenceStore ?? new InMemoryEdgePresenceStore();
  const readinessStore = config.adapters?.readinessStore ?? new InMemoryEdgeReadinessStore();

  const gateway = new EdgeWebSocketGateway({
    authenticator: {
      authenticate: async (credential: string, hello: { edgeNodeId: string; tenantId: string; nonce: string; proof: string; supportedVersions: readonly number[] }) => {
        const result = await auth.authenticateHello({
          edgeNodeId: hello.edgeNodeId,
          tenantId: hello.tenantId,
          nonce: hello.nonce,
          proof: hello.proof,
          deviceCredential: credential,
          protocolVersions: hello.supportedVersions,
        });
        if (result.status !== "accepted") {
          throw edgeError("EDGE_PROTOCOL", "Edge gateway authentication failed.");
        }
        return {
          tenantId: result.tenantId,
          edgeNodeId: result.edgeNodeId,
          credentialId: result.credentialId,
        };
      },
    },
    deviceRegistry,
    connectionStore,
    desiredStateStore,
    setupStatusStore,
    capabilityManifestStore,
    presenceStore,
    readinessStore,
  });

  const routes = createEdgeControlPlaneRoutes({
    basePath: config.basePath,
    auth,
    maxRequestBytes: config.maxRequestBytes,
  });

  const upgradeRoutes: ProxyExposureUpgradeRoute[] = [
    {
      path: `${normalizeBase(config.basePath)}/ws`,
      handler: async (req, socket, head) => {
        const gatewaySocket = acceptEdgeGatewayWebSocket(req, socket, head);
        const credential = typeof req.headers.authorization === "string"
          && req.headers.authorization.toLowerCase().startsWith("bearer ")
          ? req.headers.authorization.slice(7).trim()
          : "";
        try {
          await gateway.accept(gatewaySocket, credential);
        } catch {
          gatewaySocket.close(4401, "unauthorized");
        }
      },
    },
  ];

  const operatorEndpoint = createEdgeLocalOperatorEndpoint(directory);
  const operator = new EdgeLocalOperatorServer({
    endpoint: operatorEndpoint,
    approval: auth,
    status: async () => {
      const snapshot = store.snapshot();
      return {
        mode: "local",
        multiInstance: false,
        pendingApprovals: snapshot.authorizationSessions.filter((session: { status: string }) => session.status === "pending").length,
        enrolledDevices: snapshot.enrolledDevices.filter((device: { revoked: boolean }) => !device.revoked).length,
      };
    },
  });
  await operator.start();

  return {
    config,
    publicOrigin,
    store,
    auth,
    gateway,
    operator,
    httpRoutes: routes.httpRoutes,
    upgradeRoutes,
    async close() {
      await operator.close();
      await store.close();
    },
  };
}

function resolvePublicOrigin(
  config: NormalizedEdgeControlPlaneConfig,
  options: IntegratedEdgeControlPlaneRuntimeOptions,
): string {
  if (config.publicOrigin) {
    return config.publicOrigin;
  }
  if (options.publicOrigin) {
    return options.publicOrigin;
  }
  const host = options.listenerHost ?? "127.0.0.1";
  const port = options.listenerPort ?? 3000;
  return `http://${host}:${port}`;
}

function normalizeBase(basePath: string): string {
  const trimmed = basePath.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/_fentaris/edge";
}
