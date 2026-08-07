/**
 * Integrated Edge control-plane runtime composition for local mode.
 * @pk
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgeInstallationStatusStore,
  InMemoryEdgeSetupStatusStore,
} from "../../edge/controlPlane.js";
import type {
  EdgeCapabilityManifestStore,
  EdgeConnectionStore,
  EdgeDesiredStateStore,
  EdgeDeviceRegistry,
  EdgeInstallationStatusStore,
  EdgeSetupStatusStore,
} from "../../edge/controlPlane.js";
import {
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
} from "../../edge/inventory.js";
import { EdgeWebSocketGateway } from "../../edge/gateway.js";
import { EdgeTransport } from "../../edge/EdgeTransport.js";
import { EdgeCapabilityCache } from "../../edge/capabilityCache.js";
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
import {
  IntegratedEdgeDeviceResolver,
  IntegratedEdgeReconciler,
  LocalEdgeDesiredAssignmentStore,
  type EdgeDeploymentCatalog,
} from "../../edge/integratedReconciliation.js";
import { IntegratedEdgeGatewayBridge } from "../../edge/integratedBridge.js";
import type { EdgeTelemetry } from "../../edge/observability.js";
import type { EdgePresenceStore, EdgeReadinessStore } from "../../edge/inventory.js";
import type {
  EdgeDeviceAuthorizationService,
  EdgeEnrollmentService,
  EdgeTokenIssuanceService,
} from "../../edge/integratedServices.js";
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
  readonly catalog?: EdgeDeploymentCatalog;
  readonly groupsForSubject?: (subjectId: string) => readonly string[];
  readonly telemetry?: EdgeTelemetry;
};

export type IntegratedEdgeControlPlaneHealth = {
  readonly status: "ok" | "degraded" | "down";
  readonly mode: "local" | "managed";
  readonly multiInstance: boolean;
  readonly authority: "ready" | "unavailable";
  readonly gateway: "ready" | "stopping";
  readonly catalogDeployments: number;
  readonly enrolledDevices: number;
  readonly pendingApprovals: number;
  readonly desiredAssignments: number;
  readonly warnings: readonly string[];
};

export type IntegratedEdgeControlPlaneRuntime = {
  readonly config: NormalizedEdgeControlPlaneConfig;
  readonly publicOrigin: string;
  readonly store?: EdgeLocalAuthorityStore;
  readonly auth: EdgeDeviceAuthorizationService & EdgeTokenIssuanceService & EdgeEnrollmentService;
  readonly gateway: EdgeWebSocketGateway;
  readonly transport: EdgeTransport;
  readonly deviceResolver: IntegratedEdgeDeviceResolver;
  readonly capabilityCache: EdgeCapabilityCache;
  readonly reconciler: IntegratedEdgeReconciler;
  readonly operator?: EdgeLocalOperatorServer;
  readonly httpRoutes: readonly ProxyExposureHttpRoute[];
  readonly upgradeRoutes: readonly ProxyExposureUpgradeRoute[];
  health(): Promise<IntegratedEdgeControlPlaneHealth>;
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
  const publicOrigin = resolvePublicOrigin(config, options);
  const catalog = options.catalog ?? Object.freeze({
    digest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    entries: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });
  const managedAdapters = config.mode === "managed" ? requireManagedAdapters(config) : undefined;
  const deviceRegistry: EdgeDeviceRegistry = managedAdapters?.deviceRegistry
    ?? config.adapters?.deviceRegistry
    ?? new InMemoryEdgeDeviceRegistry();
  const connectionStore: EdgeConnectionStore = managedAdapters?.connectionStore
    ?? config.adapters?.connectionStore
    ?? new InMemoryEdgeConnectionStore();
  const desiredStateStore: EdgeDesiredStateStore = managedAdapters?.desiredStateStore
    ?? config.adapters?.desiredStateStore
    ?? new InMemoryEdgeDesiredStateStore();
  const setupStatusStore: EdgeSetupStatusStore = managedAdapters?.setupStatusStore
    ?? config.adapters?.setupStatusStore
    ?? new InMemoryEdgeSetupStatusStore();
  const capabilityManifestStore: EdgeCapabilityManifestStore = managedAdapters?.capabilityManifestStore
    ?? config.adapters?.capabilityManifestStore
    ?? new InMemoryEdgeCapabilityManifestStore();
  const presenceStore: EdgePresenceStore = managedAdapters?.presenceStore
    ?? config.adapters?.presenceStore
    ?? new InMemoryEdgePresenceStore();
  const readinessStore: EdgeReadinessStore = managedAdapters?.readinessStore
    ?? config.adapters?.readinessStore
    ?? new InMemoryEdgeReadinessStore();
  const installationStatusStore: EdgeInstallationStatusStore = managedAdapters?.installationStatusStore
    ?? config.adapters?.installationStatusStore
    ?? new InMemoryEdgeInstallationStatusStore();
  const capabilityCache = new EdgeCapabilityCache();
  let store: EdgeLocalAuthorityStore | undefined;
  let operator: EdgeLocalOperatorServer | undefined;
  let stopping = false;

  const directory = path.resolve(options.authDir ?? ".fentaris", config.stateDir);
  let auth: EdgeDeviceAuthorizationService & EdgeTokenIssuanceService & EdgeEnrollmentService;
  if (config.mode === "local") {
    const protectionKey = await resolveProtectionKey(directory, options.protectionKey);
    store = new EdgeLocalAuthorityStore({ directory, protectionKey });
    await store.open();
    auth = new IntegratedEdgeAuthServices({
      store,
      config,
      publicOrigin,
      telemetry: options.telemetry,
      onEnrolled: async (device, request) => {
        const now = Date.now();
        await deviceRegistry.put({
          tenantId: device.tenantId,
          edgeNodeId: device.edgeNodeId,
          credentialId: device.credentialId,
          subjectId: device.subjectId,
          revoked: false,
          connectionGeneration: device.connectionGeneration,
          user: {
            name: request.name ?? request.hostnameLabel ?? `edge-${device.edgeNodeId.slice(0, 8)}`,
            description: request.description,
            tags: Object.freeze([...(request.tags ?? [])]),
            updatedAt: now,
          },
          managed: { aliases: Object.freeze([]), pools: Object.freeze([]), updatedAt: now },
        });
        await reconciler?.enqueue({ tenantId: device.tenantId, edgeNodeId: device.edgeNodeId, trigger: "enrollment" });
      },
      onRevoked: async (device) => {
        const active = await connectionStore.get(device.tenantId, device.edgeNodeId);
        await deviceRegistry.revoke(device.tenantId, device.edgeNodeId);
        await reconciler?.enqueue({ tenantId: device.tenantId, edgeNodeId: device.edgeNodeId, trigger: "revocation" });
        if (active) await gateway?.disconnect(device.tenantId, device.edgeNodeId, active.connectionGeneration, "revoked");
      },
    });
  } else {
    auth = managedAuthFacade(managedAdapters!.services);
  }

  const assignmentStore = managedAdapters?.assignmentStore
    ?? (store ? new LocalEdgeDesiredAssignmentStore(store) : undefined);
  if (!assignmentStore) {
    await store?.close();
    throw edgeError("EDGE_PROTOCOL", "Integrated Edge requires a desired-assignment store.");
  }

  let publishDesired: (state: Parameters<EdgeWebSocketGateway["publishDesiredState"]>[0]) => Promise<"published" | "unchanged"> =
    (state) => desiredStateStore.publish(state);
  const reconciler = new IntegratedEdgeReconciler({
    catalog,
    deviceRegistry,
    desiredStateStore,
    assignmentStore,
    publish: (state) => publishDesired(state),
    groupsForSubject: options.groupsForSubject,
    assignmentResolver: config.assignmentResolver ?? managedAdapters?.assignmentResolver,
    telemetry: options.telemetry,
  });
  const bridge = new IntegratedEdgeGatewayBridge({
    devices: deviceRegistry,
    desired: desiredStateStore,
    setup: setupStatusStore,
    manifests: capabilityManifestStore,
    presence: presenceStore,
    readiness: readinessStore,
    reconciler,
    capabilityCache,
    installation: installationStatusStore,
    telemetry: options.telemetry,
  });

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
          connectionGeneration: result.connectionGeneration,
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
    installationStatusStore,
    authorizer: bridge,
    events: bridge,
    telemetry: options.telemetry,
  });
  publishDesired = (state) => gateway.publishDesiredState(state);
  const transport = new EdgeTransport({ channel: gateway, telemetry: options.telemetry });
  const deviceResolver = new IntegratedEdgeDeviceResolver({
    devices: deviceRegistry,
    presence: presenceStore,
    readiness: readinessStore,
    desired: desiredStateStore,
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

  try {
    if (store && auth instanceof IntegratedEdgeAuthServices) {
      const localStore = store;
      for (const device of localStore.snapshot().enrolledDevices) {
        await deviceRegistry.put({
          tenantId: device.tenantId,
          edgeNodeId: device.edgeNodeId,
          credentialId: device.credentialId,
          subjectId: device.subjectId,
          revoked: device.revoked,
          connectionGeneration: device.connectionGeneration,
        });
        if (!device.revoked) {
          await reconciler.enqueue({ tenantId: device.tenantId, edgeNodeId: device.edgeNodeId, trigger: "application-start" });
        }
      }
      const operatorEndpoint = createEdgeLocalOperatorEndpoint(directory);
      operator = new EdgeLocalOperatorServer({
        endpoint: operatorEndpoint,
        approval: auth,
        status: async () => {
          const snapshot = localStore.snapshot();
          return {
            mode: "local",
            multiInstance: false,
            pendingApprovals: snapshot.authorizationSessions.filter((session) => session.status === "pending").length,
            enrolledDevices: snapshot.enrolledDevices.filter((device) => !device.revoked).length,
          };
        },
      });
      await operator.start();
    }
  } catch (error) {
    await transport.close().catch(() => undefined);
    await gateway.close("startup-rollback").catch(() => undefined);
    await operator?.close().catch(() => undefined);
    await store?.close().catch(() => undefined);
    throw error;
  }

  return {
    config,
    publicOrigin,
    store,
    auth,
    gateway,
    transport,
    deviceResolver,
    capabilityCache,
    reconciler,
    operator,
    httpRoutes: routes.httpRoutes,
    upgradeRoutes,
    async health() {
      const local = store?.snapshot();
      const managedPage = local ? undefined : await deviceRegistry.list("default", { limit: 100 });
      const warnings = config.mode === "local"
        ? ["Local Edge authority is single-process and not suitable for multi-instance deployments."]
        : collectAdapterWarnings(config.adapters);
      return {
        status: stopping ? "down" : warnings.length > 0 ? "degraded" : "ok",
        mode: config.mode,
        multiInstance: config.mode === "managed",
        authority: stopping ? "unavailable" : "ready",
        gateway: stopping ? "stopping" : "ready",
        catalogDeployments: catalog.entries.length,
        enrolledDevices: local
          ? local.enrolledDevices.filter((device) => !device.revoked).length
          : managedPage?.items.filter((device) => !device.revoked).length ?? 0,
        pendingApprovals: local?.authorizationSessions.filter((session) => session.status === "pending").length ?? 0,
        desiredAssignments: local?.desiredAssignments.length ?? 0,
        warnings: Object.freeze(warnings.slice(0, 20)),
      };
    },
    async close() {
      if (stopping) return;
      stopping = true;
      reconciler.stopAccepting();
      await reconciler.drain();
      await transport.close();
      await gateway.close();
      await operator?.close();
      await store?.close();
    },
  };
}

function managedAuthFacade(services: NonNullable<NormalizedEdgeControlPlaneConfig["adapters"]>["services"]):
  EdgeDeviceAuthorizationService & EdgeTokenIssuanceService & EdgeEnrollmentService {
  if (!services) throw edgeError("EDGE_PROTOCOL", "Managed Edge authorization services are missing.");
  return {
    begin: (request) => services.authorization.begin(request),
    poll: (request) => services.authorization.poll(request),
    getPendingByUserCode: (userCode) => services.authorization.getPendingByUserCode(userCode),
    issueForApprovedSession: (session) => services.tokens.issueForApprovedSession(session),
    refresh: (request) => services.tokens.refresh(request),
    revokeDeviceTokens: (tenantId, edgeNodeId) => services.tokens.revokeDeviceTokens(tenantId, edgeNodeId),
    inspectAccessToken: (accessToken) => services.tokens.inspectAccessToken(accessToken),
    enroll: (request) => services.enrollment.enroll(request),
    revoke: (request, accessToken) => services.enrollment.revoke(request, accessToken),
    authenticateHello: (proof) => services.enrollment.authenticateHello(proof),
  };
}

function requireManagedAdapters(config: NormalizedEdgeControlPlaneConfig) {
  const adapters = config.adapters;
  const required = [
    "deviceRegistry",
    "desiredStateStore",
    "setupStatusStore",
    "capabilityManifestStore",
    "connectionStore",
    "presenceStore",
    "readinessStore",
    "assignmentStore",
    "services",
  ] as const;
  for (const name of required) {
    if (!adapters?.[name]) throw edgeError("EDGE_PROTOCOL", `Managed Edge adapter ${name} is required.`);
  }
  return adapters as Required<Pick<NonNullable<NormalizedEdgeControlPlaneConfig["adapters"]>, typeof required[number]>>
    & NonNullable<NormalizedEdgeControlPlaneConfig["adapters"]>;
}

function collectAdapterWarnings(adapters: NormalizedEdgeControlPlaneConfig["adapters"]): string[] {
  const warnings = new Set<string>();
  for (const adapter of Object.values(adapters ?? {})) {
    if (adapter && typeof adapter === "object" && "diagnostics" in adapter) {
      for (const warning of (adapter as { diagnostics?: { warnings?: readonly string[] } }).diagnostics?.warnings ?? []) {
        warnings.add(warning);
      }
    }
  }
  return [...warnings];
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

/**
 * Resolve a non-deterministic local protection key.
 * Prefer explicit options / FENTARIS_AUTH_KEY, otherwise load or create an
 * owner-only key file under the authority directory.
 * @pk
 */
async function resolveProtectionKey(
  directory: string,
  explicit?: string | Buffer,
): Promise<string | Buffer> {
  if (explicit !== undefined) {
    return explicit;
  }
  if (process.env.FENTARIS_AUTH_KEY) {
    return process.env.FENTARIS_AUTH_KEY;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, "protection.key");
  try {
    return await readFile(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const key = randomBytes(32);
  await writeFile(keyPath, key, { mode: 0o600 });
  return key;
}

function normalizeBase(basePath: string): string {
  const trimmed = basePath.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/_fentaris/edge";
}
