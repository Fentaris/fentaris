import { randomUUID } from "node:crypto";
import type { EdgeTransportChannel } from "./EdgeTransport.js";
import {
  EDGE_PROTOCOL_VERSION,
  parseEdgeProtocolMessage,
  type EdgeAgentMessage,
  type EdgeDesiredStateMessage,
  type EdgeHelloMessage,
  type EdgeProtocolMessage,
} from "./controlProtocol.js";
import type {
  EdgeCapabilityManifestStore,
  EdgeConnectionRecord,
  EdgeConnectionStore,
  EdgeDesiredStateStore,
  EdgeDeviceRecord,
  EdgeDeviceRegistry,
  EdgeSetupStatusStore,
} from "./controlPlane.js";
import { edgeError } from "./errors.js";
import type { EdgeTelemetry } from "./observability.js";
import type {
  EdgeMcpOutboundEnvelope,
} from "./protocol.js";

/** Minimal server-side WebSocket seam used by the reference gateway. @pk */
export interface EdgeGatewaySocket {
  readonly bufferedAmount?: number;
  send(frame: string): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onMessage(handler: (frame: string) => void): () => void;
  onClose(handler: () => void): () => void;
}

/** Trusted identity returned after validating a device-bound credential/proof. @pk */
export interface AuthenticatedEdgeIdentity {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly credentialId: string;
}

/** Device-bound gateway authentication contract. @pk */
export interface EdgeGatewayAuthenticator {
  authenticate(credential: string, hello: EdgeHelloMessage): Promise<AuthenticatedEdgeIdentity>;
}

/** Per-message authorization input. @pk */
export interface EdgeGatewayAuthorization {
  readonly direction: "inbound" | "outbound";
  readonly identity: AuthenticatedEdgeIdentity;
  readonly connection: EdgeConnectionRecord;
  readonly message: EdgeProtocolMessage | EdgeMcpOutboundEnvelope;
}

/** Server-side message authorization contract. @pk */
export interface EdgeGatewayAuthorizer {
  authorize(input: EdgeGatewayAuthorization): Promise<boolean>;
}

/** Configuration for the reference outbound WebSocket gateway. @pk */
export interface EdgeWebSocketGatewayOptions {
  authenticator: EdgeGatewayAuthenticator;
  deviceRegistry: EdgeDeviceRegistry;
  connectionStore: EdgeConnectionStore;
  desiredStateStore: EdgeDesiredStateStore;
  setupStatusStore: EdgeSetupStatusStore;
  capabilityManifestStore: EdgeCapabilityManifestStore;
  authorizer?: EdgeGatewayAuthorizer;
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  maxBufferedBytes?: number;
  now?: () => number;
  connectionId?: () => string;
  telemetry?: EdgeTelemetry;
}

type ActiveConnection = {
  readonly identity: AuthenticatedEdgeIdentity;
  readonly record: EdgeConnectionRecord;
  readonly socket: EdgeGatewaySocket;
  readonly removeMessage: () => void;
  readonly removeClose: () => void;
};

/**
 * Reference single-process outbound WebSocket gateway.
 *
 * Production multi-instance deployments should replace its active socket map
 * with a distributed channel broker while retaining these authentication,
 * generation, authorization, and protocol semantics.
 * @pk
 */
export class EdgeWebSocketGateway implements EdgeTransportChannel {
  private readonly options: Required<Pick<
    EdgeWebSocketGatewayOptions,
    "handshakeTimeoutMs" | "heartbeatTimeoutMs" | "maxBufferedBytes"
  >> & EdgeWebSocketGatewayOptions;
  private readonly now: () => number;
  private readonly connectionId: () => string;
  private readonly active = new Map<string, ActiveConnection>();
  private readonly mcpHandlers = new Set<(message: unknown) => void>();

  constructor(options: EdgeWebSocketGatewayOptions) {
    this.options = {
      ...options,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 30_000,
      maxBufferedBytes: options.maxBufferedBytes ?? 1_048_576,
    };
    this.now = options.now ?? Date.now;
    this.connectionId = options.connectionId ?? randomUUID;
  }

