/** Bounded deterministic multi-device Edge orchestration. @pk */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyContext } from "../types/proxy.js";
import { edgeError, isEdgeError } from "./errors.js";
import type { EdgeInventoryService, EdgeSelectionRequest } from "./inventoryService.js";
import type { EdgePublicDeviceRef } from "./inventory.js";
import type { EdgeSingleCallCoordinator } from "./controlInvocation.js";

export interface EdgeOrchestrationLimits {
  readonly maxDevices: number;
  readonly maxConcurrency: number;
  readonly maxDeadlineMs: number;
  readonly maxSelectorCandidates: number;
  readonly maxChildBytes: number;
  readonly maxAggregateBytes: number;
}

export const DEFAULT_EDGE_ORCHESTRATION_LIMITS: EdgeOrchestrationLimits = Object.freeze({
  maxDevices: 8,
  maxConcurrency: 4,
  maxDeadlineMs: 120_000,
  maxSelectorCandidates: 100,
  maxChildBytes: 1_000_000,
  maxAggregateBytes: 4_000_000,
});

export type EdgeFanoutStatus = "succeeded" | "failed" | "cancelled" | "not-started";

export interface EdgeFanoutEntry {
  readonly device: EdgePublicDeviceRef;
  readonly status: EdgeFanoutStatus;
  readonly correlationId?: string;
  readonly result?: CallToolResult;
  readonly error?: { readonly code: string; readonly message: string; readonly outcome?: "indeterminate" };
  readonly retryable?: false;
}

export interface EdgeFanoutResult {
  readonly status: "succeeded" | "partial" | "failed" | "cancelled";
  readonly failurePolicy: "collect" | "fail-fast";
  readonly resolvedDevices: number;
  readonly counts: Readonly<Record<EdgeFanoutStatus, number>>;
  readonly results: readonly EdgeFanoutEntry[];
  readonly warnings: readonly string[];
  readonly nextActions: readonly string[];
}

export interface EdgeFanoutCoordinatorOptions {
  readonly inventory: EdgeInventoryService;
  readonly single: EdgeSingleCallCoordinator;
  readonly limits?: Partial<EdgeOrchestrationLimits>;
  readonly now?: () => number;
}

/** Coordinates child calls without retries or mutation of transparent parent pins. @pk */
export class EdgeFanoutCoordinator {
  readonly limits: EdgeOrchestrationLimits;
  private readonly now: () => number;

  constructor(private readonly options: EdgeFanoutCoordinatorOptions) {
    this.limits = Object.freeze({ ...DEFAULT_EDGE_ORCHESTRATION_LIMITS, ...options.limits });
    validateLimits(this.limits);
    this.now = options.now ?? Date.now;
  }

