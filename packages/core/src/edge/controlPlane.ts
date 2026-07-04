import { edgeError } from "./errors.js";
import type {
  EdgeCapabilityManifestMessage,
  EdgeDesiredStateAckMessage,
  EdgeDesiredStateMessage,
  EdgeSetupStatusMessage,
} from "./controlProtocol.js";

/** Registered edge device record owned by the control plane. @pk */
export interface EdgeDeviceRecord {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly credentialId: string;
  readonly subjectId?: string;
  readonly revoked: boolean;
  readonly connectionGeneration: number;
  readonly lastSeenAt?: number;
}

/** Authenticated active edge connection record. @pk */
export interface EdgeConnectionRecord {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly protocolVersion: number;
  readonly connectedAt: number;
  readonly lastHeartbeatAt: number;
}

/** Replaceable device registry contract. @pk */
export interface EdgeDeviceRegistry {
  get(tenantId: string, edgeNodeId: string): Promise<EdgeDeviceRecord | undefined>;
  put(device: EdgeDeviceRecord): Promise<void>;
  updateConnection(
    tenantId: string,
    edgeNodeId: string,
    generation: number,
    lastSeenAt: number,
  ): Promise<EdgeDeviceRecord>;
  revoke(tenantId: string, edgeNodeId: string): Promise<void>;
}

/** Replaceable desired-state store contract. @pk */
export interface EdgeDesiredStateStore {
  get(tenantId: string, edgeNodeId: string): Promise<EdgeDesiredStateMessage | undefined>;
  publish(state: EdgeDesiredStateMessage): Promise<"published" | "unchanged">;
  acknowledge(ack: EdgeDesiredStateAckMessage): Promise<void>;
  acknowledgedVersion(tenantId: string, edgeNodeId: string): Promise<number | undefined>;
}

/** Replaceable edge setup/readiness store contract. @pk */
export interface EdgeSetupStatusStore {
  get(tenantId: string, edgeNodeId: string, deploymentId: string): Promise<EdgeSetupStatusMessage | undefined>;
  put(status: EdgeSetupStatusMessage): Promise<void>;
}

/** Replaceable capability-manifest cache contract. @pk */
export interface EdgeCapabilityManifestStore {
  get(tenantId: string, edgeNodeId: string, deploymentId: string): Promise<EdgeCapabilityManifestMessage | undefined>;
  put(manifest: EdgeCapabilityManifestMessage): Promise<void>;
  delete(tenantId: string, edgeNodeId: string, deploymentId: string): Promise<void>;
}

/** Replaceable active-connection store contract. @pk */
export interface EdgeConnectionStore {
  get(tenantId: string, edgeNodeId: string): Promise<EdgeConnectionRecord | undefined>;
  bind(connection: EdgeConnectionRecord): Promise<void>;
  heartbeat(tenantId: string, edgeNodeId: string, generation: number, at: number): Promise<void>;
  remove(tenantId: string, edgeNodeId: string, generation: number): Promise<void>;
}

/** Replaceable distributed edge channel broker contract. @pk */
export interface EdgeChannelBroker {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): () => void;
}

/** Reference single-process device registry. Not suitable for multi-instance deployments. @pk */
export class InMemoryEdgeDeviceRegistry implements EdgeDeviceRegistry {
  private readonly devices = new Map<string, EdgeDeviceRecord>();

  async get(tenantId: string, edgeNodeId: string): Promise<EdgeDeviceRecord | undefined> {
    return this.devices.get(key(tenantId, edgeNodeId));
  }

  async put(device: EdgeDeviceRecord): Promise<void> {
    this.devices.set(key(device.tenantId, device.edgeNodeId), Object.freeze({ ...device }));
  }

  async updateConnection(tenantId: string, edgeNodeId: string, generation: number, lastSeenAt: number): Promise<EdgeDeviceRecord> {
    const existing = await this.get(tenantId, edgeNodeId);
    if (!existing || existing.revoked) {
      throw edgeError("EDGE_UNAVAILABLE", "Edge device is unknown or revoked.");
    }
    if (generation <= existing.connectionGeneration) {
      throw edgeError("EDGE_PROTOCOL", "Edge connection generation is stale.");
    }
    const updated = Object.freeze({ ...existing, connectionGeneration: generation, lastSeenAt });
    this.devices.set(key(tenantId, edgeNodeId), updated);
    return updated;
  }

  async revoke(tenantId: string, edgeNodeId: string): Promise<void> {
    const existing = await this.get(tenantId, edgeNodeId);
    if (existing) this.devices.set(key(tenantId, edgeNodeId), Object.freeze({ ...existing, revoked: true }));
  }
}

/** Reference single-process desired-state store. @pk */
export class InMemoryEdgeDesiredStateStore implements EdgeDesiredStateStore {
  private readonly states = new Map<string, EdgeDesiredStateMessage>();
  private readonly acknowledgements = new Map<string, number>();

