import { describe, expect, it } from "vitest";
import {
  EDGE_DISTRIBUTED_CONSISTENCY_REQUIREMENTS,
  InMemoryEdgeChannelBroker,
  InMemoryEdgeChildBindingStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePoolSelectionStore,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeResultCorrelationStore,
  InMemoryEdgeSessionSelectionStore,
  InMemorySessionBindingStore,
  diagnoseEdgeProductionAdapters,
  type EdgeResultCorrelationStore,
} from "../../src/index.js";
import {
  channelBrokerAdapterConformance,
  childBindingAdapterConformance,
  inventoryAdapterConformance,
  presenceAdapterConformance,
  readinessAdapterConformance,
  selectionAdapterConformance,
  sessionBindingAdapterConformance,
} from "./adapterConformance.js";

inventoryAdapterConformance("in-memory", () => new InMemoryEdgeDeviceRegistry());
presenceAdapterConformance("in-memory", () => new InMemoryEdgePresenceStore());
readinessAdapterConformance("in-memory", () => new InMemoryEdgeReadinessStore());
selectionAdapterConformance("in-memory", () => new InMemoryEdgeSessionSelectionStore(() => 0));
childBindingAdapterConformance("in-memory", () => new InMemoryEdgeChildBindingStore());
sessionBindingAdapterConformance("in-memory", () => new InMemorySessionBindingStore());
channelBrokerAdapterConformance("in-memory", () => new InMemoryEdgeChannelBroker());

