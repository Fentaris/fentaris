/**
 * Versioned Edge inventory, presence, readiness, selection, and child-binding
 * contracts. Durable adapters may replace every store in this module.
 * @pk
 */

import { randomUUID } from "node:crypto";
import { edgeError } from "./errors.js";
import type { InstallationDigest, InstallationLifecycleState, InstallationReasonCode } from "./installation.js";

/** Current public inventory schema version. @pk */
export const EDGE_INVENTORY_SCHEMA_VERSION = 1 as const;

/** Authority responsible for an inventory value. @pk */
export type EdgeMetadataAuthority = "user" | "agent" | "control-plane";

/** A value paired with its trusted source and capture time. @pk */
export interface AttributedEdgeValue<T> {
  readonly value: T;
  readonly authority: EdgeMetadataAuthority;
  readonly capturedAt: number;
}

/** User-maintained descriptive metadata. It never grants access. @pk */
export interface EdgeUserMetadata {
  readonly name: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly updatedAt: number;
}

/** Authenticated facts observed by the Edge agent. @pk */
export interface EdgeObservedFacts {
  readonly platform: string;
  readonly architecture: string;
  readonly agentVersion: string;
  readonly executionFeatures: readonly string[];
  readonly reportedAt: number;
}

/** Metadata controlled only by the control plane. @pk */
export interface EdgeManagedMetadata {
  readonly aliases: readonly EdgeDeviceAlias[];
  readonly pools: readonly string[];
  readonly updatedAt: number;
}

/** A retained public alias with an optional expiry. @pk */
export interface EdgeDeviceAlias {
  readonly name: string;
  readonly normalizedName: string;
  readonly retainedAt: number;
  readonly expiresAt?: number;
}

/** Stable agent-visible device selector. It intentionally contains no opaque IDs. @pk */
export interface EdgePublicDeviceRef {
  readonly name: string;
  readonly inventoryVersion: number;
}

/** Dynamic execution capacity reported by an authenticated Edge agent. @pk */
export interface EdgeCapacitySnapshot {
  readonly maxConcurrent: number;
  readonly available: number;
  readonly reportedAt: number;
}

/** Dynamic load reported by an authenticated Edge agent. @pk */
export interface EdgeLoadSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly utilization?: number;
  readonly reportedAt: number;
}

/** Heartbeat freshness derived by the control plane. @pk */
export interface EdgeHeartbeatFreshness {
  readonly lastHeartbeatAt: number;
  readonly staleAfterMs: number;
  readonly evaluatedAt: number;
  readonly fresh: boolean;
}

/** Availability derived from authenticated presence and freshness. @pk */
export type EdgePresenceStatus = "online" | "stale" | "offline" | "revoked";

/** High-churn authenticated device presence. @pk */
export interface EdgePresence {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly credentialId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly protocolVersion: number;
  readonly connectedAt: number;
  readonly heartbeat: EdgeHeartbeatFreshness;
  readonly status: EdgePresenceStatus;
  readonly capacity?: EdgeCapacitySnapshot;
  readonly load?: EdgeLoadSnapshot;
}

/** Public, non-sensitive deployment readiness state. @pk */
export type EdgeDeploymentReadinessStatus =
  | "ready"
  | "setup-required"
  | "blocked"
  | "stale"
  | "unavailable";

/** Per-device deployment readiness without grant values or local paths. @pk */
export interface EdgeDeploymentReadiness {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly credentialId?: string;
  readonly connectionGeneration?: number;
  readonly deploymentId: string;
  readonly status: EdgeDeploymentReadinessStatus;
  readonly recipeVersion?: number;
  readonly desiredVersion?: number;
  readonly installationDigest?: InstallationDigest;
  readonly launchDigest?: string;
  readonly installationState?: InstallationLifecycleState;
  readonly reasonCode?: InstallationReasonCode;
  readonly retryable?: boolean;
  readonly attemptId?: string;
  readonly observedAt: number;
  readonly expiresAt?: number;
  readonly reasonCategory?: string;
  readonly nextActions?: readonly string[];
}