  async get(tenantId: string, edgeNodeId: string): Promise<EdgeDesiredStateMessage | undefined> {
    return this.states.get(key(tenantId, edgeNodeId));
  }

  async publish(state: EdgeDesiredStateMessage): Promise<"published" | "unchanged"> {
    const storageKey = key(state.tenantId, state.edgeNodeId);
    const existing = this.states.get(storageKey);
    if (existing && state.desiredVersion < existing.desiredVersion) {
      throw edgeError("EDGE_PROTOCOL", "Desired-state version is stale.");
    }
    if (existing && state.desiredVersion === existing.desiredVersion) {
      if (JSON.stringify(existing.deployments) !== JSON.stringify(state.deployments)) {
        throw edgeError("EDGE_PROTOCOL", "Desired-state version was reused with different content.");
      }
      return "unchanged";
    }
    this.states.set(storageKey, Object.freeze({ ...state, deployments: Object.freeze([...state.deployments]) }));
    return "published";
  }

  async acknowledge(ack: EdgeDesiredStateAckMessage): Promise<void> {
    const current = await this.get(ack.tenantId, ack.edgeNodeId);
    if (!current || ack.desiredVersion !== current.desiredVersion) {
      throw edgeError("EDGE_PROTOCOL", "Desired-state acknowledgement is stale or unknown.");
    }
    this.acknowledgements.set(key(ack.tenantId, ack.edgeNodeId), ack.desiredVersion);
  }

  async acknowledgedVersion(tenantId: string, edgeNodeId: string): Promise<number | undefined> {
    return this.acknowledgements.get(key(tenantId, edgeNodeId));
  }
}

/** Reference single-process setup-status store. @pk */
export class InMemoryEdgeSetupStatusStore implements EdgeSetupStatusStore {
  private readonly statuses = new Map<string, EdgeSetupStatusMessage>();
  async get(tenantId: string, edgeNodeId: string, deploymentId: string) {
    return this.statuses.get(key(tenantId, edgeNodeId, deploymentId));
  }
  async put(status: EdgeSetupStatusMessage) {
    this.statuses.set(key(status.tenantId, status.edgeNodeId, status.deploymentId), Object.freeze({ ...status }));
  }
}

/** Reference single-process capability-manifest store. @pk */
export class InMemoryEdgeCapabilityManifestStore implements EdgeCapabilityManifestStore {
  private readonly manifests = new Map<string, EdgeCapabilityManifestMessage>();
  async get(tenantId: string, edgeNodeId: string, deploymentId: string) {
    return this.manifests.get(key(tenantId, edgeNodeId, deploymentId));
  }
  async put(manifest: EdgeCapabilityManifestMessage) {
    this.manifests.set(key(manifest.tenantId, manifest.edgeNodeId, manifest.deploymentId), Object.freeze({ ...manifest }));
  }
  async delete(tenantId: string, edgeNodeId: string, deploymentId: string) {
    this.manifests.delete(key(tenantId, edgeNodeId, deploymentId));
  }
}

/** Reference single-process active-connection store. @pk */
export class InMemoryEdgeConnectionStore implements EdgeConnectionStore {
  private readonly connections = new Map<string, EdgeConnectionRecord>();
  async get(tenantId: string, edgeNodeId: string) {
    return this.connections.get(key(tenantId, edgeNodeId));
  }
  async bind(connection: EdgeConnectionRecord) {
    const existing = await this.get(connection.tenantId, connection.edgeNodeId);
    if (existing && connection.connectionGeneration <= existing.connectionGeneration) {
      throw edgeError("EDGE_PROTOCOL", "Connection generation did not advance.");
    }
    this.connections.set(key(connection.tenantId, connection.edgeNodeId), Object.freeze({ ...connection }));
  }
  async heartbeat(tenantId: string, edgeNodeId: string, generation: number, at: number) {
    const existing = await this.get(tenantId, edgeNodeId);
    if (!existing || existing.connectionGeneration !== generation) {
      throw edgeError("EDGE_PROTOCOL", "Heartbeat belongs to a stale connection.");
    }
    this.connections.set(key(tenantId, edgeNodeId), Object.freeze({ ...existing, lastHeartbeatAt: at }));
  }
  async remove(tenantId: string, edgeNodeId: string, generation: number) {
    const existing = await this.get(tenantId, edgeNodeId);
    if (existing?.connectionGeneration === generation) this.connections.delete(key(tenantId, edgeNodeId));
  }
}

/** Reference single-process pub/sub broker. @pk */
export class InMemoryEdgeChannelBroker implements EdgeChannelBroker {
  private readonly handlers = new Map<string, Set<(message: string) => void>>();
  async publish(channel: string, message: string) {
    for (const handler of this.handlers.get(channel) ?? []) handler(message);
  }
  subscribe(channel: string, handler: (message: string) => void) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }
}

function key(...parts: string[]): string {
  return parts.join("\u0000");
}

