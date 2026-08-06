import { randomBytes, sign } from "node:crypto";
import { arch, hostname, platform as operatingSystem } from "node:os";
import path from "node:path";
import {
  EDGE_PROTOCOL_VERSION,
  EDGE_SUPPORTED_PROTOCOL_VERSIONS,
  edgeError,
  parseEdgeProtocolMessage,
  type EdgeAgentMessage,
  type EdgeControlPlaneMessage,
  type EdgeHelloAckMessage,
  type EdgeObservedFacts,
} from "@fentaris/core";
import {
  EdgeEnrollmentService,
  HttpDeviceAuthorizationProvider,
  HttpEdgeEnrollmentClient,
  type DeviceAuthorizationRequest,
  type EdgeJoinMetadata,
  type EdgeConnection,
  type EdgeConnectionClient,
} from "./enrollment.js";
import {
  ProtectedJsonStore,
  nodeEdgePlatform,
  type EdgePlatform,
} from "./platform.js";
import {
  EdgeAgentRuntime,
  type EdgeConnectionRuntime,
  type EdgeRuntimeSummary,
  type EdgeRuntimeSummaryProvider,
} from "./runtime.js";
import {
  ManagedInstallManager,
  type LocalInstallDatabase,
} from "./install.js";
import {
  LocalSetupManager,
  NodeTerminalSetupPrompter,
  TerminalSetupProvider,
  type LocalGrantDatabase,
} from "./setup.js";
import {
  EdgeWorkloadSupervisor,
  ExecutableAllowlistPolicy,
} from "./supervisor.js";
import { StdioEdgeWorkloadFactory } from "./stdioWorkload.js";

export type { EdgeRuntimeSummary, EdgeRuntimeSummaryProvider } from "./runtime.js";

export interface EdgeAgentStatus extends EdgeRuntimeSummary {
  readonly enrolled: boolean;
  readonly connected: boolean;
  readonly edgeNodeId?: string;
  readonly tenantId?: string;
  readonly enrolledAt?: number;
  readonly connectedAt?: number;
}

export interface EdgeAgentOptions {
  enrollment: EdgeEnrollmentService;
  connection: EdgeConnectionClient;
  platform: EdgePlatform;
  runtime?: EdgeConnectionRuntime;
  runtimeSummary?: EdgeRuntimeSummaryProvider;
  observedFacts?: () => EdgeObservedFacts;
}

/** Enrollment and connection lifecycle used by the CLI and embedders. */
export class EdgeAgent {
  private active?: EdgeConnection;

  constructor(private readonly options: EdgeAgentOptions) {}

  async login(metadata: EdgeJoinMetadata = {}) {
    const login = await this.options.enrollment.login(metadata);
    await this.connect();
    return login;
  }

  async connect(): Promise<void> {
    if (this.active) return;
    const credentials = await this.options.enrollment.connectionCredentials();
    this.active = await this.options.connection.connect({
      gatewayUrl: credentials.config.gatewayUrl,
      edgeNodeId: credentials.config.edgeNodeId,
      tenantId: credentials.config.tenantId,
      deviceCredential: credentials.deviceCredential,
      accessToken: credentials.accessToken,
      publicKey: credentials.keyPair.publicKey,
      privateKey: credentials.keyPair.privateKey,
      runtime: this.options.runtime,
      observedFacts: this.options.observedFacts?.() ?? defaultObservedFacts(),
    });
    const active = this.active;
    void active.closed?.finally(() => {
      if (this.active === active) this.active = undefined;
    });
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async waitUntilDisconnected(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (active.closed) await active.closed;
    else await new Promise<void>(() => undefined);
  }

  isConnected(): boolean {
    return this.active !== undefined;
  }

  async status(): Promise<EdgeAgentStatus> {
    const config = await this.options.platform.configStore.load();
    const summary = await this.options.runtimeSummary?.summary() ?? {
      desiredDeployments: 0,
      readyDeployments: 0,
      blockedDeployments: 0,
      installedPackages: 0,
      pendingInstalls: 0,
      failedInstalls: 0,
    };
    return {
      ...summary,
      enrolled: Boolean(config),
      connected: Boolean(this.active),
      ...(config ? {
        edgeNodeId: config.edgeNodeId,
        tenantId: config.tenantId,
        enrolledAt: config.enrolledAt,
      } : {}),
      ...(this.active ? { connectedAt: this.active.connectedAt } : {}),
    };
  }

  async disconnect(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await active?.close();
  }

  async revoke(): Promise<void> {
    await this.options.enrollment.revokeRemote();
    await this.disconnect();
    await this.options.runtime?.clearLocalState?.();
    await this.options.enrollment.clearLocalIdentity();
  }
}

/** WebSocket connector that proves possession of the enrolled device key. */
export class WebSocketEdgeConnectionClient implements EdgeConnectionClient {
  constructor(private readonly webSocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url)) {}

