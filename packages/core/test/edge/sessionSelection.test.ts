import { describe, expect, it } from "vitest";
import {
  EdgeChildBindingManager,
  EdgeInventoryService,
  EdgeSessionPinner,
  EdgeSessionSelectionService,
  InMemoryEdgeChildBindingStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSessionSelectionStore,
  InMemorySessionBindingStore,
  edge,
  type DeviceResolver,
  type EdgePresence,
} from "../../src/index.js";

const now = 1_000;

async function inventoryFixture() {
  const devices = new InMemoryEdgeDeviceRegistry();
  const presence = new InMemoryEdgePresenceStore();
  const readiness = new InMemoryEdgeReadinessStore();
  await devices.put({
    tenantId: "tenant-a",
    edgeNodeId: "node-a",
    credentialId: "secret-credential",
    subjectId: "alice",
    revoked: false,
    connectionGeneration: 2,
    inventoryVersion: 1,
    user: { name: "Alice Laptop", tags: ["development"], updatedAt: now },
    managed: { aliases: [], pools: [], updatedAt: now },
  });
  const dynamic: EdgePresence = {
    tenantId: "tenant-a",
    edgeNodeId: "node-a",
    credentialId: "secret-credential",
    connectionId: "connection-a",
    connectionGeneration: 2,
    protocolVersion: 2,
    connectedAt: now,
    heartbeat: { lastHeartbeatAt: now, staleAfterMs: 1_000, evaluatedAt: now, fresh: true },
    status: "online",
    capacity: { maxConcurrent: 2, available: 1, reportedAt: now },
  };
  await presence.put(dynamic);
  const inventory = new EdgeInventoryService({
    devices,
    presence,
    readiness,
    now: () => now,
    authorizer: {
      canAccessDevice: (context, device) => context.subjectId === device.subjectId,
      canAccessDeployment: () => true,
    },
  });
  return { devices, inventory, presence };
}

describe("Edge session selection", () => {
  it("validates and stores an authorized pre-pin selection", async () => {
    const { inventory } = await inventoryFixture();
    const selections = new InMemoryEdgeSessionSelectionStore(() => now);
    const service = new EdgeSessionSelectionService({
      selections,
      bindings: new InMemorySessionBindingStore(),
      inventory,
      now: () => now,
    });
    const selected = await service.select({
      sessionId: "session-a",
      subjectId: "alice",
      tenantId: "tenant-a",
      targetName: "personal",
      device: { name: "Alice Laptop", inventoryVersion: 1 },
    });
    expect(selected).toMatchObject({ edgeNodeId: "node-a", inventoryVersion: 1, expiresAt: now + 15 * 60_000 });
  });

  it("rejects unauthorized and stale public selections without enumeration", async () => {
    const { inventory, devices } = await inventoryFixture();
    const service = new EdgeSessionSelectionService({
      selections: new InMemoryEdgeSessionSelectionStore(() => now),
      bindings: new InMemorySessionBindingStore(),
      inventory,
      now: () => now,
    });
    await expect(service.select({
      sessionId: "session-bob", subjectId: "bob", tenantId: "tenant-a", targetName: "personal",
      device: { name: "Alice Laptop", inventoryVersion: 1 },
    })).rejects.toMatchObject({ code: "EDGE_UNAUTHORIZED_TARGET" });
    await devices.updateInventory("tenant-a", "node-a", {
      expectedInventoryVersion: 1, description: "changed", updatedAt: now + 1,
    });
    await expect(service.select({
      sessionId: "session-a", subjectId: "alice", tenantId: "tenant-a", targetName: "personal",
      device: { name: "Alice Laptop", inventoryVersion: 1 },
    })).rejects.toMatchObject({ code: "EDGE_INVENTORY_CONFLICT" });
  });

  it("feeds a pre-pin selection into pinning and makes the resulting pin immutable", async () => {
    const { inventory } = await inventoryFixture();
    const selections = new InMemoryEdgeSessionSelectionStore(() => now);
    const bindings = new InMemorySessionBindingStore();
    const service = new EdgeSessionSelectionService({ selections, bindings, inventory, now: () => now });
    await service.select({
      sessionId: "session-a", subjectId: "alice", tenantId: "tenant-a", targetName: "personal",
      device: { name: "Alice Laptop", inventoryVersion: 1 },
    });
    let selectedCalls = 0;
    const resolver: DeviceResolver = {
      resolveSelectedDevice: async (node, version) => {
        selectedCalls += 1;
        expect([node, version]).toEqual(["node-a", 1]);
        return { edgeNodeId: node, alias: "Alice Laptop" };
      },
      resolveNamedAlias: async () => null,
      resolvePool: async () => null,
      resolveUserDefaultDevice: async () => ({ edgeNodeId: "fallback" }),
    };
    const pinner = new EdgeSessionPinner({
      targets: new Map([["personal", edge({ device: edge.userDefaultDevice() })]]),
      bindings: [{ serverName: "files", scope: "global", targetName: "personal" }],
      deviceResolver: resolver,
      store: bindings,
      selectionStore: selections,
    });
    const first = await pinner.pin({ sessionId: "session-a", subjectId: "alice", tenantId: "tenant-a", serverName: "files", groupIds: [] });
    const second = await pinner.pin({ sessionId: "session-a", subjectId: "alice", tenantId: "tenant-a", serverName: "files", groupIds: [] });
    expect(first.kind === "edge" && first.device.edgeNodeId).toBe("node-a");
    expect(second.kind === "edge" && second.reused).toBe(true);
    expect(selectedCalls).toBe(1);
    await expect(service.select({
      sessionId: "session-a", subjectId: "alice", tenantId: "tenant-a", targetName: "personal",
      device: { name: "Alice Laptop", inventoryVersion: 1 },
    })).rejects.toMatchObject({ code: "EDGE_SESSION_PINNED" });
    await expect(pinner.reconnect({ sessionId: "session-a", subjectId: "alice", targetName: "personal" }, "node-a", 3))
      .resolves.toMatchObject({ connectionGeneration: 3 });
  });

  it("uses typed declarative selection only when explicitly supplied", async () => {
    let declarativeCalls = 0;
    let defaultCalls = 0;
    const resolver: DeviceResolver = {
      resolveDeclarativeDevice: async (selection) => {
        declarativeCalls += 1;
        expect(selection).toEqual({ requires: { tags: ["gpu"] }, prefer: ["lowest-load"] });
        return {
          edgeNodeId: "node-gpu",
          selection: {
            satisfiedRequirements: ["tags"], appliedPreferences: ["lowest-load"], strategy: "name",
            evaluatedCandidates: 2, inventoryVersion: 4, evaluatedAt: now,
          },
        };
      },
      resolveUserDefaultDevice: async () => { defaultCalls += 1; return { edgeNodeId: "node-default" }; },
      resolveNamedAlias: async () => null,
      resolvePool: async () => null,
    };
    const create = () => new EdgeSessionPinner({
      targets: new Map([["personal", edge({ device: edge.userDefaultDevice() })]]),
      bindings: [{ serverName: "files", scope: "global", targetName: "personal" }],
      deviceResolver: resolver,
    });
    const selected = await create().pin({
      sessionId: "declarative", subjectId: "alice", serverName: "files", groupIds: [],
      deviceSelection: { requires: { tags: ["gpu"] }, prefer: ["lowest-load"] },
    });
    const unchanged = await create().pin({ sessionId: "default", subjectId: "alice", serverName: "files", groupIds: [] });
    expect(selected.kind === "edge" && selected.device.selection?.inventoryVersion).toBe(4);
    expect(unchanged.kind === "edge" && unchanged.device.edgeNodeId).toBe("node-default");
    expect([declarativeCalls, defaultCalls]).toEqual([1, 1]);
  });
});