describe("distributed Edge coordination", () => {
  it("coordinates atomic round-robin and sticky selection with documented consistency requirements", async () => {
    const store = new InMemoryEdgePoolSelectionStore();
    const candidates = ["a", "b", "c"].map((edgeNodeId) => ({ edgeNodeId, connectionGeneration: 1 }));
    const selected = await Promise.all(Array.from({ length: 5 }, () => store.select("tenant", "workers", candidates, "round-robin")));
    expect(selected.map((entry) => entry.edgeNodeId)).toEqual(["a", "b", "c", "a", "b"]);
    const sticky = await Promise.all(Array.from({ length: 3 }, () => store.select("tenant", "workers", candidates, "sticky", "session-a")));
    expect(new Set(sticky.map((entry) => entry.edgeNodeId))).toHaveLength(1);
    expect(EDGE_DISTRIBUTED_CONSISTENCY_REQUIREMENTS.pool).toContain("atomic");
    expect(EDGE_DISTRIBUTED_CONSISTENCY_REQUIREMENTS.correlation).toContain("exactly one");
  });

  it("runs proxy selection, gateway presence, desired state, and result handling as separate injected services", async () => {
    const shared = {
      devices: new InMemoryEdgeDeviceRegistry(),
      presence: new InMemoryEdgePresenceStore(),
      readiness: new InMemoryEdgeReadinessStore(),
      selections: new InMemoryEdgeSessionSelectionStore(() => 0),
      children: new InMemoryEdgeChildBindingStore(() => "child"),
      desired: new InMemoryEdgeDesiredStateStore(),
      broker: new InMemoryEdgeChannelBroker(),
      correlations: new InMemoryEdgeResultCorrelationStore(),
    };
    const gatewayInstance = {
      connect: () => shared.presence.put({
        tenantId: "tenant", edgeNodeId: "node", credentialId: "credential", connectionId: "connection",
        connectionGeneration: 2, protocolVersion: 2, connectedAt: 1,
        heartbeat: { lastHeartbeatAt: 1, staleAfterMs: 100, evaluatedAt: 1, fresh: true }, status: "online",
      }),
    };
    const desiredStateInstance = {
      publish: () => shared.desired.publish({
        version: 2, kind: "edge.desired-state", tenantId: "tenant", edgeNodeId: "node", desiredVersion: 1, deployments: [],
      }),
    };
    const proxySelectionInstance = {
      select: () => shared.selections.put({
        sessionId: "session", subjectId: "alice", targetName: "personal", tenantId: "tenant",
        edgeNodeId: "node", inventoryVersion: 1, selectedAt: 1, expiresAt: 100,
      }),
    };
    const resultInstance = new ResultInstance(shared.correlations, shared.broker, "proxy-b");
    await gatewayInstance.connect();
    await desiredStateInstance.publish();
    await proxySelectionInstance.select();
    await resultInstance.expect("request", "tenant", "node", 2);
    await shared.broker.publish("results/request", JSON.stringify({ requestId: "request", status: "ok" }));
    expect(await shared.presence.get("tenant", "node")).toMatchObject({ connectionGeneration: 2 });
    expect(await shared.desired.get("tenant", "node")).toMatchObject({ desiredVersion: 1 });
    expect(await shared.selections.get("session", "alice", "personal")).toMatchObject({ edgeNodeId: "node" });
    expect(resultInstance.received).toEqual([{ requestId: "request", status: "ok" }]);
    expect(await shared.correlations.take("request")).toBeUndefined();
  });

  it("recovers shared inventory, presence expiry, desired state, selections, child cleanup, and correlation after service restart", async () => {
    const presence = new InMemoryEdgePresenceStore();
    const desired = new InMemoryEdgeDesiredStateStore();
    const selections = new InMemoryEdgeSessionSelectionStore(() => 0);
    const children = new InMemoryEdgeChildBindingStore(() => "child");
    const correlations = new InMemoryEdgeResultCorrelationStore();
    await presence.put({
      tenantId: "tenant", edgeNodeId: "node", credentialId: "credential", connectionId: "connection", connectionGeneration: 1,
      protocolVersion: 2, connectedAt: 1, heartbeat: { lastHeartbeatAt: 1, staleAfterMs: 1, evaluatedAt: 1, fresh: true }, status: "online",
    });
    await desired.publish({ version: 2, kind: "edge.desired-state", tenantId: "tenant", edgeNodeId: "node", desiredVersion: 3, deployments: [] });
    await selections.put({ sessionId: "session", subjectId: "alice", targetName: "target", tenantId: "tenant", edgeNodeId: "node", inventoryVersion: 1, selectedAt: 1, expiresAt: 10 });
    await children.allocate({ parentSessionId: "session", parentRequestId: "parent", childRequestId: "request", tenantId: "tenant", subjectId: "alice", targetName: "target", edgeNodeId: "node", connectionGeneration: 1, createdAt: 1, expiresAt: 2 });
    await correlations.put({ requestId: "request", tenantId: "tenant", edgeNodeId: "node", connectionGeneration: 1, ownerInstanceId: "proxy-a", expiresAt: 2 });
    // New service objects reuse injected stores exactly as a restarted instance would. @pk
    const restarted = { presence, desired, selections, children, correlations };
    expect(await restarted.presence.purgeStale(2)).toHaveLength(1);
    expect(await restarted.desired.get("tenant", "node")).toMatchObject({ desiredVersion: 3 });
    expect(await restarted.selections.get("session", "alice", "target")).toMatchObject({ edgeNodeId: "node" });
    expect(await restarted.children.purgeExpired(2)).toHaveLength(1);
    expect(await restarted.correlations.purgeExpired(2)).toHaveLength(1);
  });

  it("surfaces actionable diagnostics for production claims using reference adapters", () => {
    const diagnostics = diagnoseEdgeProductionAdapters({
      inventory: new InMemoryEdgeDeviceRegistry(),
      presence: new InMemoryEdgePresenceStore(),
      readiness: new InMemoryEdgeReadinessStore(),
      selection: new InMemoryEdgeSessionSelectionStore(),
      binding: new InMemoryEdgeChildBindingStore(),
      channel: new InMemoryEdgeChannelBroker(),
    }, true);
    expect(diagnostics.some((entry) => entry.code === "EDGE_ADAPTER_NOT_PRODUCTION_READY" && entry.adapterRole === "inventory")).toBe(true);
    expect(diagnostics.every((entry) => entry.nextActions[0]?.includes("durable multi-instance"))).toBe(true);
    expect(diagnoseEdgeProductionAdapters({}, false)).toEqual([]);
  });
});

class ResultInstance {
  readonly received: unknown[] = [];

  constructor(
    private readonly correlations: EdgeResultCorrelationStore,
    private readonly broker: InMemoryEdgeChannelBroker,
    private readonly instanceId: string,
  ) {}

  async expect(requestId: string, tenantId: string, edgeNodeId: string, connectionGeneration: number): Promise<void> {
    await this.correlations.put({ requestId, tenantId, edgeNodeId, connectionGeneration, ownerInstanceId: this.instanceId, expiresAt: 100 });
    this.broker.subscribe(`results/${requestId}`, async (message) => {
      const correlation = await this.correlations.take(requestId);
      if (correlation?.ownerInstanceId === this.instanceId) this.received.push(JSON.parse(message));
    });
  }
}