  async connect(input: Parameters<EdgeConnectionClient["connect"]>[0]): Promise<EdgeConnection> {
    const url = new URL(input.gatewayUrl);
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url.hostname))) {
      throw new Error("Edge gateway must use wss:// except for loopback development");
    }
    const socket = this.webSocketFactory(url.toString());
    const nonce = randomBytes(32).toString("base64url");
    const proof = sign(null, Buffer.from(`${input.edgeNodeId}.${nonce}`), input.privateKey).toString("base64url");
    let ack: EdgeHelloAckMessage | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let runtimeDisconnected = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const disconnectRuntime = async () => {
      if (runtimeDisconnected) return;
      runtimeDisconnected = true;
      if (heartbeat) clearInterval(heartbeat);
      try {
        await input.runtime?.disconnected();
      } finally {
        resolveClosed();
      }
    };
    const send = async (message: EdgeAgentMessage) => {
      if (socket.readyState !== WebSocket.OPEN) {
        throw edgeError("EDGE_UNAVAILABLE", "Edge gateway connection is closed.");
      }
      socket.send(JSON.stringify(message));
    };
    let processing = Promise.resolve();
    const authenticated = new Promise<EdgeHelloAckMessage>((resolve, reject) => {
      const fail = (error: unknown) => {
        reject(error);
        try {
          socket.close(4403, "edge protocol rejected");
        } catch {
          void disconnectRuntime();
        }
      };
      socket.addEventListener("error", () => {
        if (!ack) reject(new Error("Unable to establish the edge gateway connection"));
      });
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          version: EDGE_PROTOCOL_VERSION,
          kind: "edge.hello",
          tenantId: input.tenantId,
          edgeNodeId: input.edgeNodeId,
          supportedVersions: EDGE_SUPPORTED_PROTOCOL_VERSIONS,
          nonce,
          proof,
          deviceCredential: input.deviceCredential,
          accessToken: input.accessToken,
          publicKey: input.publicKey,
        }));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        processing = processing.then(async () => {
          try {
            const message = parseEdgeProtocolMessage(String(event.data));
            if (!ack) {
              if (message.kind !== "edge.hello.ack") {
                throw edgeError("EDGE_PROTOCOL", "Unexpected edge gateway handshake response.");
              }
              if (message.tenantId !== input.tenantId || message.edgeNodeId !== input.edgeNodeId) {
                throw edgeError("EDGE_PROTOCOL", "Edge gateway acknowledged a different device identity.");
              }
              ack = message;
              const publishPresence = async () => {
                if (!ack || ack.protocolVersion !== 2) return;
                const snapshot = await input.runtime?.presenceSnapshot?.() ?? { readiness: [] };
                const reportedAt = Date.now();
                await send({
                  version: 2,
                  kind: "edge.presence",
                  tenantId: ack.tenantId,
                  edgeNodeId: ack.edgeNodeId,
                  connectionGeneration: ack.connectionGeneration,
                  observed: input.observedFacts ?? defaultObservedFacts(reportedAt),
                  ...snapshot,
                  reportedAt,
                });
              };
              await input.runtime?.connected({
                claims: {
                  tenantId: message.tenantId,
                  edgeNodeId: message.edgeNodeId,
                  connectionGeneration: message.connectionGeneration,
                },
                send,
                publishPresence,
              });
              await publishPresence();
              heartbeat = setInterval(() => {
                if (!ack || socket.readyState !== WebSocket.OPEN) return;
                void (async () => {
                  const snapshot = ack?.protocolVersion === 2
                    ? await input.runtime?.presenceSnapshot?.() ?? { readiness: [] }
                    : undefined;
                  await send({
                    version: ack!.protocolVersion,
                    kind: "edge.heartbeat",
                    tenantId: ack!.tenantId,
                    edgeNodeId: ack!.edgeNodeId,
                    connectionGeneration: ack!.connectionGeneration,
                    sentAt: Date.now(),
                    ...(snapshot?.capacity ? { capacity: snapshot.capacity } : {}),
                    ...(snapshot?.load ? { load: snapshot.load } : {}),
                  });
                })().catch(() => socket.close(1011, "edge heartbeat failed"));
              }, 10_000);
              heartbeat.unref?.();
              resolve(message);
              return;
            }
            if (message.kind === "edge.hello.ack" || message.kind === "edge.hello") {
              throw edgeError("EDGE_PROTOCOL", "Unexpected edge handshake frame after authentication.");
            }
            if (
              message.kind !== "edge.desired-state"
              && message.kind !== "mcp.request"
              && message.kind !== "mcp.cancel"
            ) {
              throw edgeError("EDGE_PROTOCOL", "Unexpected message kind from the edge control plane.");
            }
            await input.runtime?.handle(message as Exclude<EdgeControlPlaneMessage, { kind: "edge.hello.ack" }>);
          } catch (error) {
            fail(error);
          }
        });
      });
      socket.addEventListener("close", () => {
        void disconnectRuntime();
        if (!ack) reject(edgeError("EDGE_UNAVAILABLE", "Edge socket closed during authentication."));
      }, { once: true });
    });
    const authenticatedAck = await authenticated;
    return {
      connectedAt: authenticatedAck.serverTime,
      closed,
      close: () => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          void disconnectRuntime().then(resolve);
          return;
        }
        closed.then(resolve);
        socket.close(1000, "local disconnect");
      }),
    };
  }
}

