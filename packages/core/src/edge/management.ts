/** Control-plane enrollment and device-management service contracts. @pk */

import type {
  EdgeConnectionStore,
  EdgeConnectionTerminator,
  EdgeDeviceRecord,
  EdgeDeviceRegistry,
  EdgeInventoryListItem,
  EdgeInventoryListOptions,
  EdgeInventoryUpdate,
} from "./controlPlane.js";
import { edgeError } from "./errors.js";
import {
  EDGE_INVENTORY_SCHEMA_VERSION,
  type EdgeManagedMetadata,
  type EdgeObservedFacts,
  type EdgePublicDeviceRef,
  type EdgeUserMetadata,
} from "./inventory.js";

/** Trusted enrollment input produced after device authorization. @pk */
export interface EdgeJoinRequest {
  readonly tenantId: string;
  readonly subjectId?: string;
  readonly edgeNodeId: string;
  readonly credentialId: string;
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly enrolledAt: number;
}

/** Trusted request context for a tenant-scoped device operation. @pk */
export interface EdgeManagementContext {
  readonly tenantId: string;
  readonly subjectId?: string;
}

/** Agent/operator-safe device view. Credentials and opaque routing IDs are omitted. @pk */
export interface EdgeManagedDeviceView {
  readonly schemaVersion: typeof EDGE_INVENTORY_SCHEMA_VERSION;
  readonly device: EdgePublicDeviceRef;
  readonly user: EdgeUserMetadata;
  readonly observed?: EdgeObservedFacts;
  readonly managed: Pick<EdgeManagedMetadata, "pools" | "updatedAt">;
  readonly revoked: boolean;
  readonly connected: boolean;
  readonly lastSeenAt?: number;
}

/** Canonical service result with stable warnings and next actions. @pk */
export interface EdgeManagementResult<T> {
  readonly ok: true;
  readonly data: T;
  readonly warnings: readonly string[];
  readonly nextActions: readonly string[];
}

/** Canonical paginated service result. @pk */
export interface EdgeManagementPage<T> extends EdgeManagementResult<readonly T[]> {
  readonly pagination: { readonly nextCursor?: string };
}

/** Replaceable control-plane service used by CLI and Edge Control providers. @pk */
export interface EdgeControlPlaneService {
  join(request: EdgeJoinRequest): Promise<EdgeManagementResult<EdgeManagedDeviceView>>;
  update(
    context: EdgeManagementContext,
    deviceName: string,
    update: EdgeInventoryUpdate,
  ): Promise<EdgeManagementResult<EdgeManagedDeviceView>>;
  list(context: EdgeManagementContext, options?: EdgeInventoryListOptions): Promise<EdgeManagementPage<EdgeManagedDeviceView>>;
  get(context: EdgeManagementContext, deviceName: string): Promise<EdgeManagementResult<EdgeManagedDeviceView>>;
  disconnect(context: EdgeManagementContext, deviceName: string): Promise<EdgeManagementResult<EdgeManagedDeviceView>>;
  revoke(context: EdgeManagementContext, deviceName: string): Promise<EdgeManagementResult<EdgeManagedDeviceView>>;
}

/** Reference service composing replaceable registry and connection contracts. @pk */
export class DefaultEdgeControlPlaneService implements EdgeControlPlaneService {
  constructor(
    private readonly devices: EdgeDeviceRegistry,
    private readonly connections: EdgeConnectionStore,
    private readonly terminator: EdgeConnectionTerminator,
  ) {}

  async join(request: EdgeJoinRequest): Promise<EdgeManagementResult<EdgeManagedDeviceView>> {
    const existing = await this.devices.get(request.tenantId, request.edgeNodeId);
    if (!existing) {
      await this.devices.put({
        tenantId: request.tenantId,
        edgeNodeId: request.edgeNodeId,
        credentialId: request.credentialId,
        subjectId: request.subjectId,
        revoked: false,
        connectionGeneration: 0,
        inventorySchemaVersion: EDGE_INVENTORY_SCHEMA_VERSION,
        inventoryVersion: 1,
        user: {
          name: request.name,
          description: request.description,
          tags: request.tags ?? [],
          updatedAt: request.enrolledAt,
        },
        managed: { aliases: [], pools: [], updatedAt: request.enrolledAt },
      });
    } else if (existing.credentialId !== request.credentialId || existing.revoked) {
      throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Enrollment identity cannot replace this device.");
    }
    const record = await this.requireByNode(request.tenantId, request.edgeNodeId);
    return this.result(await this.view(record));
  }

  async update(
    context: EdgeManagementContext,
    deviceName: string,
    update: EdgeInventoryUpdate,
  ): Promise<EdgeManagementResult<EdgeManagedDeviceView>> {
    const record = await this.requireVisible(context, deviceName);
    const updated = await this.devices.updateInventory(context.tenantId, record.edgeNodeId, update);
    return this.result(await this.view(updated));
  }

