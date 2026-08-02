import { describe, expect, it } from "vitest";
import {
  EdgeFanoutCoordinator,
  edgeError,
  type EdgeInventoryService,
  type EdgeSingleCallCoordinator,
  type ProxyContext,
} from "../../src/index.js";

const devices = ["Charlie", "Alice", "Bob"].map((name, index) => ({ name, inventoryVersion: index + 1 }));

function context(signal?: AbortSignal): ProxyContext {
  return {
    user: { id: "alice" },
    subject: { id: "alice", metadata: {} },
    identity: { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-a", sessionId: "parent" } },
    auth: { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-a", sessionId: "parent" } },
    transport: { sessionId: "parent", signal },
    policy: { matchedGroups: [], matchedPermissions: [], can: () => true },
  } as unknown as ProxyContext;
}

function inventory(): EdgeInventoryService {
  return {
    selectMany: async () => ({
      devices: devices.map((device) => ({
        device, tags: [], executionFeatures: [], pools: [], status: "online", heartbeatFresh: true,
        readiness: [], warnings: [],
      })),
      explanation: { satisfiedRequirements: [], appliedPreferences: [], strategy: "name", evaluatedCandidates: 3, inventoryVersion: 3, evaluatedAt: 1 },
    }),
  } as unknown as EdgeInventoryService;
}

function single(call: EdgeSingleCallCoordinator["call"]): EdgeSingleCallCoordinator {
  return { call } as unknown as EdgeSingleCallCoordinator;
}

describe("EdgeFanoutCoordinator", () => {
  it("preserves explicit order and enforces bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const coordinator = new EdgeFanoutCoordinator({
      inventory: inventory(),
      single: single(async (_ctx, raw) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        const device = raw.device as { name: string };
        return { content: [{ type: "text", text: device.name }], structuredContent: { correlationId: `c-${device.name}` } };
      }),
    });
    const response = await coordinator.callMany(context(), {
      devices, tool: "files__read", arguments: {}, concurrency: 2, failurePolicy: "collect",
    });
    const result = response.structuredContent as unknown as { counts: Record<string, number>; results: Array<{ device: { name: string }; status: string }> };
    expect(peak).toBe(2);
    expect(result.results.map((entry) => entry.device.name)).toEqual(["Charlie", "Alice", "Bob"]);
    expect(result.results.map((entry) => entry.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(result.counts).toEqual({ succeeded: 3, failed: 0, cancelled: 0, "not-started": 0 });
  });

  it("sorts declarative results deterministically and collects partial failures", async () => {
    const coordinator = new EdgeFanoutCoordinator({
      inventory: inventory(),
      single: single(async (_ctx, raw) => {
        const name = (raw.device as { name: string }).name;
        return name === "Bob"
          ? { isError: true, content: [{ type: "text", text: "setup required" }] }
          : { content: [{ type: "text", text: name }] };
      }),
    });
    const response = await coordinator.callMany(context(), {
      selector: { requires: { tags: ["worker"] } }, tool: "files__read", arguments: {}, failurePolicy: "collect",
    });
    const result = response.structuredContent as unknown as { status: string; counts: Record<string, number>; results: Array<{ device: { name: string }; status: string }> };
    expect(result.results.map((entry) => entry.device.name)).toEqual(["Alice", "Bob", "Charlie"]);
    expect(result.results.map((entry) => entry.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(result.status).toBe("partial");
    expect(result.counts.failed).toBe(1);
  });

  it("stops scheduling in fail-fast mode and distinguishes not-started entries", async () => {
    let calls = 0;
    const coordinator = new EdgeFanoutCoordinator({
      inventory: inventory(),
      single: single(async () => {
        calls += 1;
        return { isError: true, content: [{ type: "text", text: "denied" }] };
      }),
    });
    const response = await coordinator.callMany(context(), {
      devices, tool: "files__write", arguments: {}, concurrency: 1, failurePolicy: "fail-fast",
    });
    const result = response.structuredContent as unknown as { counts: Record<string, number>; results: Array<{ status: string }> };
    expect(calls).toBe(1);
    expect(result.results.map((entry) => entry.status)).toEqual(["failed", "not-started", "not-started"]);
    expect(result.counts).toEqual({ succeeded: 0, failed: 1, cancelled: 0, "not-started": 2 });
  });

  it("links parent cancellation and returns one terminal entry per resolved device", async () => {
    const controller = new AbortController();
    controller.abort("parent");
    const coordinator = new EdgeFanoutCoordinator({
      inventory: inventory(),
      single: single(async () => { throw new Error("must not start"); }),
    });
    const response = await coordinator.callMany(context(controller.signal), {
      devices, tool: "files__read", arguments: {}, concurrency: 2,
    });
    const result = response.structuredContent as unknown as { status: string; counts: Record<string, number>; results: Array<{ status: string }> };
    expect(result.status).toBe("cancelled");
    expect(result.results).toHaveLength(3);
    expect(result.counts.cancelled).toBe(3);
  });

  it("reports disconnects as indeterminate and never retries", async () => {
    let calls = 0;
    const coordinator = new EdgeFanoutCoordinator({
      inventory: inventory(),
      single: single(async () => {
        calls += 1;
        throw edgeError("EDGE_UNAVAILABLE", "Connection lost after dispatch.");
      }),
    });
    const response = await coordinator.callMany(context(), {
      devices: [devices[0]], tool: "files__write", arguments: {}, concurrency: 1,
    });
    const result = response.structuredContent as unknown as { results: Array<{ status: string; retryable: boolean; error: { outcome: string } }> };
    expect(calls).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "failed", retryable: false, error: { outcome: "indeterminate" } });
  });

  it("contains oversized and non-serializable children while preserving siblings", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const coordinator = new EdgeFanoutCoordinator({
      inventory: inventory(),
      limits: { maxChildBytes: 100, maxAggregateBytes: 150 },
      single: single(async (_ctx, raw) => {
        const name = (raw.device as { name: string }).name;
        if (name === "Charlie") return { content: [{ type: "text", text: "x".repeat(200) }] };
        if (name === "Alice") return { content: [{ type: "text", text: "bad" }], structuredContent: circular };
        return { content: [{ type: "text", text: "ok" }] };
      }),
    });
    const response = await coordinator.callMany(context(), { devices, tool: "files__read", arguments: {}, concurrency: 1 });
    const result = response.structuredContent as unknown as { counts: Record<string, number>; results: Array<{ status: string; error?: { code: string } }> };
    expect(result.results.map((entry) => entry.status)).toEqual(["failed", "failed", "succeeded"]);
    expect(result.results[0].error?.code).toBe("EDGE_CAPACITY");
    expect(result.counts).toMatchObject({ failed: 2, succeeded: 1 });
  });

  it("rejects widening, ambiguous selectors, and effective-limit violations before dispatch", async () => {
    let calls = 0;
    const coordinator = new EdgeFanoutCoordinator({
      inventory: inventory(),
      limits: { maxDevices: 2, maxConcurrency: 1, maxDeadlineMs: 100 },
      single: single(async () => { calls += 1; return { content: [] }; }),
    });
    await expect(coordinator.callMany(context(), { devices: devices.slice(0, 1), selector: {}, tool: "files__read", arguments: {} }))
      .rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
    await expect(coordinator.callMany(context(), { devices, tool: "files__read", arguments: {} }))
      .rejects.toMatchObject({ code: "EDGE_CAPACITY" });
    await expect(coordinator.callMany(context(), { devices: devices.slice(0, 1), tool: "files__read", arguments: {}, concurrency: 2 }))
      .rejects.toMatchObject({ code: "EDGE_CAPACITY" });
    expect(calls).toBe(0);
  });
});