  async callMany(context: ProxyContext, raw: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    const explicit = Array.isArray(raw.devices) ? raw.devices.map(publicDeviceRef) : undefined;
    const selector = isRecord(raw.selector) ? raw.selector as EdgeSelectionRequest : undefined;
    if ((explicit ? 1 : 0) + (selector ? 1 : 0) !== 1) {
      throw edgeError("EDGE_PROTOCOL", "Exactly one explicit device list or declarative selector is required.");
    }
    const tenantId = metadataString(context, "tenantId");
    const subjectId = context.subject?.id ?? context.user.id;
    if (!tenantId || !subjectId) throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Fan-out requires an authenticated tenant subject.");
    const requestedConcurrency = integer(raw.concurrency, this.limits.maxConcurrency, "concurrency");
    const requestedDeadlineMs = integer(raw.deadlineMs, this.limits.maxDeadlineMs, "deadlineMs");
    if (requestedConcurrency > this.limits.maxConcurrency) throw limitError("concurrency", this.limits.maxConcurrency);
    if (requestedDeadlineMs > this.limits.maxDeadlineMs) throw limitError("deadlineMs", this.limits.maxDeadlineMs);
    const failurePolicy = raw.failurePolicy === undefined ? "collect" : raw.failurePolicy;
    if (failurePolicy !== "collect" && failurePolicy !== "fail-fast") throw edgeError("EDGE_PROTOCOL", "failurePolicy must be collect or fail-fast.");
    let devices: readonly EdgePublicDeviceRef[];
    if (explicit) {
      if (explicit.length < 1 || explicit.length > this.limits.maxDevices) throw limitError("devices", this.limits.maxDevices);
      const unique = new Set(explicit.map((device) => device.name.normalize("NFKC").toLocaleLowerCase("en-US")));
      if (unique.size !== explicit.length) throw edgeError("EDGE_PROTOCOL", "Explicit devices must be unique.");
      devices = Object.freeze([...explicit]); // preserve caller order @pk
    } else {
      const boundedSelector = Object.freeze({ ...selector!, maxCandidates: Math.min(
        selector!.maxCandidates ?? this.limits.maxSelectorCandidates,
        this.limits.maxSelectorCandidates,
      ) });
      const selected = await this.options.inventory.selectMany({ tenantId, subjectId }, boundedSelector, this.limits.maxDevices);
      devices = Object.freeze([...selected.devices]
        .sort((left, right) => normalize(left.device.name).localeCompare(normalize(right.device.name)))
        .map((device) => device.device));
    }
    const deadline = Math.min(this.now() + requestedDeadlineMs, context.transport.deadline ?? Number.POSITIVE_INFINITY);
    const controller = new AbortController();
    const parentAbort = () => controller.abort(context.transport.signal?.reason);
    if (context.transport.signal?.aborted) parentAbort();
    else context.transport.signal?.addEventListener("abort", parentAbort, { once: true });
    const entries: EdgeFanoutEntry[] = devices.map((device) => Object.freeze({ device, status: "not-started" as const }));
    let cursor = 0;
    let stop = false;
    let aggregateBytes = 0;
    const runOne = async (index: number): Promise<void> => {
      const device = devices[index]!;
      if (stop || controller.signal.aborted || this.now() >= deadline) return;
      const childContext = Object.assign(Object.create(Object.getPrototypeOf(context)), context, {
        transport: { ...context.transport, deadline, signal: controller.signal },
      }) as ProxyContext;
      try {
        const result = await this.options.single.call(childContext, {
          device,
          tool: raw.tool,
          arguments: raw.arguments,
          deadlineMs: Math.max(1, deadline - this.now()),
        });
        const encoded = safeSize(result);
        if (encoded === undefined || encoded > this.limits.maxChildBytes || aggregateBytes + encoded > this.limits.maxAggregateBytes) {
          entries[index] = Object.freeze({
            device, status: "failed", retryable: false,
            error: { code: "EDGE_CAPACITY", message: "Child output exceeded an effective serialization limit." },
          });
        } else {
          aggregateBytes += encoded;
          const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
          entries[index] = Object.freeze({
            device,
            status: result.isError ? "failed" : "succeeded",
            ...(typeof structured?.correlationId === "string" ? { correlationId: structured.correlationId } : {}),
            result,
            ...(result.isError ? { retryable: false as const } : {}),
          });
        }
      } catch (error) {
        const code = isEdgeError(error) ? error.code : "EDGE_WORKLOAD";
        const indeterminate = code === "EDGE_UNAVAILABLE" || code === "EDGE_WORKLOAD";
        entries[index] = Object.freeze({
          device,
          status: controller.signal.aborted ? "cancelled" : "failed",
          retryable: false,
          error: { code, message: error instanceof Error ? error.message : "Edge child failed.", ...(indeterminate ? { outcome: "indeterminate" as const } : {}) },
        });
      }
      if (failurePolicy === "fail-fast" && entries[index]!.status !== "succeeded") {
        stop = true;
        controller.abort("fail-fast");
      }
    };
    const worker = async () => {
      while (!stop && !controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= devices.length) return;
        await runOne(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(requestedConcurrency, devices.length) }, worker));
    context.transport.signal?.removeEventListener("abort", parentAbort);
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index]!.status === "not-started" && context.transport.signal?.aborted) {
        entries[index] = Object.freeze({ device: devices[index]!, status: "cancelled", retryable: false });
      }
    }
    const counts = count(entries);
    const overall = counts.succeeded === devices.length ? "succeeded"
      : counts.succeeded > 0 ? "partial"
      : counts.cancelled === devices.length ? "cancelled" : "failed";
    const structured: EdgeFanoutResult = Object.freeze({
      status: overall,
      failurePolicy,
      resolvedDevices: devices.length,
      counts: Object.freeze(counts),
      results: Object.freeze(entries),
      warnings: Object.freeze([]),
      nextActions: Object.freeze(counts.failed > 0 ? ["Inspect failed entries; Fentaris does not automatically retry dispatched mutations."] : []),
    });
    return {
      isError: overall === "failed" || overall === "cancelled" ? true : undefined,
      structuredContent: structured as unknown as Record<string, unknown>,
      content: [{ type: "text", text: JSON.stringify(structured) }],
    };
  }
}

function count(entries: readonly EdgeFanoutEntry[]): Record<EdgeFanoutStatus, number> {
  const counts = { succeeded: 0, failed: 0, cancelled: 0, "not-started": 0 };
  for (const entry of entries) counts[entry.status] += 1;
  return counts;
}

function safeSize(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function validateLimits(limits: EdgeOrchestrationLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Edge orchestration limit ${name} must be a positive integer`);
  }
}

function limitError(field: string, limit: number): Error {
  return edgeError("EDGE_CAPACITY", `Requested ${field} exceeds the effective orchestration limit.`, { details: { field, limit } });
}

function integer(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw edgeError("EDGE_PROTOCOL", `${field} must be a positive integer.`);
  return value;
}

function publicDeviceRef(value: unknown): EdgePublicDeviceRef {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name
    || typeof value.inventoryVersion !== "number" || !Number.isSafeInteger(value.inventoryVersion)) {
    throw edgeError("EDGE_PROTOCOL", "Each device must contain a public name and inventoryVersion.");
  }
  return Object.freeze({ name: value.name, inventoryVersion: value.inventoryVersion });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataString(context: ProxyContext, key: string): string | undefined {
  const value = context.auth.metadata?.[key] ?? context.subject?.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