  async list(
    context: EdgeManagementContext,
    options: EdgeInventoryListOptions = {},
  ): Promise<EdgeManagementPage<EdgeManagedDeviceView>> {
    const { cursor, limit: requestedLimit, ...filters } = options;
    const visible: EdgeInventoryListItem[] = [];
    const seenCursors = new Set<string>();
    let registryCursor: string | undefined;
    for (;;) {
      const page = await this.devices.list(context.tenantId, {
        ...filters,
        limit: 100,
        ...(registryCursor ? { cursor: registryCursor } : {}),
      });
      visible.push(...page.items.filter((record) => this.isVisible(context, record)));
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) throw edgeError("EDGE_PROTOCOL", "Edge inventory cursor did not advance.");
      seenCursors.add(page.nextCursor);
      registryCursor = page.nextCursor;
    }

    const offset = decodeManagementCursor(cursor);
    const limit = Math.max(1, Math.min(100, requestedLimit ?? 50));
    const selected = visible.slice(offset, offset + limit);
    const data = await Promise.all(selected.map((record) => this.view(record)));
    const nextOffset = offset + selected.length;
    return Object.freeze({
      ok: true,
      data: Object.freeze(data),
      pagination: Object.freeze({
        ...(nextOffset < visible.length ? { nextCursor: encodeManagementCursor(nextOffset) } : {}),
      }),
      warnings: Object.freeze([]),
      nextActions: Object.freeze([]),
    });
  }

  async get(context: EdgeManagementContext, deviceName: string): Promise<EdgeManagementResult<EdgeManagedDeviceView>> {
    return this.result(await this.view(await this.requireVisible(context, deviceName)));
  }

  async disconnect(context: EdgeManagementContext, deviceName: string): Promise<EdgeManagementResult<EdgeManagedDeviceView>> {
    const record = await this.requireVisible(context, deviceName);
    const connection = await this.connections.get(context.tenantId, record.edgeNodeId);
    if (connection) {
      await this.terminator.disconnect(
        context.tenantId,
        record.edgeNodeId,
        connection.connectionGeneration,
        "operator-disconnect",
      );
    }
    return this.result(await this.view(record), ["Run the Edge agent to reconnect this device."]);
  }

  async revoke(context: EdgeManagementContext, deviceName: string): Promise<EdgeManagementResult<EdgeManagedDeviceView>> {
    const record = await this.requireVisible(context, deviceName);
    await this.devices.revoke(context.tenantId, record.edgeNodeId);
    const connection = await this.connections.get(context.tenantId, record.edgeNodeId);
    if (connection) {
      await this.terminator.disconnect(
        context.tenantId,
        record.edgeNodeId,
        connection.connectionGeneration,
        "revoked",
      );
    }
    return this.result(await this.view(await this.requireByNode(context.tenantId, record.edgeNodeId)), [
      "Join again with a new device authorization to restore access.",
    ]);
  }

  private async requireVisible(context: EdgeManagementContext, deviceName: string): Promise<EdgeDeviceRecord> {
    const record = await this.devices.getByName(context.tenantId, deviceName);
    if (!record || !this.isVisible(context, record)) {
      throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Edge device is unavailable or unauthorized.");
    }
    return record;
  }

  private isVisible(context: EdgeManagementContext, record: EdgeDeviceRecord | EdgeInventoryListItem): boolean {
    return context.subjectId === undefined || record.subjectId === undefined || record.subjectId === context.subjectId;
  }

  private async requireByNode(tenantId: string, edgeNodeId: string): Promise<EdgeDeviceRecord> {
    const record = await this.devices.get(tenantId, edgeNodeId);
    if (!record) throw edgeError("EDGE_UNAVAILABLE", "Edge device is unavailable.");
    return record;
  }

  private async view(record: EdgeDeviceRecord | EdgeInventoryListItem): Promise<EdgeManagedDeviceView> {
    const user = record.user ?? { name: record.edgeNodeId, tags: [], updatedAt: record.lastSeenAt ?? 0 };
    const managed = record.managed ?? { aliases: [], pools: [], updatedAt: record.lastSeenAt ?? 0 };
    return Object.freeze({
      schemaVersion: EDGE_INVENTORY_SCHEMA_VERSION,
      device: Object.freeze({ name: user.name, inventoryVersion: record.inventoryVersion ?? 1 }),
      user,
      ...(record.observed ? { observed: record.observed } : {}),
      managed: Object.freeze({ pools: managed.pools, updatedAt: managed.updatedAt }),
      revoked: record.revoked,
      connected: (await this.connections.get(record.tenantId, record.edgeNodeId)) !== undefined,
      ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
    });
  }

  private result<T>(data: T, nextActions: readonly string[] = []): EdgeManagementResult<T> {
    return Object.freeze({
      ok: true,
      data,
      warnings: Object.freeze([]),
      nextActions: Object.freeze([...nextActions]),
    });
  }
}

function encodeManagementCursor(offset: number): string {
  return Buffer.from(`edge-management:${offset}`, "utf8").toString("base64url");
}

function decodeManagementCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^edge-management:(\d+)$/.exec(decoded);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0) throw edgeError("EDGE_PROTOCOL", "Edge inventory cursor is invalid.");
  return offset;
}
