/** Pre-pin session selection and isolated orchestration child binding services. @pk */

import { randomUUID } from "node:crypto";
import { edgeError } from "./errors.js";
import type { EdgeInventoryContext, EdgeInventoryService } from "./inventoryService.js";
import type {
  EdgeChildBinding,
  EdgeChildBindingStore,
  EdgePublicDeviceRef,
  EdgeSessionSelection,
  EdgeSessionSelectionStore,
} from "./inventory.js";
import type { SessionBindingStore } from "./sessionBinding.js";

export interface EdgeSessionSelectionRequest {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly tenantId: string;
  readonly targetName: string;
  readonly device: EdgePublicDeviceRef;
  readonly deploymentId?: string;
  readonly ttlMs?: number;
}

export interface EdgeSessionSelectionServiceOptions {
  readonly selections: EdgeSessionSelectionStore;
  readonly bindings: SessionBindingStore;
  readonly inventory: EdgeInventoryService;
  readonly now?: () => number;
  readonly defaultTtlMs?: number;
  readonly maxTtlMs?: number;
}

/** Validates and stores agent-requested device choices only before target pinning. @pk */
export class EdgeSessionSelectionService {
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;

  constructor(private readonly options: EdgeSessionSelectionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs ?? 15 * 60_000;
    this.maxTtlMs = options.maxTtlMs ?? 24 * 60 * 60_000;
  }

  async select(request: EdgeSessionSelectionRequest): Promise<EdgeSessionSelection> {
    const binding = await this.options.bindings.get({
      sessionId: request.sessionId,
      subjectId: request.subjectId,
      targetName: request.targetName,
    });
    if (binding) {
      throw edgeError("EDGE_SESSION_PINNED", "This target is already pinned; start a new session to choose another device.", {
        details: { targetName: request.targetName },
      });
    }
    const context: EdgeInventoryContext = { tenantId: request.tenantId, subjectId: request.subjectId };
    const resolved = await this.options.inventory.revalidateForDispatch(context, request.device, request.deploymentId);
    const ttlMs = Math.max(1, Math.min(this.maxTtlMs, request.ttlMs ?? this.defaultTtlMs));
    const selectedAt = this.now();
    const selection: EdgeSessionSelection = Object.freeze({
      sessionId: request.sessionId,
      subjectId: request.subjectId,
      targetName: request.targetName,
      tenantId: request.tenantId,
      edgeNodeId: resolved.edgeNodeId,
      inventoryVersion: resolved.inventoryVersion,
      selectedAt,
      expiresAt: selectedAt + ttlMs,
    });
    await this.options.selections.put(selection);
    return selection;
  }

  async get(sessionId: string, subjectId: string, targetName: string): Promise<EdgeSessionSelection | undefined> {
    return this.options.selections.get(sessionId, subjectId, targetName);
  }

  async endSession(sessionId: string): Promise<readonly EdgeSessionSelection[]> {
    return this.options.selections.deleteSession(sessionId);
  }
}

export type EdgeChildBindingTerminalReason = "succeeded" | "failed" | "timeout" | "cancelled" | "parent-end" | "shutdown";

export interface EdgeChildBindingAllocation {
  readonly parentSessionId: string;
  readonly parentRequestId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly targetName: string;
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
  readonly ttlMs: number;
  readonly childRequestId?: string;
}

export interface EdgeChildBindingCleanup {
  cleanup(binding: EdgeChildBinding, reason: EdgeChildBindingTerminalReason): void | Promise<void>;
}

export interface EdgeChildBindingManagerOptions {
  readonly store: EdgeChildBindingStore;
  readonly cleanup?: EdgeChildBindingCleanup;
  readonly now?: () => number;
  readonly createId?: () => string;
}

/** Allocates and cleans isolated child bindings without touching parent pins. @pk */
export class EdgeChildBindingManager {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly options: EdgeChildBindingManagerOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async allocate(input: EdgeChildBindingAllocation): Promise<{ binding: EdgeChildBinding; signal: AbortSignal }> {
    const createdAt = this.now();
    const binding = await this.options.store.allocate({
      parentSessionId: input.parentSessionId,
      parentRequestId: input.parentRequestId,
      childRequestId: input.childRequestId ?? this.createId(),
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      targetName: input.targetName,
      edgeNodeId: input.edgeNodeId,
      connectionGeneration: input.connectionGeneration,
      createdAt,
      expiresAt: createdAt + Math.max(1, input.ttlMs),
    });
    const controller = new AbortController();
    this.controllers.set(binding.childBindingId, controller);
    return { binding, signal: controller.signal };
  }

  /** Resolve one child correlation without exposing or changing parent pins. @pk */
  async get(childBindingId: string): Promise<EdgeChildBinding | undefined> {
    return this.options.store.get(childBindingId);
  }

  async finish(childBindingId: string, reason: EdgeChildBindingTerminalReason): Promise<EdgeChildBinding | undefined> {
    const binding = await this.options.store.delete(childBindingId);
    const controller = this.controllers.get(childBindingId);
    this.controllers.delete(childBindingId);
    if (reason === "cancelled" || reason === "timeout" || reason === "parent-end" || reason === "shutdown") {
      controller?.abort();
    }
    if (binding) await this.options.cleanup?.cleanup(binding, reason);
    return binding;
  }

  async cancel(childBindingId: string): Promise<EdgeChildBinding | undefined> {
    return this.finish(childBindingId, "cancelled");
  }

  async endParent(parentSessionId: string, parentRequestId?: string): Promise<readonly EdgeChildBinding[]> {
    const bindings = await this.options.store.deleteParent(parentSessionId, parentRequestId);
    for (const binding of bindings) {
      this.controllers.get(binding.childBindingId)?.abort();
      this.controllers.delete(binding.childBindingId);
      await this.options.cleanup?.cleanup(binding, "parent-end");
    }
    return bindings;
  }

  async purgeExpired(): Promise<readonly EdgeChildBinding[]> {
    const bindings = await this.options.store.purgeExpired(this.now());
    for (const binding of bindings) {
      this.controllers.get(binding.childBindingId)?.abort();
      this.controllers.delete(binding.childBindingId);
      await this.options.cleanup?.cleanup(binding, "timeout");
    }
    return bindings;
  }

  async shutdown(parentSessionIds: readonly string[]): Promise<readonly EdgeChildBinding[]> {
    const removed: EdgeChildBinding[] = [];
    for (const sessionId of parentSessionIds) removed.push(...await this.endParent(sessionId));
    return Object.freeze(removed);
  }
}
