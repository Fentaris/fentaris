import { describe, expect, it } from "vitest";
import {
  DefaultEdgeControlPlaneService,
  EDGE_INVENTORY_SCHEMA_VERSION,
  InMemoryEdgeChildBindingStore,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSessionSelectionStore,
  isEdgeError,
  normalizeEdgeDeviceName,
} from "../../src/index.js";
import type { EdgePresence } from "../../src/index.js";

const baseDevice = (tenantId: string, edgeNodeId: string, name: string) => ({
  tenantId,
  edgeNodeId,
  credentialId: `credential-${edgeNodeId}`,
  revoked: false,
  connectionGeneration: 0,
  inventorySchemaVersion: EDGE_INVENTORY_SCHEMA_VERSION,
  inventoryVersion: 1,
  user: { name, description: "developer machine", tags: ["development"], updatedAt: 10 },
  managed: { aliases: [], pools: ["workers"], updatedAt: 10 },
} as const);

describe("edge inventory registry conformance", () => {
  it("keeps metadata attribution and public references separate from credentials", async () => {
    const registry = new InMemoryEdgeDeviceRegistry();
    await registry.put({
      ...baseDevice("tenant-a", "node-1", "Mac Studio"),
      observed: {
        platform: "darwin",
        architecture: "arm64",
        agentVersion: "2.0.0",
        executionFeatures: ["filesystem"],
        reportedAt: 20,
      },
    });

    const page = await registry.list("tenant-a");
    expect(page.items[0]?.deviceRef).toEqual({ name: "Mac Studio", inventoryVersion: 1 });
    expect(page.items[0]?.user.tags).toEqual(["development"]);
    expect(page.items[0]?.observed?.platform).toBe("darwin");
    expect("credentialId" in (page.items[0] ?? {})).toBe(false);
  });

  it("normalizes names, rejects tenant-local collisions, and isolates tenants", async () => {
    const registry = new InMemoryEdgeDeviceRegistry();
    await registry.put(baseDevice("tenant-a", "node-1", "Mac  Studio"));
    expect(normalizeEdgeDeviceName("  MAC studio ")).toBe("mac studio");
    await expect(registry.put(baseDevice("tenant-a", "node-2", " mac studio ")))
      .rejects.toMatchObject({ code: "EDGE_NAME_CONFLICT" });
    await expect(registry.put(baseDevice("tenant-b", "node-2", "mac studio"))).resolves.toBeUndefined();
    expect((await registry.list("tenant-a")).items).toHaveLength(1);
    expect((await registry.list("tenant-b")).items).toHaveLength(1);
  });

  it("uses optimistic inventory versions and retains the previous name as an alias", async () => {
    const registry = new InMemoryEdgeDeviceRegistry();
    await registry.put(baseDevice("tenant-a", "node-1", "Laptop"));
    const updated = await registry.updateInventory("tenant-a", "node-1", {
      expectedInventoryVersion: 1,
      name: "Workstation",
      tags: ["xcode", "development", "xcode"],
      retainPreviousNameUntil: 1_000,
      updatedAt: 100,
    });
    expect(updated.inventoryVersion).toBe(2);
    expect(updated.user.tags).toEqual(["development", "xcode"]);
    expect(updated.managed.aliases[0]).toMatchObject({ name: "Laptop", normalizedName: "laptop", expiresAt: 1_000 });
    expect((await registry.getByName("tenant-a", "laptop", 999))?.edgeNodeId).toBe("node-1");
    expect(await registry.getByName("tenant-a", "laptop", 1_000)).toBeUndefined();
    await expect(registry.updateInventory("tenant-a", "node-1", {
      expectedInventoryVersion: 1,
      description: "stale write",
      updatedAt: 101,
    })).rejects.toMatchObject({ code: "EDGE_INVENTORY_CONFLICT" });
  });

  it("paginates stable credential-free results and filters tags and pools", async () => {
    const registry = new InMemoryEdgeDeviceRegistry();
    await registry.put(baseDevice("tenant-a", "node-1", "Alpha"));
    await registry.put(baseDevice("tenant-a", "node-2", "Beta"));
    const first = await registry.list("tenant-a", { limit: 1, tags: ["development"], pool: "workers" });
    const second = await registry.list("tenant-a", { limit: 1, cursor: first.nextCursor });
    expect(first.items.map((item) => item.user.name)).toEqual(["Alpha"]);
    expect(second.items.map((item) => item.user.name)).toEqual(["Beta"]);
  });

  it("revokes without deleting durable inventory", async () => {
    const registry = new InMemoryEdgeDeviceRegistry();
    await registry.put(baseDevice("tenant-a", "node-1", "Laptop"));
    await registry.revoke("tenant-a", "node-1");
    expect((await registry.get("tenant-a", "node-1"))?.revoked).toBe(true);
    expect((await registry.list("tenant-a", { revoked: true })).items).toHaveLength(1);
  });
});

