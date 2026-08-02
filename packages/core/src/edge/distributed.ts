/** Distributed Edge adapter contracts, coordination primitives, and diagnostics. @pk */

import { edgeError } from "./errors.js";
import type { EdgeAdapterDiagnostics } from "./inventory.js";

export interface EdgePoolCandidate {
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
  readonly load?: number;
  readonly capacity?: number;
}

export type EdgeCoordinatedPoolStrategy = "round-robin" | "sticky" | "least-loaded" | "highest-capacity";

/** Durable implementations must perform selection/cursor update atomically. @pk */
export interface EdgePoolSelectionStore {
  readonly diagnostics: EdgeAdapterDiagnostics;
  select(
    tenantId: string,
    pool: string,
    candidates: readonly EdgePoolCandidate[],
    strategy: EdgeCoordinatedPoolStrategy,
    stickyKey?: string,
  ): Promise<EdgePoolCandidate>;
}

/** Durable in-flight result correlation used across proxy/gateway instances. @pk */
export interface EdgeResultCorrelation {
  readonly requestId: string;
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
  readonly ownerInstanceId: string;
  readonly expiresAt: number;
}

export interface EdgeResultCorrelationStore {
  readonly diagnostics: EdgeAdapterDiagnostics;
  put(value: EdgeResultCorrelation): Promise<void>;
  take(requestId: string): Promise<EdgeResultCorrelation | undefined>;
  purgeExpired(at: number): Promise<readonly EdgeResultCorrelation[]>;
}

export const EDGE_DISTRIBUTED_CONSISTENCY_REQUIREMENTS = Object.freeze({
  inventory: "Tenant-scoped names and optimistic inventory versions require linearizable compare-and-set writes.",
  presence: "Connection generations require monotonic conditional writes and bounded-expiry reads.",
  selection: "Session selections and child bindings require read-after-write consistency through their expiry window.",
  pool: "Round-robin cursor updates and sticky assignments require atomic selection among the supplied eligible snapshot.",
  correlation: "In-flight results require atomic take semantics so exactly one proxy instance consumes a terminal result.",
  channel: "Channel delivery may be at-least-once; envelopes require request correlation and idempotent terminal consumption.",
});

const IN_MEMORY_DISTRIBUTED_DIAGNOSTICS: EdgeAdapterDiagnostics = Object.freeze({
  adapter: "in-memory-coordination-reference",
  durable: false,
  multiInstance: false,
  productionReady: false,
  warnings: Object.freeze(["In-memory coordination is non-durable and single-process; configure atomic managed adapters for production."]),
});

/** Deterministic reference selector; atomic only within one JavaScript process. @pk */
export class InMemoryEdgePoolSelectionStore implements EdgePoolSelectionStore {
  readonly diagnostics = IN_MEMORY_DISTRIBUTED_DIAGNOSTICS;
  private readonly cursors = new Map<string, number>();
  private readonly sticky = new Map<string, string>();

  async select(
    tenantId: string,
    pool: string,
    candidates: readonly EdgePoolCandidate[],
    strategy: EdgeCoordinatedPoolStrategy,
    stickyKey?: string,
  ): Promise<EdgePoolCandidate> {
    if (candidates.length === 0) throw edgeError("EDGE_UNAVAILABLE", "No eligible Edge pool candidate is available.");
    const sorted = [...candidates].sort((left, right) => left.edgeNodeId.localeCompare(right.edgeNodeId));
    const poolKey = `${tenantId}\u0000${pool}`;
    if (strategy === "sticky") {
      if (!stickyKey) throw edgeError("EDGE_PROTOCOL", "Sticky pool selection requires a sticky key.");
      const key = `${poolKey}\u0000${stickyKey}`;
      const existing = this.sticky.get(key);
      const retained = existing ? sorted.find((candidate) => candidate.edgeNodeId === existing) : undefined;
      if (retained) return retained;
      const selected = sorted[stableHash(stickyKey) % sorted.length]!;
      this.sticky.set(key, selected.edgeNodeId);
      return selected;
    }
    if (strategy === "least-loaded") {
      return sorted.sort((left, right) => (left.load ?? Number.POSITIVE_INFINITY) - (right.load ?? Number.POSITIVE_INFINITY))[0]!;
    }
    if (strategy === "highest-capacity") {
      return sorted.sort((left, right) => (right.capacity ?? 0) - (left.capacity ?? 0))[0]!;
    }
    const cursor = this.cursors.get(poolKey) ?? 0;
    const selected = sorted[cursor % sorted.length]!;
    this.cursors.set(poolKey, cursor + 1);
    return selected;
  }
}

