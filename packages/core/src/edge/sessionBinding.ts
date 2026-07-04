/**
 * Session-target binding contracts.
 *
 * A downstream MCP session is pinned to exactly one enrolled edge device per
 * logical execution target for the lifetime of the session. The binding is
 * keyed by `{ sessionId, subjectId, targetName }` so every MCP declaration that
 * uses the same logical target within one downstream session resolves to the
 * same edge node. The store is an interface so a managed multi-instance cloud
 * can back it with durable shared storage; the reference in-memory
 * implementation here is explicitly single-process only.
 *
 * Bindings are created lazily, before the first edge-dependent operation, and
 * are removed on session end, expiry, or runtime shutdown. Fentaris never
 * silently fails over to another device: if the pinned device becomes
 * unavailable the operation fails with `EDGE_UNAVAILABLE`. A reconnect by the
 * same enrolled node may advance the connection generation; a takeover attempt
 * by a different node is rejected.
 * @pk
 */

import { edgeError, type EdgeError } from "./errors.js";
import type { DeviceResolution } from "./placement.js";

/** A monotonically increasing per-device connection generation. @pk */
export type ConnectionGeneration = number;

/** Key identifying one session-target binding. @pk */
export interface SessionBindingKey {
  /** Downstream MCP session id. @pk */
  readonly sessionId: string;
  /** Authenticated subject id, when known. @pk */
  readonly subjectId?: string;
  /** Logical execution-target name. @pk */
  readonly targetName: string;
}

/** A pinned session-target binding. @pk */
export interface SessionTargetBinding {
  /** Downstream MCP session id. @pk */
  readonly sessionId: string;
  /** Authenticated subject id, when known. @pk */
  readonly subjectId?: string;
  /** Logical execution-target name the binding pins. @pk */
  readonly targetName: string;
  /** Stable opaque edge node id backing the device key. @pk */
  readonly edgeNodeId: string;
  /** Control-plane alias, when known. @pk */
  readonly alias?: string;
  /** Connection generation of the edge node at pin time. @pk */
  readonly connectionGeneration: ConnectionGeneration;
  /** Epoch milliseconds when the binding was created. @pk */
  readonly createdAt: number;
  /** Epoch milliseconds of the last access (touch). @pk */
  readonly lastAccessAt: number;
  /** Epoch milliseconds at which the binding expires, when applicable. @pk */
  readonly expiresAt?: number;
}

/** Why a session-target binding was removed. @pk */
export type SessionBindingRemovalReason =
  | "session-end"
  | "expiry"
  | "shutdown"
  | "target-removed"
  | "replaced"
  | "takeover-rejected";

/** Listener notified when bindings are removed. @pk */
export interface SessionBindingListener {
  /** Called for every binding removal. Synchronous listeners must not throw. @pk */
  onSessionBindingRemoved?(binding: SessionTargetBinding, reason: SessionBindingRemovalReason): void;
}

/** Expiry configuration for session-target bindings. @pk */
export interface SessionBindingExpiryOptions {
  /**
   * Idle timeout in milliseconds. Refreshed on every access via {@link
   * SessionBindingStore.get}. When omitted, bindings do not expire by
   * inactivity.
   * @pk
   */
  readonly idleMs?: number;
  /**
   * Fixed absolute expiry in milliseconds from creation. When omitted,
   * bindings do not have a hard lifetime cap.
   * @pk
   */
  readonly fixedMs?: number;
}

/** Input value for {@link SessionBindingStore.store}. @pk */
export type SessionBindingInput = Omit<SessionTargetBinding, "createdAt" | "lastAccessAt" | "expiresAt"> &
  Partial<Pick<SessionTargetBinding, "createdAt" | "lastAccessAt" | "expiresAt">>;

/**
 * Durable contract for session-target bindings.
 *
 * Methods are atomic with respect to a single key: a concurrent `store` for
 * the same key either fully replaces the prior value (same node reconnect) or
 * is rejected (different-node takeover). Implementations must not leak the
 * resolved private device inventory in thrown errors.
 * @pk
 */
