import { randomBytes, sign } from "node:crypto";
import { hostname } from "node:os";
import { EDGE_PROTOCOL_VERSION, type EdgeHelloAckMessage } from "@fentaris/core";
import {
  EdgeEnrollmentService,
  HttpDeviceAuthorizationProvider,
  HttpEdgeEnrollmentClient,
  type DeviceAuthorizationRequest,
  type EdgeConnection,
  type EdgeConnectionClient,
} from "./enrollment.js";
import { nodeEdgePlatform, type EdgePlatform } from "./platform.js";

export interface EdgeRuntimeSummary {
  readonly desiredDeployments: number;
  readonly readyDeployments: number;
  readonly blockedDeployments: number;
}

export interface EdgeRuntimeSummaryProvider {
  summary(): Promise<EdgeRuntimeSummary>;
}

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
  runtimeSummary?: EdgeRuntimeSummaryProvider;
}

/** Enrollment and connection lifecycle used by the CLI and embedders. */
export class EdgeAgent {
  private active?: EdgeConnection;

  constructor(private readonly options: EdgeAgentOptions) {}

  async login() {
    const login = await this.options.enrollment.login();
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
    });
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async status(): Promise<EdgeAgentStatus> {
    const config = await this.options.platform.configStore.load();
    const summary = await this.options.runtimeSummary?.summary() ?? {
      desiredDeployments: 0,
      readyDeployments: 0,
      blockedDeployments: 0,
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
    const ack = await new Promise<EdgeHelloAckMessage>((resolve, reject) => {
      const onError = () => reject(new Error("Unable to establish the edge gateway connection"));
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          version: EDGE_PROTOCOL_VERSION,
          kind: "edge.hello",
          tenantId: input.tenantId,
          edgeNodeId: input.edgeNodeId,
          supportedVersions: [EDGE_PROTOCOL_VERSION],
          nonce,
          proof,
          deviceCredential: input.deviceCredential,
          accessToken: input.accessToken,
          publicKey: input.publicKey,
        }));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as EdgeHelloAckMessage;
          if (message.kind !== "edge.hello.ack") throw new Error("Unexpected edge gateway handshake response");
          resolve(message);
        } catch (error) {
          reject(error);
        }
      }, { once: true });
    });
    return {
      connectedAt: ack.serverTime,
      close: () => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close(1000, "local disconnect");
      }),
    };
  }
}

export interface DefaultAgentOptions {
  readonly controlPlaneUrl: string;
  readonly platform?: EdgePlatform;
  readonly onVerification: (request: DeviceAuthorizationRequest) => void | Promise<void>;
}

export function createDefaultEdgeAgent(options: DefaultAgentOptions): EdgeAgent {
  const platform = options.platform ?? nodeEdgePlatform();
  const enrollment = new EdgeEnrollmentService({
    platform,
    authorization: new HttpDeviceAuthorizationProvider(options.controlPlaneUrl),
    enrollment: new HttpEdgeEnrollmentClient(options.controlPlaneUrl),
    callbacks: { onVerification: options.onVerification },
    hostnameLabel: hostname,
  });
  return new EdgeAgent({
    enrollment,
    connection: new WebSocketEdgeConnectionClient(),
    platform,
  });
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