function defaultObservedFacts(reportedAt = Date.now()): EdgeObservedFacts {
  return {
    platform: operatingSystem(),
    architecture: arch(),
    agentVersion: "0.1.0",
    executionFeatures: ["mcp-stdio"],
    reportedAt,
  };
}

export interface DefaultAgentOptions {
  readonly controlPlaneUrl: string;
  readonly platform?: EdgePlatform;
  readonly onVerification: (request: DeviceAuthorizationRequest) => void | Promise<void>;
  readonly executableAllowlist?: readonly string[];
  readonly packageAllowlist?: readonly string[];
}

export function createDefaultEdgeAgent(options: DefaultAgentOptions): EdgeAgent {
  const platform = options.platform ?? nodeEdgePlatform();
  const enrollment = new EdgeEnrollmentService({
    platform,
    controlPlaneUrl: options.controlPlaneUrl,
    authorization: new HttpDeviceAuthorizationProvider(options.controlPlaneUrl),
    enrollment: new HttpEdgeEnrollmentClient(options.controlPlaneUrl),
    callbacks: { onVerification: options.onVerification },
    hostnameLabel: hostname,
  });
  const runtimeRef: { current?: EdgeAgentRuntime } = {};
  const executablePolicy = new ExecutableAllowlistPolicy({
    executables: options.executableAllowlist ?? environmentList("FENTARIS_EDGE_ALLOWED_EXECUTABLES"),
    packages: options.packageAllowlist ?? environmentList("FENTARIS_EDGE_ALLOWED_PACKAGES"),
  });
  const installs = new ManagedInstallManager({
    store: new ProtectedJsonStore<LocalInstallDatabase>(path.join(platform.paths.dataDir, "installs.json")),
    root: path.join(platform.paths.dataDir, "installs"),
    allowInstall: (plan) => executablePolicy.allowInstall(plan),
  });
  const setup = new LocalSetupManager({
    store: new ProtectedJsonStore<LocalGrantDatabase>(path.join(platform.paths.dataDir, "grants.json")),
    credentials: platform.credentialStore,
    provider: new TerminalSetupProvider(new NodeTerminalSetupPrompter()),
    onGrantRevoked: async (_grantId, deploymentIds) => {
      const activeSupervisor = supervisor;
      await Promise.all(deploymentIds.map((deploymentId) => activeSupervisor.blockDeployment(deploymentId)));
    },
    resolveManagedCommand: (requirement) => installs.resolveCommand(requirement),
  });
  const supervisor = new EdgeWorkloadSupervisor({
    setup,
    factory: new StdioEdgeWorkloadFactory(),
    installs,
    executablePolicy,
    reportCapabilityManifest: (deploymentId, recipeDigest, manifest) => {
      if (!runtimeRef.current) {
        throw edgeError("EDGE_UNAVAILABLE", "Edge runtime is not initialized.");
      }
      return runtimeRef.current.reportCapabilityManifest(deploymentId, recipeDigest, manifest);
    },
  });
  const runtime = new EdgeAgentRuntime({ setup, supervisor, installs });
  runtimeRef.current = runtime;
  return new EdgeAgent({
    enrollment,
    connection: new WebSocketEdgeConnectionClient(),
    platform,
    runtime,
    runtimeSummary: runtime,
  });
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function environmentList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