/** Durable pre-pin selection requested by an authorized session. @pk */
export interface EdgeSessionSelection {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly targetName: string;
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly inventoryVersion: number;
  readonly selectedAt: number;
  readonly expiresAt: number;
}

/** Isolated placement binding for an explicit orchestration child. @pk */
export interface EdgeChildBinding {
  readonly childBindingId: string;
  readonly parentSessionId: string;
  readonly parentRequestId: string;
  readonly childRequestId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly targetName: string;
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Diagnostics every replaceable Edge adapter exposes. @pk */
export interface EdgeAdapterDiagnostics {
  readonly adapter: string;
  readonly durable: boolean;
  readonly multiInstance: boolean;
  readonly productionReady: boolean;
  readonly warnings: readonly string[];
}

/** Common diagnostics for deterministic single-process reference adapters. @pk */
export const IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS: EdgeAdapterDiagnostics = Object.freeze({
  adapter: "in-memory-reference",
  durable: false,
  multiInstance: false,
  productionReady: false,
  warnings: Object.freeze([
    "In-memory Edge adapters are single-process and non-durable; configure managed adapters for production.",
  ]),
});

/** Replaceable authenticated presence store. @pk */
export interface EdgePresenceStore {
  readonly diagnostics: EdgeAdapterDiagnostics;
  get(tenantId: string, edgeNodeId: string): Promise<EdgePresence | undefined>;
  put(presence: EdgePresence): Promise<void>;
  remove(tenantId: string, edgeNodeId: string, connectionGeneration: number): Promise<EdgePresence | undefined>;
  purgeStale(evaluatedAt: number): Promise<readonly EdgePresence[]>;
}

/** Replaceable per-deployment readiness store. @pk */
export interface EdgeReadinessStore {
  readonly diagnostics: EdgeAdapterDiagnostics;
  get(tenantId: string, edgeNodeId: string, deploymentId: string): Promise<EdgeDeploymentReadiness | undefined>;
  list(tenantId: string, edgeNodeId: string): Promise<readonly EdgeDeploymentReadiness[]>;
  put(readiness: EdgeDeploymentReadiness): Promise<void>;
  delete(tenantId: string, edgeNodeId: string, deploymentId: string): Promise<void>;
  purgeExpired(evaluatedAt: number): Promise<readonly EdgeDeploymentReadiness[]>;
}

/** Replaceable pre-pin session-selection store. @pk */
export interface EdgeSessionSelectionStore {
  readonly diagnostics: EdgeAdapterDiagnostics;
  put(selection: EdgeSessionSelection): Promise<void>;
  get(sessionId: string, subjectId: string, targetName: string): Promise<EdgeSessionSelection | undefined>;
  delete(sessionId: string, subjectId: string, targetName: string): Promise<EdgeSessionSelection | undefined>;
  deleteSession(sessionId: string): Promise<readonly EdgeSessionSelection[]>;
  purgeExpired(evaluatedAt: number): Promise<readonly EdgeSessionSelection[]>;
}

/** Replaceable isolated child-binding store. @pk */
export interface EdgeChildBindingStore {
  readonly diagnostics: EdgeAdapterDiagnostics;
  allocate(input: Omit<EdgeChildBinding, "childBindingId"> & { readonly childBindingId?: string }): Promise<EdgeChildBinding>;
  get(childBindingId: string): Promise<EdgeChildBinding | undefined>;
  delete(childBindingId: string): Promise<EdgeChildBinding | undefined>;
  deleteParent(parentSessionId: string, parentRequestId?: string): Promise<readonly EdgeChildBinding[]>;
  purgeExpired(evaluatedAt: number): Promise<readonly EdgeChildBinding[]>;
}

/** Deterministic single-process presence store. @pk */
export class InMemoryEdgePresenceStore implements EdgePresenceStore {
  readonly diagnostics = IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS;
  private readonly values = new Map<string, EdgePresence>();

