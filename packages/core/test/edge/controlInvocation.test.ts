import { describe, expect, it, vi } from "vitest";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
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
  edgeError,
  type EdgePresence,
  type FentarisTransport,
  type ProxyContext,
} from "../../src/index.js";

const now = Date.now();

class SchemaTransport implements FentarisTransport {
  async listTools(): Promise<ListToolsResult> {
    return { tools: [{
      name: "write",
      description: "Write a value",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    }] };
  }
  async callTool(): Promise<CallToolResult> {
    throw new Error("cloud transport must not execute explicit Edge calls");
  }
  async close(): Promise<void> {}
}

class CapturingEdgeTransport implements FentarisTransport {
  context?: ProxyContext;
  readonly call = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => ({
    content: [{ type: "text", text: `edge:${String(params.arguments?.value)}` }],
    structuredContent: { untrustedRoute: "node-forged", value: params.arguments?.value },
  }));

  async withProxyContext<T>(context: ProxyContext, run: () => Promise<T>): Promise<T> {
    this.context = context;
    return run();
  }
  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> { return this.call(params); }
  async close(): Promise<void> {}
}

async function fixture(options: { policy?: Policy; edgeTransport?: CapturingEdgeTransport; readiness?: "ready" | "setup-required" } = {}) {
  const devices = new InMemoryEdgeDeviceRegistry();
  const presence = new InMemoryEdgePresenceStore();
  const readiness = new InMemoryEdgeReadinessStore();
  await devices.put({
    tenantId: "tenant-a", edgeNodeId: "node-a", credentialId: "secret", subjectId: "alice", revoked: false,
    connectionGeneration: 4, inventoryVersion: 1,
    user: { name: "Alice Laptop", tags: [], updatedAt: now }, managed: { aliases: [], pools: [], updatedAt: now },
  });
  const dynamic: EdgePresence = {
    tenantId: "tenant-a", edgeNodeId: "node-a", credentialId: "secret", connectionId: "connection-a",
    connectionGeneration: 4, protocolVersion: 2, connectedAt: now,
    heartbeat: { lastHeartbeatAt: now, staleAfterMs: 60_000, evaluatedAt: now, fresh: true }, status: "online",
    capacity: { maxConcurrent: 2, available: 1, reportedAt: now },
  };
  await presence.put(dynamic);
  await readiness.put({
    tenantId: "tenant-a", edgeNodeId: "node-a", deploymentId: "files", status: options.readiness ?? "ready", observedAt: now,
  });
  const inventory = new EdgeInventoryService({
    devices, presence, readiness,
    authorizer: {
      canAccessDevice: (context, device) => context.subjectId === device.subjectId,
      canAccessDeployment: () => true,
    },
  });
  const sessionSelections = new InMemoryEdgeSessionSelectionStore();
  const parentBindings = new InMemorySessionBindingStore();
  const childStore = new InMemoryEdgeChildBindingStore(() => "binding-1");
  const childBindingManager = new EdgeChildBindingManager({ store: childStore });
  const edgeTransport = options.edgeTransport ?? new CapturingEdgeTransport();
  const proxy = new McpProxy({
    servers: [new McpServer({ name: "files", transport: new SchemaTransport() })],
    policy: options.policy ?? Policy.allowAll(),
    edge: {
      transport: edgeTransport,
      deviceResolver: { resolveNamedAlias: async () => null, resolvePool: async () => null },
      sessionBindingStore: parentBindings,
      sessionSelectionStore: sessionSelections,
      childBindingManager,
      control: {
        enabled: true,
        inventory,
        selections: new EdgeSessionSelectionService({ selections: sessionSelections, bindings: parentBindings, inventory }),
      },
    },
  });
  const identity = { authenticated: true, userId: "alice", metadata: { tenantId: "tenant-a", sessionId: "parent-session", requestId: "parent-request" } };
  return { proxy, identity, edgeTransport, childStore, parentBindings };
}

