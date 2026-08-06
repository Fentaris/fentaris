import {
  EdgeChildBindingManager,
  EdgeInventoryService,
  EdgeSessionSelectionService,
  InMemoryEdgeChildBindingStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSessionSelectionStore,
  InMemorySessionBindingStore,
  McpProxy,
  McpServer,
  Policy,
  type EdgeInventoryAuthorizer,
  type FentarisTransport,
} from "@fentaris/core";

/** Agent-native discovery, declarative selection, explicit calls, and bounded fan-out. */
export function createEdgeControlApp(options: {
  workloadDiscoveryTransport: FentarisTransport;
  edgeTransport: FentarisTransport;
  authorizer: EdgeInventoryAuthorizer;
}): McpProxy {
  const devices = new InMemoryEdgeDeviceRegistry();
  const presence = new InMemoryEdgePresenceStore();
  const readiness = new InMemoryEdgeReadinessStore();
  const selectionsStore = new InMemoryEdgeSessionSelectionStore();
  const bindings = new InMemorySessionBindingStore();
  const inventory = new EdgeInventoryService({ devices, presence, readiness, authorizer: options.authorizer });
  const selections = new EdgeSessionSelectionService({ selections: selectionsStore, bindings, inventory });

  return new McpProxy({
    servers: [new McpServer({ name: "builder", transport: options.workloadDiscoveryTransport })],
    policy: new Policy({ name: "edge-agents" })
      .mcp("builder").allow("*")
      .mcp("edge").allow("list")
      .mcp("edge").allow("get")
      .mcp("edge").allow("select")
      .mcp("edge").allow("call")
      .mcp("edge").allow("call_many"),
    edge: {
      transport: options.edgeTransport,
      sessionBindingStore: bindings,
      sessionSelectionStore: selectionsStore,
      childBindingManager: new EdgeChildBindingManager({ store: new InMemoryEdgeChildBindingStore() }),
      control: {
        enabled: true,
        inventory,
        selections,
        defaultTargetName: "build-workers",
        limits: {
          maxDevices: 4,
          maxConcurrency: 2,
          maxDeadlineMs: 60_000,
          maxSelectorCandidates: 50,
          maxChildBytes: 500_000,
          maxAggregateBytes: 1_500_000,
        },
      },
    },
  });
}