  async get(tenantId: string, edgeNodeId: string): Promise<EdgePresence | undefined> {
    return this.values.get(storageKey(tenantId, edgeNodeId));
  }

  async put(presence: EdgePresence): Promise<void> {
    const current = await this.get(presence.tenantId, presence.edgeNodeId);
    if (current && presence.connectionGeneration < current.connectionGeneration) {
      throw edgeError("EDGE_PROTOCOL", "Presence belongs to a stale connection generation.");
    }
    this.values.set(storageKey(presence.tenantId, presence.edgeNodeId), freezePresence(presence));
  }

  async remove(tenantId: string, edgeNodeId: string, connectionGeneration: number): Promise<EdgePresence | undefined> {
    const key = storageKey(tenantId, edgeNodeId);
    const current = this.values.get(key);
    if (!current || current.connectionGeneration !== connectionGeneration) return undefined;
    this.values.delete(key);
    return current;
  }

  async purgeStale(evaluatedAt: number): Promise<readonly EdgePresence[]> {
    const stale: EdgePresence[] = [];
    for (const [key, presence] of this.values) {
      if (presence.heartbeat.fresh
        && presence.heartbeat.lastHeartbeatAt + presence.heartbeat.staleAfterMs <= evaluatedAt) {
        const updated = freezePresence({
          ...presence,
          heartbeat: { ...presence.heartbeat, evaluatedAt, fresh: false },
          status: "stale",
        });
        this.values.set(key, updated);
        stale.push(updated);
      }
    }
    return Object.freeze(stale);
  }
}

/** Deterministic single-process readiness store. @pk */
export class InMemoryEdgeReadinessStore implements EdgeReadinessStore {
  readonly diagnostics = IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS;
  private readonly values = new Map<string, EdgeDeploymentReadiness>();

  async get(tenantId: string, edgeNodeId: string, deploymentId: string): Promise<EdgeDeploymentReadiness | undefined> {
    return this.values.get(storageKey(tenantId, edgeNodeId, deploymentId));
  }

  async list(tenantId: string, edgeNodeId: string): Promise<readonly EdgeDeploymentReadiness[]> {
    return Object.freeze([...this.values.values()]
      .filter((value) => value.tenantId === tenantId && value.edgeNodeId === edgeNodeId)
      .sort((left, right) => left.deploymentId.localeCompare(right.deploymentId)));
  }

  async put(readiness: EdgeDeploymentReadiness): Promise<void> {
    const key = storageKey(readiness.tenantId, readiness.edgeNodeId, readiness.deploymentId);
    const current = this.values.get(key);
    if (current && ((readiness.connectionGeneration ?? 0) < (current.connectionGeneration ?? 0)
      || (readiness.desiredVersion ?? 0) < (current.desiredVersion ?? 0)
      || ((readiness.desiredVersion ?? 0) === (current.desiredVersion ?? 0)
        && current.installationDigest !== undefined && readiness.installationDigest !== current.installationDigest)
      || ((readiness.desiredVersion ?? 0) === (current.desiredVersion ?? 0)
        && current.launchDigest !== undefined && readiness.launchDigest !== current.launchDigest)
      || readiness.observedAt < current.observedAt)) {
      throw edgeError("EDGE_PROTOCOL", "Readiness belongs to stale or mismatched desired state.");
    }
    this.values.set(key, freezeReadiness(readiness));
  }

  async delete(tenantId: string, edgeNodeId: string, deploymentId: string): Promise<void> {
    this.values.delete(storageKey(tenantId, edgeNodeId, deploymentId));
  }