describe("edge__call", () => {
  it("re-enters the normal tool pipeline in an isolated trusted child route", async () => {
    const { proxy, identity, edgeTransport, childStore } = await fixture();
    const response = await proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write", arguments: { value: "ok" } },
    }, { id: "alice" }, identity);
    expect(response).toMatchObject({
      content: [{ text: "edge:ok" }],
      structuredContent: {
        status: "succeeded", device: { name: "Alice Laptop", inventoryVersion: 1 },
        result: { structuredContent: { untrustedRoute: "node-forged", value: "ok" } },
      },
    });
    expect(edgeTransport.context?.execution).toMatchObject({
      kind: "edge", edgeNodeId: "node-a", connectionGeneration: 4, deploymentId: "files", targetName: "edge-control",
    });
    expect(edgeTransport.context?.transport.sessionId).toMatch(/^parent-session:edge:/);
    expect(edgeTransport.call).toHaveBeenCalledWith({ name: "write", arguments: { value: "ok" } });
    const childId = (response.structuredContent as { correlationId: string }).correlationId;
    expect(childId).toBeTruthy();
    // Correlation is released on terminal completion and untrusted output cannot replace routing metadata. @pk
    expect(await childStore.get("binding-1")).toBeUndefined();
    expect((response.structuredContent as Record<string, unknown>).edgeNodeId).toBeUndefined();
  });

  it("rejects schema-invalid arguments before Edge dispatch with an inspection next action", async () => {
    const { proxy, identity, edgeTransport } = await fixture();
    const response = await proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write", arguments: { value: 7 } },
    }, { id: "alice" }, identity);
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "EDGE_INPUT_INVALID", details: { nextActions: [expect.stringContaining("tools/list")] } } },
    });
    expect(edgeTransport.call).not.toHaveBeenCalled();
  });

  it("does not reveal a tool hidden by effective policy", async () => {
    const policy = new Policy({ name: "control-only" }).mcp("edge").allow("call");
    const { proxy, identity, edgeTransport } = await fixture({ policy });
    const response = await proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write", arguments: { value: "x" } },
    }, { id: "alice" }, identity);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: "EDGE_UNAUTHORIZED_TARGET" } } });
    expect(JSON.stringify(response)).not.toContain("write is hidden");
    expect(edgeTransport.call).not.toHaveBeenCalled();
  });

  it("rejects denied and setup-required devices before starting a workload", async () => {
    const denied = await fixture();
    const deniedResponse = await denied.proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write", arguments: { value: "x" } },
    }, { id: "bob" }, { ...denied.identity, userId: "bob" });
    expect(deniedResponse).toMatchObject({ isError: true, structuredContent: { error: { code: "EDGE_UNAUTHORIZED_TARGET" } } });
    expect(denied.edgeTransport.call).not.toHaveBeenCalled();

    const setup = await fixture({ readiness: "setup-required" });
    const setupResponse = await setup.proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write", arguments: { value: "x" } },
    }, { id: "alice" }, setup.identity);
    expect(setupResponse).toMatchObject({ isError: true, structuredContent: { error: { code: "EDGE_SETUP_REQUIRED" } } });
    expect(setup.edgeTransport.call).not.toHaveBeenCalled();
  });

  it("rejects recursion and malformed child output", async () => {
    const recursive = await fixture();
    const recursion = await recursive.proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "edge__call", arguments: {} },
    }, { id: "alice" }, recursive.identity);
    expect(recursion).toMatchObject({ isError: true, structuredContent: { error: { code: "EDGE_PROTOCOL" } } });

    const malformedTransport = new CapturingEdgeTransport();
    malformedTransport.call.mockResolvedValueOnce({ nope: true } as never);
    const malformed = await fixture({ edgeTransport: malformedTransport });
    const response = await malformed.proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write", arguments: { value: "x" } },
    }, { id: "alice" }, malformed.identity);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: "EDGE_PROTOCOL" } } });
  });

  it("propagates a bounded child deadline and reports timeout failure", async () => {
    const timed = new CapturingEdgeTransport();
    timed.call.mockImplementationOnce(async () => {
      expect(timed.context?.transport.deadline).toBeGreaterThan(Date.now());
      expect(timed.context?.transport.deadline).toBeLessThanOrEqual(Date.now() + 100);
      throw edgeError("EDGE_WORKLOAD", "Edge MCP tools/call exceeded its deadline.");
    });
    const { proxy, identity, childStore } = await fixture({ edgeTransport: timed });
    const response = await proxy.callTool({
      name: "edge__call",
      arguments: {
        device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write",
        arguments: { value: "x" }, deadlineMs: 50,
      },
    }, { id: "alice" }, identity);
    expect(response).toMatchObject({ isError: true, structuredContent: { status: "failed", result: { isError: true } } });
    expect(await childStore.get("binding-1")).toBeUndefined();
  });

  it("preserves the parent transparent pin and cleans children on failure and session end", async () => {
    const failing = new CapturingEdgeTransport();
    failing.call.mockRejectedValueOnce(edgeError("EDGE_WORKLOAD", "failed"));
    const { proxy, identity, parentBindings } = await fixture({ edgeTransport: failing });
    await parentBindings.store({ sessionId: "parent-session", subjectId: "alice", targetName: "personal" }, {
      sessionId: "parent-session", subjectId: "alice", targetName: "personal", edgeNodeId: "parent-node", connectionGeneration: 1,
    });
    const response = await proxy.callTool({
      name: "edge__call",
      arguments: { device: { name: "Alice Laptop", inventoryVersion: 1 }, tool: "files__write", arguments: { value: "x" } },
    }, { id: "alice" }, identity);
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", result: { isError: true, content: [{ text: "failed" }] } },
    });
    expect(await parentBindings.get({ sessionId: "parent-session", subjectId: "alice", targetName: "personal" }))
      .toMatchObject({ edgeNodeId: "parent-node" });
    await proxy.endEdgeSession("parent-session");
    expect(await parentBindings.get({ sessionId: "parent-session", subjectId: "alice", targetName: "personal" })).toBeUndefined();
  });
});
