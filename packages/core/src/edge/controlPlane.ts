import { edgeError } from "./errors.js";
import {
  EDGE_INVENTORY_SCHEMA_VERSION,
  IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS,
  type EdgeAdapterDiagnostics,
  type EdgeManagedMetadata,
  type EdgeObservedFacts,
  type EdgePublicDeviceRef,
  type EdgeUserMetadata,
} from "./inventory.js";
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
  readonly inventorySchemaVersion?: typeof EDGE_INVENTORY_SCHEMA_VERSION;
  readonly inventoryVersion?: number;
  readonly user?: EdgeUserMetadata;
  readonly observed?: EdgeObservedFacts;
  readonly managed?: EdgeManagedMetadata;
}

/** Fully initialized durable inventory record. @pk */
export interface EdgeInventoryRecord extends EdgeDeviceRecord {
  readonly inventorySchemaVersion: typeof EDGE_INVENTORY_SCHEMA_VERSION;
  readonly inventoryVersion: number;
  readonly user: EdgeUserMetadata;
  readonly managed: EdgeManagedMetadata;
}

/** Credential-free inventory record returned from list operations. @pk */
export type EdgeInventoryListItem = Omit<EdgeInventoryRecord, "credentialId"> & {
  readonly deviceRef: EdgePublicDeviceRef;
};

/** Authorization-scoped inventory list filters. @pk */
export interface EdgeInventoryListOptions {
  readonly name?: string;
  readonly tags?: readonly string[];
  readonly pool?: string;
  readonly revoked?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Cursor-paginated credential-free inventory result. @pk */
export interface EdgeInventoryListPage {
  readonly items: readonly EdgeInventoryListItem[];
  readonly nextCursor?: string;
}

/** Optimistic inventory mutation. Only explicitly supplied sections change. @pk */
export interface EdgeInventoryUpdate {
  readonly expectedInventoryVersion: number;
  readonly name?: string;
  readonly description?: string | null;
  readonly tags?: readonly string[];
  readonly observed?: EdgeObservedFacts | null;
  readonly pools?: readonly string[];
  readonly retainPreviousNameUntil?: number;
  readonly updatedAt: number;
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
  readonly diagnostics?: EdgeAdapterDiagnostics;
  get(tenantId: string, edgeNodeId: string): Promise<EdgeDeviceRecord | undefined>;
  getByName(tenantId: string, name: string, at?: number): Promise<EdgeDeviceRecord | undefined>;
  put(device: EdgeDeviceRecord): Promise<void>;
  updateInventory(tenantId: string, edgeNodeId: string, update: EdgeInventoryUpdate): Promise<EdgeInventoryRecord>;
  list(tenantId: string, options?: EdgeInventoryListOptions): Promise<EdgeInventoryListPage>;
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
  readonly diagnostics?: EdgeAdapterDiagnostics;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): () => void;
}

/** Reference single-process device registry. Not suitable for multi-instance deployments. @pk */
export class InMemoryEdgeDeviceRegistry implements EdgeDeviceRegistry {
  readonly diagnostics = IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS;
  private readonly devices = new Map<string, EdgeDeviceRecord>();

  async get(tenantId: string, edgeNodeId: string): Promise<EdgeDeviceRecord | undefined> {
    return this.devices.get(key(tenantId, edgeNodeId));
  }

  async put(device: EdgeDeviceRecord): Promise<void> {
    const initialized = initializeInventory(device);
    this.assertNameAvailable(initialized.tenantId, initialized.user.name, initialized.edgeNodeId);
    this.devices.set(key(device.tenantId, device.edgeNodeId), freezeInventory(initialized));
  }

  async getByName(tenantId: string, name: string, at = Date.now()): Promise<EdgeDeviceRecord | undefined> {
    const normalized = normalizeEdgeDeviceName(name);
    return [...this.devices.values()].find((candidate) => {
      if (candidate.tenantId !== tenantId) return false;
      const record = initializeInventory(candidate);
      return normalizeEdgeDeviceName(record.user.name) === normalized
        || record.managed.aliases.some((alias) => alias.normalizedName === normalized
          && (alias.expiresAt === undefined || alias.expiresAt > at));
    });
  }

  async updateInventory(tenantId: string, edgeNodeId: string, update: EdgeInventoryUpdate): Promise<EdgeInventoryRecord> {
    const existingValue = await this.get(tenantId, edgeNodeId);
    if (!existingValue || existingValue.revoked) {
      throw edgeError("EDGE_UNAVAILABLE", "Edge device is unknown or revoked.");
    }
    const existing = initializeInventory(existingValue);
    if (existing.inventoryVersion !== update.expectedInventoryVersion) {
      throw edgeError("EDGE_INVENTORY_CONFLICT", "Edge inventory version is stale.", {
        details: { expectedInventoryVersion: update.expectedInventoryVersion },
      });
    }
    const name = update.name === undefined ? existing.user.name : validateEdgeDeviceName(update.name);
    this.assertNameAvailable(tenantId, name, edgeNodeId);
    const renamed = normalizeEdgeDeviceName(name) !== normalizeEdgeDeviceName(existing.user.name);
    const aliases = renamed
      ? [...existing.managed.aliases, {
          name: existing.user.name,
          normalizedName: normalizeEdgeDeviceName(existing.user.name),
          retainedAt: update.updatedAt,
          ...(update.retainPreviousNameUntil === undefined ? {} : { expiresAt: update.retainPreviousNameUntil }),
        }]
      : [...existing.managed.aliases];
    const updated = freezeInventory({
      ...existing,
      inventoryVersion: existing.inventoryVersion + 1,
      user: {
        name,
        description: update.description === undefined
          ? existing.user.description
          : update.description === null ? undefined : update.description,
        tags: update.tags === undefined ? existing.user.tags : normalizeStringSet(update.tags),
        updatedAt: update.updatedAt,
      },
      observed: update.observed === undefined
        ? existing.observed
        : update.observed === null ? undefined : update.observed,
      managed: {
        aliases,
        pools: update.pools === undefined ? existing.managed.pools : normalizeStringSet(update.pools),
        updatedAt: update.updatedAt,
      },
    });
    this.devices.set(key(tenantId, edgeNodeId), updated);
    return updated;
  }