export interface SessionBindingStore {
  /**
   * Atomically store a new binding. Idempotent when the same node replays an
   * equal-or-lower generation. Throws `EDGE_UNAVAILABLE` when an existing live
   * binding is pinned to a different edge node (silent takeover is rejected).
   * @pk
   */
  store(key: SessionBindingKey, value: SessionBindingInput): Promise<SessionTargetBinding>;
  /**
   * Read a live binding, refreshing its idle timer. Returns `undefined` when
   * the binding is missing or has expired (expired bindings are removed).
   * @pk
   */
  get(key: SessionBindingKey): Promise<SessionTargetBinding | undefined>;
  /** Delete a specific binding; returns the removed binding, if any. @pk */
  delete(key: SessionBindingKey): Promise<SessionTargetBinding | undefined>;
  /** Delete every binding for a session; returns the removed bindings. @pk */
  deleteSession(sessionId: string): Promise<readonly SessionTargetBinding[]>;
  /** Delete every binding for a target; returns the removed bindings. @pk */
  deleteTarget(targetName: string): Promise<readonly SessionTargetBinding[]>;
  /** Remove and return all expired bindings. @pk */
  purgeExpired(): Promise<readonly SessionTargetBinding[]>;
  /** Remove every binding (runtime shutdown); returns the removed bindings. @pk */
  clear(): Promise<readonly SessionTargetBinding[]>;
  /** List all live bindings for a session. @pk */
  listBySession(sessionId: string): Promise<readonly SessionTargetBinding[]>;
  /** Number of live bindings currently stored. @pk */
  size(): Promise<number>;
  /** Register a removal listener. @pk */
  addListener(listener: SessionBindingListener): void;
}

const keyToString = (key: SessionBindingKey): string => `${key.sessionId}|${key.subjectId ?? ""}|${key.targetName}`;

function nowMs(): number {
  return Date.now();
}