/** Atomic-take in-memory correlation fixture for distributed harnesses. @pk */
export class InMemoryEdgeResultCorrelationStore implements EdgeResultCorrelationStore {
  readonly diagnostics = IN_MEMORY_DISTRIBUTED_DIAGNOSTICS;
  private readonly values = new Map<string, EdgeResultCorrelation>();

  async put(value: EdgeResultCorrelation): Promise<void> {
    if (this.values.has(value.requestId)) throw edgeError("EDGE_PROTOCOL", "Result correlation already exists.");
    this.values.set(value.requestId, Object.freeze({ ...value }));
  }

  async take(requestId: string): Promise<EdgeResultCorrelation | undefined> {
    const value = this.values.get(requestId);
    this.values.delete(requestId);
    return value;
  }

  async purgeExpired(at: number): Promise<readonly EdgeResultCorrelation[]> {
    const removed: EdgeResultCorrelation[] = [];
    for (const [key, value] of this.values) {
      if (value.expiresAt <= at) {
        this.values.delete(key);
        removed.push(value);
      }
    }
    return Object.freeze(removed);
  }
}

export interface EdgeProductionAdapterDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: "EDGE_ADAPTER_NOT_PRODUCTION_READY" | "EDGE_ADAPTER_NOT_DURABLE" | "EDGE_ADAPTER_NOT_MULTI_INSTANCE";
  readonly adapterRole: string;
  readonly message: string;
  readonly nextActions: readonly string[];
}

/** Surface actionable diagnostics when production claims depend on reference adapters. @pk */
export function diagnoseEdgeProductionAdapters(
  adapters: Readonly<Record<string, { readonly diagnostics?: EdgeAdapterDiagnostics } | undefined>>,
  claimsProductionReady: boolean,
): readonly EdgeProductionAdapterDiagnostic[] {
  if (!claimsProductionReady) return Object.freeze([]);
  const diagnostics: EdgeProductionAdapterDiagnostic[] = [];
  for (const [role, adapter] of Object.entries(adapters)) {
    const state = adapter?.diagnostics;
    if (!state?.productionReady) diagnostics.push(diagnostic(role, "EDGE_ADAPTER_NOT_PRODUCTION_READY", "Adapter is not marked production-ready."));
    if (!state?.durable) diagnostics.push(diagnostic(role, "EDGE_ADAPTER_NOT_DURABLE", "Adapter does not preserve state across restart."));
    if (!state?.multiInstance) diagnostics.push(diagnostic(role, "EDGE_ADAPTER_NOT_MULTI_INSTANCE", "Adapter cannot coordinate multiple service instances."));
  }
  return Object.freeze(diagnostics);
}

function diagnostic(role: string, code: EdgeProductionAdapterDiagnostic["code"], message: string): EdgeProductionAdapterDiagnostic {
  return Object.freeze({
    severity: code === "EDGE_ADAPTER_NOT_PRODUCTION_READY" ? "error" : "warning",
    code,
    adapterRole: role,
    message: `${role}: ${message}`,
    nextActions: Object.freeze([`Configure a durable multi-instance ${role} adapter before production rollout.`]),
  });
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}