  async list(tenantId: string, options: EdgeInventoryListOptions = {}): Promise<EdgeInventoryListPage> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    const offset = decodeCursor(options.cursor);
    const normalizedName = options.name === undefined ? undefined : normalizeEdgeDeviceName(options.name);
    const tags = options.tags === undefined ? undefined : normalizeStringSet(options.tags);
    const records = [...this.devices.values()]
      .filter((record) => record.tenantId === tenantId)
      .map(initializeInventory)
      .filter((record) => options.revoked === undefined || record.revoked === options.revoked)
      .filter((record) => normalizedName === undefined || normalizeEdgeDeviceName(record.user.name).includes(normalizedName))
      .filter((record) => tags === undefined || tags.every((tag) => record.user.tags.includes(tag)))
      .filter((record) => options.pool === undefined || record.managed.pools.includes(options.pool))
      .sort((left, right) => normalizeEdgeDeviceName(left.user.name).localeCompare(normalizeEdgeDeviceName(right.user.name))
        || left.edgeNodeId.localeCompare(right.edgeNodeId));
    const page = records.slice(offset, offset + limit).map(toInventoryListItem);
    const nextOffset = offset + page.length;
    return Object.freeze({
      items: Object.freeze(page),
      ...(nextOffset < records.length ? { nextCursor: nextOffset.toString(36) } : {}),
    });
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

  private assertNameAvailable(tenantId: string, name: string, exceptEdgeNodeId: string): void {
    const normalized = normalizeEdgeDeviceName(validateEdgeDeviceName(name));
    for (const candidateValue of this.devices.values()) {
      if (candidateValue.tenantId !== tenantId || candidateValue.edgeNodeId === exceptEdgeNodeId) continue;
      const candidate = initializeInventory(candidateValue);
      if (normalizeEdgeDeviceName(candidate.user.name) === normalized
        || candidate.managed.aliases.some((alias) => alias.normalizedName === normalized
          && (alias.expiresAt === undefined || alias.expiresAt > Date.now()))) {
        throw edgeError("EDGE_NAME_CONFLICT", "Edge device name is already in use for this tenant.");
      }
    }
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
  readonly diagnostics = IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS;
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

/** Normalize a tenant-scoped public Edge name for collision checks. @pk */
export function normalizeEdgeDeviceName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function validateEdgeDeviceName(name: string): string {
  const trimmed = name.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (trimmed.length === 0 || trimmed.length > 80) {
    throw edgeError("EDGE_PROTOCOL", "Edge device name must contain between 1 and 80 characters.");
  }
  return trimmed;
}

function initializeInventory(device: EdgeDeviceRecord): EdgeInventoryRecord {
  const now = device.lastSeenAt ?? 0;
  return {
    ...device,
    inventorySchemaVersion: EDGE_INVENTORY_SCHEMA_VERSION,
    inventoryVersion: device.inventoryVersion ?? 1,
    user: device.user ?? { name: device.edgeNodeId, tags: [], updatedAt: now },
    managed: device.managed ?? { aliases: [], pools: [], updatedAt: now },
  };
}

function freezeInventory(device: EdgeInventoryRecord): EdgeInventoryRecord {
  return Object.freeze({
    ...device,
    user: Object.freeze({ ...device.user, tags: Object.freeze([...device.user.tags]) }),
    ...(device.observed ? {
      observed: Object.freeze({
        ...device.observed,
        executionFeatures: Object.freeze([...device.observed.executionFeatures]),
      }),
    } : {}),
    managed: Object.freeze({
      ...device.managed,
      aliases: Object.freeze(device.managed.aliases.map((alias) => Object.freeze({ ...alias }))),
      pools: Object.freeze([...device.managed.pools]),
    }),
  });
}

function normalizeStringSet(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => value.normalize("NFKC").trim()).filter(Boolean))].sort());
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[0-9a-z]+$/.test(cursor)) throw edgeError("EDGE_PROTOCOL", "Edge inventory cursor is invalid.");
  const value = Number.parseInt(cursor, 36);
  if (!Number.isSafeInteger(value) || value < 0) throw edgeError("EDGE_PROTOCOL", "Edge inventory cursor is invalid.");
  return value;
}

function toInventoryListItem(record: EdgeInventoryRecord): EdgeInventoryListItem {
  const safe = Object.fromEntries(
    Object.entries(record).filter(([entryKey]) => entryKey !== "credentialId"),
  ) as Omit<EdgeInventoryRecord, "credentialId">;
  return Object.freeze({
    ...safe,
    deviceRef: Object.freeze({ name: record.user.name, inventoryVersion: record.inventoryVersion }),
  });
}