describe("EdgeChildBindingManager", () => {
  it("isolates siblings and cleans them without mutating the parent pin", async () => {
    const store = new InMemoryEdgeChildBindingStore();
    const parentStore = new InMemorySessionBindingStore();
    await parentStore.store({ sessionId: "parent", subjectId: "alice", targetName: "personal" }, {
      sessionId: "parent", subjectId: "alice", targetName: "personal", edgeNodeId: "parent-node", connectionGeneration: 1,
    });
    const cleanup: string[] = [];
    const manager = new EdgeChildBindingManager({ store, now: () => now, cleanup: { cleanup: (binding, reason) => cleanup.push(`${binding.childRequestId}:${reason}`) } });
    const base = {
      parentSessionId: "parent", parentRequestId: "request", tenantId: "tenant-a", subjectId: "alice",
      targetName: "personal", edgeNodeId: "node-a", connectionGeneration: 2, ttlMs: 100,
    };
    const first = await manager.allocate({ ...base, childRequestId: "child-a" });
    const second = await manager.allocate({ ...base, childRequestId: "child-b", edgeNodeId: "node-b" });
    await manager.cancel(first.binding.childBindingId);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(await manager.get(second.binding.childBindingId)).toMatchObject({ edgeNodeId: "node-b" });
    await manager.endParent("parent", "request");
    expect(second.signal.aborted).toBe(true);
    expect(cleanup).toEqual(["child-a:cancelled", "child-b:parent-end"]);
    expect(await parentStore.get({ sessionId: "parent", subjectId: "alice", targetName: "personal" }))
      .toMatchObject({ edgeNodeId: "parent-node" });
  });

  it("expires one child independently", async () => {
    let clock = now;
    const manager = new EdgeChildBindingManager({ store: new InMemoryEdgeChildBindingStore(), now: () => clock });
    const allocated = await manager.allocate({
      parentSessionId: "parent", parentRequestId: "request", childRequestId: "child", tenantId: "tenant-a",
      subjectId: "alice", targetName: "personal", edgeNodeId: "node-a", connectionGeneration: 2, ttlMs: 10,
    });
    clock += 11;
    await expect(manager.purgeExpired()).resolves.toHaveLength(1);
    expect(allocated.signal.aborted).toBe(true);
  });
});