  /**
   * Accept an outbound edge socket and complete hello/authentication/protocol
   * negotiation before exposing the connection.
   */
  async accept(socket: EdgeGatewaySocket, credential: string): Promise<EdgeConnectionRecord> {
    return new Promise<EdgeConnectionRecord>((resolve, reject) => {
      let established = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (established) return;
        socket.close(4408, "edge hello timeout");
        if (!settled) {
          settled = true;
          reject(edgeError("EDGE_PROTOCOL", "Edge hello timed out."));
        }
      }, this.options.handshakeTimeoutMs);

      const removeMessage = socket.onMessage((frame) => {
        void (async () => {
          try {
            const message = parseEdgeProtocolMessage(frame);
            if (!established) {
              if (message.kind !== "edge.hello") {
                throw edgeError("EDGE_PROTOCOL", "First edge frame must be edge.hello.");
              }
              const active = await this.establish(socket, credential, message, removeMessage, removeClose);
              established = true;
              clearTimeout(timer);
              if (!settled) {
                settled = true;
                resolve(active.record);
              }
              return;
            }
            await this.handleInbound(socket, message as EdgeAgentMessage);
          } catch (error) {
            clearTimeout(timer);
            socket.close(4403, "edge protocol rejected");
            if (!settled) {
              settled = true;
              reject(error);
            }
          }
        })();
      });
      const removeClose = socket.onClose(() => {
        clearTimeout(timer);
        void this.cleanupSocket(socket);
        if (!established && !settled) {
          settled = true;
          reject(edgeError("EDGE_UNAVAILABLE", "Edge socket closed during authentication."));
        }
      });
    });
  }

  /** Send a correlated MCP request/cancellation to its authenticated edge. */
  async send(message: EdgeMcpOutboundEnvelope): Promise<void> {
    const active = this.connectionForNode(message.route.edgeNodeId);
    if (!active || active.record.connectionGeneration !== message.route.connectionGeneration) {
      throw edgeError("EDGE_UNAVAILABLE", "Pinned edge connection is unavailable or stale.");
    }
    await this.authorize("outbound", active, message);
    await this.sendFrame(active, message);
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.mcpHandlers.add(handler);
    return () => this.mcpHandlers.delete(handler);
  }

  /**
   * Publish desired state idempotently. A repeated identical version is stored
   * as unchanged and is not resent; stale or conflicting versions are rejected.
   */
  async publishDesiredState(state: EdgeDesiredStateMessage): Promise<"published" | "unchanged"> {
    const status = await this.options.desiredStateStore.publish(state);
    if (status === "unchanged") return status;
    const active = this.active.get(connectionKey(state.tenantId, state.edgeNodeId));
    if (active) {
      const message: EdgeDesiredStateMessage = {
        ...state,
        connectionGeneration: active.record.connectionGeneration,
      };
      await this.authorize("outbound", active, message);
      await this.sendFrame(active, message);
    }
    await this.options.telemetry?.emit({
      name: "edge.desired.reconciled",
      tenantId: state.tenantId,
      edgeNodeId: state.edgeNodeId,
      connectionGeneration: active?.record.connectionGeneration,
      outcome: "published",
      metadata: { desiredVersion: state.desiredVersion, deploymentCount: state.deployments.length },
    });
    return status;
  }

  /** Close connections whose authenticated heartbeat expired. */
  async sweepExpiredConnections(): Promise<readonly EdgeConnectionRecord[]> {
    const expired: EdgeConnectionRecord[] = [];
    const threshold = this.now() - this.options.heartbeatTimeoutMs;
    for (const active of [...this.active.values()]) {
      const current = await this.options.connectionStore.get(active.record.tenantId, active.record.edgeNodeId);
      if (current && current.connectionGeneration === active.record.connectionGeneration && current.lastHeartbeatAt < threshold) {
        expired.push(current);
        active.socket.close(4408, "edge heartbeat timeout");
        await this.cleanup(active);
      }
    }
    return expired;
  }

  private async establish(
    socket: EdgeGatewaySocket,
    credential: string,
    hello: EdgeHelloMessage,
    removeMessage: () => void,
    removeClose: () => void,
  ): Promise<ActiveConnection> {
    if (!hello.supportedVersions.includes(EDGE_PROTOCOL_VERSION)) {
      throw edgeError("EDGE_PROTOCOL", "No compatible edge protocol version.");
    }
    const identity = await this.options.authenticator.authenticate(credential, hello);
    if (identity.tenantId !== hello.tenantId || identity.edgeNodeId !== hello.edgeNodeId) {
      throw edgeError("EDGE_PROTOCOL", "Authenticated device does not match hello routing claims.");
    }
    const device = await this.requireDevice(identity);
    if (device.credentialId !== identity.credentialId) {
      throw edgeError("EDGE_UNAVAILABLE", "Device credential was revoked or replaced.");
    }
    const now = this.now();
    const generation = device.connectionGeneration + 1;
    await this.options.deviceRegistry.updateConnection(identity.tenantId, identity.edgeNodeId, generation, now);
    const record: EdgeConnectionRecord = {
      tenantId: identity.tenantId,
      edgeNodeId: identity.edgeNodeId,
      connectionId: this.connectionId(),
      connectionGeneration: generation,
      protocolVersion: EDGE_PROTOCOL_VERSION,
      connectedAt: now,
      lastHeartbeatAt: now,
    };
    const storageKey = connectionKey(identity.tenantId, identity.edgeNodeId);
    const previous = this.active.get(storageKey);
    if (previous) {
      previous.socket.close(4409, "new edge connection generation");
      await this.cleanup(previous);
    }
    await this.options.connectionStore.bind(record);
    const active: ActiveConnection = { identity, record, socket, removeMessage, removeClose };
    this.active.set(storageKey, active);
    await this.options.telemetry?.emit({
      name: "edge.connection.generation",
      tenantId: identity.tenantId,
      edgeNodeId: identity.edgeNodeId,
      connectionGeneration: generation,
      outcome: "connected",
    });
    await this.sendFrame(active, {
      version: EDGE_PROTOCOL_VERSION,
      kind: "edge.hello.ack",
      tenantId: identity.tenantId,
      edgeNodeId: identity.edgeNodeId,
      connectionGeneration: generation,
      protocolVersion: EDGE_PROTOCOL_VERSION,
      serverTime: now,
    });
    const desired = await this.options.desiredStateStore.get(identity.tenantId, identity.edgeNodeId);
    if (desired) {
      const message = { ...desired, connectionGeneration: generation };
      await this.authorize("outbound", active, message);
      await this.sendFrame(active, message);
    }
    return active;
  }

  private async handleInbound(socket: EdgeGatewaySocket, message: EdgeAgentMessage): Promise<void> {
    const active = this.connectionForSocket(socket);
    if (!active) {
      throw edgeError("EDGE_UNAVAILABLE", "Message arrived on an inactive edge connection.");
    }
    this.assertInboundClaims(active, message);
    await this.authorize("inbound", active, message);
    switch (message.kind) {
      case "edge.heartbeat":
        await this.options.connectionStore.heartbeat(
          active.record.tenantId,
          active.record.edgeNodeId,
          active.record.connectionGeneration,
          this.now(),
        );
        return;
      case "edge.desired-state.ack":
        await this.options.desiredStateStore.acknowledge(message);
        return;
      case "edge.setup-status":
        await this.options.setupStatusStore.put(message);
        return;
      case "edge.capability-manifest":
        await this.options.capabilityManifestStore.put(message);
        return;
      case "edge.lifecycle":
        return;
      case "mcp.result":
      case "mcp.error":
        for (const handler of this.mcpHandlers) handler(message);
        return;
    }
  }

  private assertInboundClaims(active: ActiveConnection, message: EdgeAgentMessage): void {
    if (message.kind === "mcp.result" || message.kind === "mcp.error") {
      if (
        message.route.edgeNodeId !== active.record.edgeNodeId
        || message.route.connectionGeneration !== active.record.connectionGeneration
      ) {
        throw edgeError("EDGE_PROTOCOL", "MCP response contains forged or stale routing fields.");
      }
      return;
    }
    if (
      message.tenantId !== active.record.tenantId
      || message.edgeNodeId !== active.record.edgeNodeId
      || message.connectionGeneration !== active.record.connectionGeneration
    ) {
      throw edgeError("EDGE_PROTOCOL", "Edge message contains forged or stale routing fields.");
    }
  }

  private async authorize(
    direction: EdgeGatewayAuthorization["direction"],
    active: ActiveConnection,
    message: EdgeProtocolMessage | EdgeMcpOutboundEnvelope,
  ): Promise<void> {
    const allowed = await this.options.authorizer?.authorize({
      direction,
      identity: active.identity,
      connection: active.record,
      message,
    }) ?? true;
    if (!allowed) {
      throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Edge message was not authorized by server-side state.");
    }
  }

  private async sendFrame(active: ActiveConnection, message: EdgeProtocolMessage | EdgeMcpOutboundEnvelope): Promise<void> {
    if ((active.socket.bufferedAmount ?? 0) > this.options.maxBufferedBytes) {
      throw edgeError("EDGE_CAPACITY", "Edge connection backpressure limit exceeded.");
    }
    await active.socket.send(JSON.stringify(message));
  }

  private async requireDevice(identity: AuthenticatedEdgeIdentity): Promise<EdgeDeviceRecord> {
    const device = await this.options.deviceRegistry.get(identity.tenantId, identity.edgeNodeId);
    if (!device || device.revoked) {
      throw edgeError("EDGE_UNAVAILABLE", "Edge device is unknown or revoked.");
    }
    return device;
  }

  private connectionForNode(edgeNodeId: string): ActiveConnection | undefined {
    const matches = [...this.active.values()].filter((entry) => entry.record.edgeNodeId === edgeNodeId);
    if (matches.length > 1) {
      throw edgeError("EDGE_PROTOCOL", "Edge node identity is ambiguous across tenants.");
    }
    return matches[0];
  }

  private connectionForSocket(socket: EdgeGatewaySocket): ActiveConnection | undefined {
    return [...this.active.values()].find((entry) => entry.socket === socket);
  }

  private async cleanupSocket(socket: EdgeGatewaySocket): Promise<void> {
    const active = this.connectionForSocket(socket);
    if (active) await this.cleanup(active);
  }

  private async cleanup(active: ActiveConnection): Promise<void> {
    const storageKey = connectionKey(active.record.tenantId, active.record.edgeNodeId);
    if (this.active.get(storageKey) === active) this.active.delete(storageKey);
    active.removeMessage();
    active.removeClose();
    await this.options.connectionStore.remove(
      active.record.tenantId,
      active.record.edgeNodeId,
      active.record.connectionGeneration,
    );
    await this.options.telemetry?.emit({
      name: "edge.connection.generation",
      tenantId: active.record.tenantId,
      edgeNodeId: active.record.edgeNodeId,
      connectionGeneration: active.record.connectionGeneration,
      outcome: "disconnected",
    });
  }
}

function connectionKey(tenantId: string, edgeNodeId: string): string {
  return `${tenantId}\u0000${edgeNodeId}`;
}
