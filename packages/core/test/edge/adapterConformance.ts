import { describe, expect, it } from "vitest";
import type {
  EdgeChildBindingStore,
  EdgeChannelBroker,
  EdgeDeviceRegistry,
  EdgePresence,
  EdgePresenceStore,
  EdgeReadinessStore,
  EdgeSessionSelectionStore,
  SessionBindingStore,
} from "../../src/index.js";

/** Reusable conformance suite for durable inventory registries. @pk */
export function inventoryAdapterConformance(name: string, create: () => EdgeDeviceRegistry): void {
  describe(`${name} inventory adapter conformance`, () => {
    it("isolates tenants and enforces optimistic inventory versions", async () => {
      const store = create();
      const device = (tenantId: string) => ({
        tenantId, edgeNodeId: "node", credentialId: "credential", revoked: false, connectionGeneration: 0,
        inventoryVersion: 1,
        user: { name: "Laptop", tags: [], updatedAt: 1 }, managed: { aliases: [], pools: [], updatedAt: 1 },
      });
      await store.put(device("tenant-a"));
      await store.put(device("tenant-b"));
      expect((await store.list("tenant-a")).items).toHaveLength(1);
      await store.updateInventory("tenant-a", "node", { expectedInventoryVersion: 1, description: "new", updatedAt: 2 });
      await expect(store.updateInventory("tenant-a", "node", { expectedInventoryVersion: 1, description: "stale", updatedAt: 3 }))
        .rejects.toMatchObject({ code: "EDGE_INVENTORY_CONFLICT" });
    });
  });
}

/** Reusable conformance suite for managed presence adapters. @pk */
export function presenceAdapterConformance(name: string, create: () => EdgePresenceStore): void {
  describe(`${name} presence adapter conformance`, () => {
    it("isolates tenants, rejects stale generations, and expires heartbeat state", async () => {
      const store = create();
      const value = presence("tenant-a", 2);
      await store.put(value);
      await store.put(presence("tenant-b", 1));
      expect((await store.get("tenant-a", "node"))?.connectionGeneration).toBe(2);
      await expect(store.put(presence("tenant-a", 1))).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });
      expect(await store.purgeStale(20)).toHaveLength(2);
    });
  });
}

/** Reusable conformance suite for managed readiness adapters. @pk */
export function readinessAdapterConformance(name: string, create: () => EdgeReadinessStore): void {
  describe(`${name} readiness adapter conformance`, () => {
    it("persists tenant/device/deployment keys and expires deterministically", async () => {
      const store = create();
      await store.put({ tenantId: "tenant-a", edgeNodeId: "node", deploymentId: "files", status: "ready", observedAt: 1, expiresAt: 2 });
      expect(await store.get("tenant-a", "node", "files")).toMatchObject({ status: "ready" });
      expect(await store.get("tenant-b", "node", "files")).toBeUndefined();
      expect(await store.purgeExpired(2)).toHaveLength(1);
    });
  });
}

/** Reusable conformance suite for durable session-selection adapters. @pk */
export function selectionAdapterConformance(name: string, create: () => EdgeSessionSelectionStore): void {
  describe(`${name} selection adapter conformance`, () => {
    it("keys by session, subject, target and cleans a complete session", async () => {
      const store = create();
      await store.put({ sessionId: "session", subjectId: "alice", targetName: "one", tenantId: "tenant", edgeNodeId: "a", inventoryVersion: 1, selectedAt: 1, expiresAt: 100 });
      await store.put({ sessionId: "session", subjectId: "alice", targetName: "two", tenantId: "tenant", edgeNodeId: "b", inventoryVersion: 1, selectedAt: 1, expiresAt: 100 });
      expect(await store.get("session", "alice", "one")).toMatchObject({ edgeNodeId: "a" });
      expect(await store.deleteSession("session")).toHaveLength(2);
    });
  });
}

/** Reusable conformance suite for isolated child-binding adapters. @pk */
export function childBindingAdapterConformance(name: string, create: () => EdgeChildBindingStore): void {
  describe(`${name} child binding adapter conformance`, () => {
    it("isolates siblings and atomically removes a parent request", async () => {
      const store = create();
      const base = { parentSessionId: "session", parentRequestId: "parent", tenantId: "tenant", subjectId: "alice", targetName: "edge", connectionGeneration: 1, createdAt: 1, expiresAt: 100 };
      const a = await store.allocate({ ...base, childRequestId: "a", edgeNodeId: "a" });
      const b = await store.allocate({ ...base, childRequestId: "b", edgeNodeId: "b" });
      expect(a.childBindingId).not.toBe(b.childBindingId);
      expect(await store.deleteParent("session", "parent")).toHaveLength(2);
    });
  });
}

/** Reusable conformance suite for transparent session-binding adapters. @pk */
export function sessionBindingAdapterConformance(name: string, create: () => SessionBindingStore): void {
  describe(`${name} session binding adapter conformance`, () => {
    it("prevents device takeover and releases an entire session", async () => {
      const store = create();
      const key = { sessionId: "session", subjectId: "alice", targetName: "target" };
      await store.store(key, { ...key, edgeNodeId: "node-a", connectionGeneration: 1 });
      await expect(store.store(key, { ...key, edgeNodeId: "node-b", connectionGeneration: 1 }))
        .rejects.toMatchObject({ code: "EDGE_UNAVAILABLE" });
      expect(await store.deleteSession("session")).toHaveLength(1);
    });
  });
}

/** Reusable conformance suite for distributed channel brokers. @pk */
export function channelBrokerAdapterConformance(name: string, create: () => EdgeChannelBroker): void {
  describe(`${name} channel broker adapter conformance`, () => {
    it("routes only matching channels and unsubscribes deterministically", async () => {
      const broker = create();
      const received: string[] = [];
      const unsubscribe = broker.subscribe("tenant/device", (message) => received.push(message));
      await broker.publish("other", "hidden");
      await broker.publish("tenant/device", "one");
      unsubscribe();
      await broker.publish("tenant/device", "two");
      expect(received).toEqual(["one"]);
    });
  });
}

function presence(tenantId: string, connectionGeneration: number): EdgePresence {
  return {
    tenantId, edgeNodeId: "node", credentialId: "credential", connectionId: `${tenantId}-${connectionGeneration}`,
    connectionGeneration, protocolVersion: 2, connectedAt: 1,
    heartbeat: { lastHeartbeatAt: 10, staleAfterMs: 10, evaluatedAt: 10, fresh: true }, status: "online",
  };
}