function computeExpiresAt(createdAt: number, at: number, expiry: SessionBindingExpiryOptions): number | undefined {
  const idle = expiry.idleMs !== undefined ? at + expiry.idleMs : undefined;
  const fixed = expiry.fixedMs !== undefined ? createdAt + expiry.fixedMs : undefined;
  const candidates = [idle, fixed].filter((value): value is number => value !== undefined);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function isExpired(binding: SessionTargetBinding, at: number): boolean {
  return binding.expiresAt !== undefined && binding.expiresAt <= at;
}

/**
 * Reference single-process in-memory {@link SessionBindingStore}.
 *
 * Atomicity is implemented with a single async lock serializing mutating
 * operations on the same key; reads use the same lock to observe a consistent
 * snapshot. This implementation is intentionally not durable and not safe for
 * multi-process deployments; managed clouds must supply a durable adapter.
 * @pk
 */
export class InMemorySessionBindingStore implements SessionBindingStore {
  private readonly bindings = new Map<string, SessionTargetBinding>();
  private readonly expiry: SessionBindingExpiryOptions;
  private readonly listeners = new Set<SessionBindingListener>();
  private readonly chain = new Map<string, Promise<unknown>>();
  private readonly globalChain: Promise<unknown> = Promise.resolve();

  constructor(expiry: SessionBindingExpiryOptions = {}) {
    this.expiry = expiry;
  }

  addListener(listener: SessionBindingListener): void {
    this.listeners.add(listener);
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chain.get(key) ?? this.globalChain;
    const run = previous.then(task, task).then(
      (result) => {
        if (this.chain.get(key) === run) {
          this.chain.delete(key);
        }
        return result;
      },
      (error) => {
        if (this.chain.get(key) === run) {
          this.chain.delete(key);
        }
        throw error;
      },
    );
    this.chain.set(key, run);
    return run;
  }

  async store(key: SessionBindingKey, value: SessionBindingInput): Promise<SessionTargetBinding> {
    return this.serialize(keyToString(key), async () => {
      this.purgeExpiredAt(nowMs());
      const existing = this.bindings.get(keyToString(key));
      const createdAt = value.createdAt ?? nowMs();
      const lastAccessAt = value.lastAccessAt ?? createdAt;
      const expiresAt = value.expiresAt ?? computeExpiresAt(createdAt, createdAt, this.expiry);
      if (existing && !isExpired(existing, nowMs())) {
        if (existing.edgeNodeId !== value.edgeNodeId) {
          // Silent takeover is rejected without leaking private inventory. @pk
          throw edgeError("EDGE_UNAVAILABLE", "Session is already pinned to another edge device.", {
            details: { targetName: key.targetName },
          });
        }
        // Same node reconnect may advance the connection generation. @pk
        const updated: SessionTargetBinding = {
          ...existing,
          connectionGeneration: Math.max(existing.connectionGeneration, value.connectionGeneration),
          alias: value.alias ?? existing.alias,
          lastAccessAt,
          expiresAt: expiresAt ?? existing.expiresAt,
        };
        this.bindings.set(keyToString(key), updated);
        return updated;
      }
      const binding: SessionTargetBinding = {
        sessionId: key.sessionId,
        subjectId: key.subjectId,
        targetName: key.targetName,
        edgeNodeId: value.edgeNodeId,
        alias: value.alias,
        connectionGeneration: value.connectionGeneration,
        createdAt,
        lastAccessAt,
        expiresAt,
      };
      this.bindings.set(keyToString(key), binding);
      return binding;
    });
  }

  async get(key: SessionBindingKey): Promise<SessionTargetBinding | undefined> {
    return this.serialize(keyToString(key), async () => {
      const at = nowMs();
      const existing = this.bindings.get(keyToString(key));
      if (!existing) {
        return undefined;
      }
      if (isExpired(existing, at)) {
        this.bindings.delete(keyToString(key));
        this.notifyRemoved(existing, "expiry");
        return undefined;
      }
      const expiresAt =
        this.expiry.idleMs !== undefined || this.expiry.fixedMs !== undefined
          ? computeExpiresAt(existing.createdAt, at, this.expiry)
          : existing.expiresAt;
      const touched: SessionTargetBinding = { ...existing, lastAccessAt: at, expiresAt };
      this.bindings.set(keyToString(key), touched);
      return touched;
    });
  }

  async delete(key: SessionBindingKey): Promise<SessionTargetBinding | undefined> {
    return this.serialize(keyToString(key), async () => {
      const existing = this.bindings.get(keyToString(key));
      if (!existing) {
        return undefined;
      }
      this.bindings.delete(keyToString(key));
      this.notifyRemoved(existing, "replaced");
      return existing;
    });
  }

  async deleteSession(sessionId: string): Promise<readonly SessionTargetBinding[]> {
    return this.serialize(`session:${sessionId}`, async () => {
      const removed: SessionTargetBinding[] = [];
      for (const [key, binding] of this.bindings) {
        if (binding.sessionId === sessionId) {
          this.bindings.delete(key);
          removed.push(binding);
        }
      }
      for (const binding of removed) {
        this.notifyRemoved(binding, "session-end");
      }
      return removed;
    });
  }

  async deleteTarget(targetName: string): Promise<readonly SessionTargetBinding[]> {
    return this.serialize(`target:${targetName}`, async () => {
      const removed: SessionTargetBinding[] = [];
      for (const [key, binding] of this.bindings) {
        if (binding.targetName === targetName) {
          this.bindings.delete(key);
          removed.push(binding);
        }
      }
      for (const binding of removed) {
        this.notifyRemoved(binding, "target-removed");
      }
      return removed;
    });
  }

  async purgeExpired(): Promise<readonly SessionTargetBinding[]> {
    return this.serialize("__global__", async () => this.purgeExpiredAt(nowMs()));
  }

  private purgeExpiredAt(at: number): readonly SessionTargetBinding[] {
    const removed: SessionTargetBinding[] = [];
    for (const [key, binding] of this.bindings) {
      if (isExpired(binding, at)) {
        this.bindings.delete(key);
        removed.push(binding);
      }
    }
    for (const binding of removed) {
      this.notifyRemoved(binding, "expiry");
    }
    return removed;
  }

  async clear(): Promise<readonly SessionTargetBinding[]> {
    return this.serialize("__global__", async () => {
      const removed = [...this.bindings.values()];
      this.bindings.clear();
      for (const binding of removed) {
        this.notifyRemoved(binding, "shutdown");
      }
      return removed;
    });
  }

  async listBySession(sessionId: string): Promise<readonly SessionTargetBinding[]> {
    return this.serialize(`session:${sessionId}`, async () => {
      const at = nowMs();
      const live: SessionTargetBinding[] = [];
      for (const binding of this.bindings.values()) {
        if (binding.sessionId !== sessionId) {
          continue;
        }
        if (isExpired(binding, at)) {
          continue;
        }
        live.push(binding);
      }
      return live;
    });
  }

  async size(): Promise<number> {
    return this.serialize("__global__", async () => {
      this.purgeExpiredAt(nowMs());
      return this.bindings.size;
    });
  }

  private notifyRemoved(binding: SessionTargetBinding, reason: SessionBindingRemovalReason): void {
    for (const listener of this.listeners) {
      try {
        listener.onSessionBindingRemoved?.(binding, reason);
      } catch {
        // Listeners must never break store invariants. @pk
      }
    }
  }
}

export type { EdgeError, DeviceResolution };