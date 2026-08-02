import { describe, expect, it } from "vitest";
import {
  EDGE_PROTOCOL_VERSION,
  parseEdgeProtocolMessage,
  selectHighestMutualEdgeProtocolVersion,
} from "../../src/index.js";

const presence = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  kind: "edge.presence",
  tenantId: "tenant-1",
  edgeNodeId: "node-1",
  connectionGeneration: 3,
  observed: {
    platform: "darwin",
    architecture: "arm64",
    agentVersion: "0.1.0",
    executionFeatures: ["mcp-stdio", "filesystem"],
    reportedAt: 100,
  },
  capacity: { maxConcurrent: 4, available: 3, reportedAt: 100 },
  load: { active: 1, queued: 0, utilization: 0.25, reportedAt: 100 },
  readiness: [{ deploymentId: "filesystem", status: "ready", observedAt: 100 }],
  reportedAt: 100,
  ...overrides,
});

describe("Edge protocol v2", () => {
  it("negotiates the highest mutual version and retains v1 compatibility", () => {
    expect(EDGE_PROTOCOL_VERSION).toBe(2);
    expect(selectHighestMutualEdgeProtocolVersion([1, 2])).toBe(2);
    expect(selectHighestMutualEdgeProtocolVersion([1])).toBe(1);
    expect(selectHighestMutualEdgeProtocolVersion([99])).toBeUndefined();
    expect(parseEdgeProtocolMessage(JSON.stringify({
      version: 1,
      kind: "edge.heartbeat",
      tenantId: "tenant-1",
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      sentAt: 10,
      load: 0.5,
    }))).toMatchObject({ version: 1, kind: "edge.heartbeat" });
  });

  it("accepts bounded observed facts, capacity, load, readiness, and child correlation", () => {
    expect(parseEdgeProtocolMessage(JSON.stringify(presence()))).toMatchObject({
      version: 2,
      kind: "edge.presence",
      observed: { platform: "darwin" },
    });
    expect(parseEdgeProtocolMessage(JSON.stringify({
      version: 1,
      kind: "mcp.result",
      requestId: "child-1",
      operation: "tools/call",
      route: {
        edgeNodeId: "node-1",
        connectionGeneration: 1,
        deploymentId: "filesystem",
        downstreamSessionId: "child-session",
        targetName: "workers",
        parentRequestId: "parent-1",
        childBindingId: "binding-1",
        orchestrationId: "orchestration-1",
      },
      result: { content: [] },
    }))).toMatchObject({ kind: "mcp.result", route: { childBindingId: "binding-1" } });
  });

  it("rejects malformed, oversized, or version-incompatible v2 fields", () => {
    expect(() => parseEdgeProtocolMessage(JSON.stringify(presence({
      observed: { ...presence().observed, executionFeatures: Array.from({ length: 65 }, (_, index) => `f${index}`) },
    })))).toThrow(/too many/);
    expect(() => parseEdgeProtocolMessage(JSON.stringify(presence({
      capacity: { maxConcurrent: 2, available: 3, reportedAt: 100 },
    })))).toThrow(/non-negative safe integer/);
    expect(() => parseEdgeProtocolMessage(JSON.stringify({ ...presence(), version: 1 }))).toThrow(/requires protocol version 2/);
    expect(() => parseEdgeProtocolMessage(JSON.stringify(presence({
      load: { active: 1, queued: 0, utilization: 2, reportedAt: 100 },
    })))).toThrow(/between 0 and 1/);
  });
});