  async purgeExpired(evaluatedAt: number): Promise<readonly EdgeDeploymentReadiness[]> {
    return purgeMap(this.values, (value) => value.expiresAt !== undefined && value.expiresAt <= evaluatedAt);
  }
}

/** Deterministic single-process pre-pin selection store. @pk */
export class InMemoryEdgeSessionSelectionStore implements EdgeSessionSelectionStore {
  readonly diagnostics = IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS;
  private readonly values = new Map<string, EdgeSessionSelection>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(selection: EdgeSessionSelection): Promise<void> {
    this.values.set(storageKey(selection.sessionId, selection.subjectId, selection.targetName), Object.freeze({ ...selection }));
  }

  async get(sessionId: string, subjectId: string, targetName: string): Promise<EdgeSessionSelection | undefined> {
    const key = storageKey(sessionId, subjectId, targetName);
    const value = this.values.get(key);
    if (value && value.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return value;
  }

  async delete(sessionId: string, subjectId: string, targetName: string): Promise<EdgeSessionSelection | undefined> {
    return deleteMapValue(this.values, storageKey(sessionId, subjectId, targetName));
  }

  async deleteSession(sessionId: string): Promise<readonly EdgeSessionSelection[]> {
    return purgeMap(this.values, (value) => value.sessionId === sessionId);
  }

  async purgeExpired(evaluatedAt: number): Promise<readonly EdgeSessionSelection[]> {
    return purgeMap(this.values, (value) => value.expiresAt <= evaluatedAt);
  }
}

/** Deterministic single-process isolated child-binding store. @pk */
export class InMemoryEdgeChildBindingStore implements EdgeChildBindingStore {
  readonly diagnostics = IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS;
  private readonly values = new Map<string, EdgeChildBinding>();

  constructor(private readonly createId: () => string = randomUUID) {}

  async allocate(input: Omit<EdgeChildBinding, "childBindingId"> & { readonly childBindingId?: string }): Promise<EdgeChildBinding> {
    const childBindingId = input.childBindingId ?? this.createId();
    if (this.values.has(childBindingId)) {
      throw edgeError("EDGE_PROTOCOL", "Child binding identifier is already allocated.");
    }
    const value = Object.freeze({ ...input, childBindingId });
    this.values.set(childBindingId, value);
    return value;
  }

  async get(childBindingId: string): Promise<EdgeChildBinding | undefined> {
    return this.values.get(childBindingId);
  }

  async delete(childBindingId: string): Promise<EdgeChildBinding | undefined> {
    return deleteMapValue(this.values, childBindingId);
  }

  async deleteParent(parentSessionId: string, parentRequestId?: string): Promise<readonly EdgeChildBinding[]> {
    return purgeMap(this.values, (value) => value.parentSessionId === parentSessionId
      && (parentRequestId === undefined || value.parentRequestId === parentRequestId));
  }

  async purgeExpired(evaluatedAt: number): Promise<readonly EdgeChildBinding[]> {
    return purgeMap(this.values, (value) => value.expiresAt <= evaluatedAt);
  }
}

function storageKey(...parts: string[]): string {
  return parts.join("\u0000");
}

function deleteMapValue<T>(values: Map<string, T>, key: string): T | undefined {
  const value = values.get(key);
  if (value !== undefined) values.delete(key);
  return value;
}

function purgeMap<T>(values: Map<string, T>, predicate: (value: T) => boolean): readonly T[] {
  const removed: T[] = [];
  for (const [key, value] of values) {
    if (predicate(value)) {
      values.delete(key);
      removed.push(value);
    }
  }
  return Object.freeze(removed);
}

function freezePresence(presence: EdgePresence): EdgePresence {
  return Object.freeze({
    ...presence,
    heartbeat: Object.freeze({ ...presence.heartbeat }),
    ...(presence.capacity ? { capacity: Object.freeze({ ...presence.capacity }) } : {}),
    ...(presence.load ? { load: Object.freeze({ ...presence.load }) } : {}),
  });
}

function freezeReadiness(readiness: EdgeDeploymentReadiness): EdgeDeploymentReadiness {
  return Object.freeze({
    ...readiness,
    ...(readiness.nextActions ? { nextActions: Object.freeze([...readiness.nextActions]) } : {}),
  });
}
