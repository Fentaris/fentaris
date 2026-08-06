import { describe, expect, it } from "vitest";
import {
  EDGE_CONTROL_TOOL_NAMES,
  EdgeInventoryService,
  EdgeSessionSelectionService,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSessionSelectionStore,
  InMemorySessionBindingStore,
  McpProxy,
  Policy,
  type EdgePresence,
} from "../../src/index.js";

const now = 2_000;

async function fixture(policy = Policy.allowAll()) {
  const devices = new InMemoryEdgeDeviceRegistry();
  const presence = new InMemoryEdgePresenceStore();
  const readiness = new InMemoryEdgeReadinessStore();
  const bindings = new InMemorySessionBindingStore();
  const selectionStore = new InMemoryEdgeSessionSelectionStore(() => now);
  await devices.put({
    tenantId: "tenant-a", edgeNodeId: "node-a", credentialId: "credential-secret", subjectId: "alice",
    revoked: false, connectionGeneration: 1, inventoryVersion: 1,
    user: { name: "Alice Studio", description: "Desk computer", tags: ["xcode"], updatedAt: now },
    observed: { platform: "darwin", architecture: "arm64", agentVersion: "1.0.0", executionFeatures: ["filesystem"], reportedAt: now },
    managed: { aliases: [], pools: ["workers"], updatedAt: now },
  });
  const dynamic: EdgePresence = {
    tenantId: "tenant-a", edgeNodeId: "node-a", credentialId: "credential-secret", connectionId: "connection-a",
    connectionGeneration: 1, protocolVersion: 2, connectedAt: now,
    heartbeat: { lastHeartbeatAt: now, staleAfterMs: 1_000, evaluatedAt: now, fresh: true }, status: "online",
    capacity: { maxConcurrent: 2, available: 1, reportedAt: now },
    load: { active: 0, queued: 0, utilization: 0.1, reportedAt: now },
  };
  await presence.put(dynamic);
  await readiness.put({
    tenantId: "tenant-a", edgeNodeId: "node-a", deploymentId: "filesystem", status: "ready", observedAt: now,
  });
  const inventory = new EdgeInventoryService({
    devices, presence, readiness, now: () => now,
    authorizer: {
      canAccessDevice: (context, device) => context.subjectId === device.subjectId,
      canAccessDeployment: () => true,
    },
  });
  const selections = new EdgeSessionSelectionService({
    selections: selectionStore, bindings, inventory, now: () => now,
  });
  const proxy = new McpProxy({
    policy,
    edge: { control: { enabled: true, inventory, selections, defaultTargetName: "personal" }, sessionSelectionStore: selectionStore },
  });
  const identity = { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-a", sessionId: "session-a" } };
  return { proxy, identity, selectionStore };
}

describe("Edge Control provider", () => {
  it("is opt-in, reserves its namespace, and publishes exactly five stable tools", async () => {
    await expect(new McpProxy().listTools()).resolves.toEqual({ tools: [] });
    expect(() => new McpProxy().local("edge")).toThrow(/reserved/i);
    const { proxy, identity } = await fixture();
    const listed = await proxy.listTools(undefined, { id: "alice" }, identity);
    expect(listed.tools.map((tool) => tool.name)).toEqual(EDGE_CONTROL_TOOL_NAMES.map((name) => `edge__${name}`));
    expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(listed.tools).toHaveLength(5);
  });

  it("returns compact bounded list results with safe pagination metadata", async () => {
    const { proxy, identity } = await fixture();
    const response = await proxy.callTool({ name: "edge__list", arguments: { tags: ["xcode"], limit: 1 } }, { id: "alice" }, identity);
    expect(response.structuredContent).toMatchObject({
      devices: [{ device: { name: "Alice Studio", inventoryVersion: 1 }, status: "online", heartbeatFresh: true }],
      warnings: [],
      nextActions: [],
    });
    expect(response.structuredContent).not.toHaveProperty("devices.0.description");
    expect(JSON.stringify(response)).not.toContain("credential-secret");
    expect(JSON.stringify(response)).not.toContain("node-a");
  });

  it("returns attributed detail fields only when requested", async () => {
    const { proxy, identity } = await fixture();
    const response = await proxy.callTool({
      name: "edge__get", arguments: { name: "Alice Studio", include: ["description", "tags", "observed", "pools", "readiness"] },
    }, { id: "alice" }, identity);
    expect(response.structuredContent).toMatchObject({
      device: {
        description: "Desk computer", tags: ["xcode"], platform: "darwin", pools: ["workers"],
        metadata: { user: ["description", "tags"], agent: ["platform", "executionFeatures"], controlPlane: ["pools"] },
        readiness: [{ deploymentId: "filesystem", status: "ready" }],
      },
    });
  });

  it("selects by declarative requirements and persists a pre-pin public choice", async () => {
    const { proxy, identity, selectionStore } = await fixture();
    const response = await proxy.callTool({
      name: "edge__select",
      arguments: { target: "personal", selector: { requires: { tags: ["xcode"], deploymentId: "filesystem" }, prefer: ["lowest-load"] } },
    }, { id: "alice" }, identity);
    expect(response.structuredContent).toMatchObject({
      target: "personal", device: { name: "Alice Studio", inventoryVersion: 1 },
      explanation: { satisfiedRequirements: ["tags", "deploymentId"], appliedPreferences: ["lowest-load"] },
    });
    await expect(selectionStore.get("session-a", "alice", "personal")).resolves.toMatchObject({ edgeNodeId: "node-a" });
  });

  it("uses normal policy visibility for individual control tools", async () => {
    const policy = new Policy({ name: "edge-list-only" }).mcp("edge").allow("list");
    const { proxy, identity } = await fixture(policy);
    const listed = await proxy.listTools(undefined, { id: "alice" }, identity);
    expect(listed.tools.map((tool) => tool.name)).toEqual(["edge__list"]);
    const denied = await proxy.callTool({ name: "edge__get", arguments: { name: "Alice Studio" } }, { id: "alice" }, identity);
    expect(denied.isError).toBe(true);
  });

  it("returns the same non-enumerating error shape for hidden and missing devices", async () => {
    const { proxy, identity } = await fixture();
    const capture = async (name: string) => proxy.callTool({ name: "edge__get", arguments: { name } }, { id: "bob" }, {
      ...identity, userId: "bob",
    });
    const hidden = await capture("Alice Studio");
    const missing = await capture("Missing Device");
    expect(hidden).toEqual(missing);
  });
});