describe("dynamic edge store conformance", () => {
  const presence = (lastHeartbeatAt = 100): EdgePresence => ({
    tenantId: "tenant-a",
    edgeNodeId: "node-1",
    credentialId: "credential-1",
    connectionId: "connection-1",
    connectionGeneration: 2,
    protocolVersion: 2,
    connectedAt: 50,
    heartbeat: { lastHeartbeatAt, staleAfterMs: 50, evaluatedAt: lastHeartbeatAt, fresh: true },
    status: "online",
    capacity: { maxConcurrent: 4, available: 3, reportedAt: lastHeartbeatAt },
    load: { active: 1, queued: 0, utilization: 0.25, reportedAt: lastHeartbeatAt },
  });

  it("expires heartbeats and rejects stale generations", async () => {
    const store = new InMemoryEdgePresenceStore();
    await store.put(presence());
    expect(await store.purgeStale(149)).toEqual([]);
    const stale = await store.purgeStale(150);
    expect(stale[0]?.status).toBe("stale");
    expect(stale[0]?.heartbeat.fresh).toBe(false);
    await expect(store.put({ ...presence(), connectionGeneration: 1 }))
      .rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
  });

  it("expires readiness, selections, and child bindings deterministically", async () => {
    const readiness = new InMemoryEdgeReadinessStore();
    await readiness.put({ tenantId: "tenant-a", edgeNodeId: "node-1", deploymentId: "fs", status: "ready", observedAt: 10, expiresAt: 20 });
    expect(await readiness.purgeExpired(20)).toHaveLength(1);

    const selections = new InMemoryEdgeSessionSelectionStore(() => 20);
    await selections.put({ sessionId: "s", subjectId: "u", targetName: "t", tenantId: "tenant-a", edgeNodeId: "node-1", inventoryVersion: 1, selectedAt: 10, expiresAt: 20 });
    expect(await selections.get("s", "u", "t")).toBeUndefined();

    const children = new InMemoryEdgeChildBindingStore(() => "child-1");
    const child = await children.allocate({ parentSessionId: "s", parentRequestId: "p", childRequestId: "c", tenantId: "tenant-a", subjectId: "u", targetName: "t", edgeNodeId: "node-1", connectionGeneration: 1, createdAt: 10, expiresAt: 20 });
    expect(child.childBindingId).toBe("child-1");
    expect(await children.purgeExpired(20)).toHaveLength(1);
  });

  it("warns when reference adapters are used for production", () => {
    const stores = [
      new InMemoryEdgeDeviceRegistry(),
      new InMemoryEdgePresenceStore(),
      new InMemoryEdgeReadinessStore(),
      new InMemoryEdgeSessionSelectionStore(),
      new InMemoryEdgeChildBindingStore(),
    ];
    for (const store of stores) {
      expect(store.diagnostics.productionReady).toBe(false);
      expect(store.diagnostics.warnings[0]).toContain("non-durable");
    }
  });
});

describe("edge control-plane management service", () => {
  it("returns safe machine views for join, update, list, disconnect, and revoke", async () => {
    const devices = new InMemoryEdgeDeviceRegistry();
    const connections = new InMemoryEdgeConnectionStore();
    const service = new DefaultEdgeControlPlaneService(devices, connections);
    const joined = await service.join({
      tenantId: "tenant-a",
      subjectId: "alice",
      edgeNodeId: "private-node-id",
      credentialId: "secret-credential-id",
      name: "Alice Laptop",
      tags: ["personal"],
      enrolledAt: 10,
    });
    expect(joined.data.device).toEqual({ name: "Alice Laptop", inventoryVersion: 1 });
    expect(JSON.stringify(joined)).not.toContain("secret-credential-id");
    expect(JSON.stringify(joined)).not.toContain("private-node-id");

    await connections.bind({ tenantId: "tenant-a", edgeNodeId: "private-node-id", connectionId: "c", connectionGeneration: 1, protocolVersion: 1, connectedAt: 20, lastHeartbeatAt: 20 });
    expect((await service.get({ tenantId: "tenant-a", subjectId: "alice" }, "alice laptop")).data.connected).toBe(true);
    expect((await service.list({ tenantId: "tenant-a", subjectId: "alice" })).data).toHaveLength(1);
    expect((await service.disconnect({ tenantId: "tenant-a", subjectId: "alice" }, "Alice Laptop")).data.connected).toBe(false);
    expect((await service.revoke({ tenantId: "tenant-a", subjectId: "alice" }, "Alice Laptop")).data.revoked).toBe(true);
  });

  it("uses non-enumerating errors for cross-subject management", async () => {
    const service = new DefaultEdgeControlPlaneService(new InMemoryEdgeDeviceRegistry(), new InMemoryEdgeConnectionStore());
    await service.join({ tenantId: "tenant-a", subjectId: "alice", edgeNodeId: "node-1", credentialId: "credential-1", name: "Laptop", enrolledAt: 10 });
    try {
      await service.get({ tenantId: "tenant-a", subjectId: "bob" }, "Laptop");
      throw new Error("expected get to fail");
    } catch (error) {
      expect(isEdgeError(error) && error.code).toBe("EDGE_UNAUTHORIZED_TARGET");
      expect((error as Error).message).not.toContain("Laptop");
    }
  });
});
