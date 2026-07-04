import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  EDGE_MCP_ENVELOPE_VERSION,
  EdgeTransport,
  McpProxy,
  McpServer,
  Policy,
  StdioTransport,
  edge,
  runtime,
  type EdgeMcpInboundEnvelope,
  type EdgeMcpOutboundEnvelope,
  type EdgeTransportChannel,
  type FentarisTransport,
  type ProxyContext,
} from "../../src/index.js";

class TestChannel implements EdgeTransportChannel {
  readonly sent: EdgeMcpOutboundEnvelope[] = [];
  private readonly handlers = new Set<(message: unknown) => void>();
  responder?: (message: EdgeMcpOutboundEnvelope) => EdgeMcpInboundEnvelope | undefined;
  sendError?: Error;

  async send(message: EdgeMcpOutboundEnvelope): Promise<void> {
    this.sent.push(message);
    if (this.sendError) throw this.sendError;
    const response = this.responder?.(message);
    if (response) queueMicrotask(() => this.emit(response));
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(message: unknown): void {
    for (const handler of this.handlers) handler(message);
  }
}

function routeContext(signal?: AbortSignal): ProxyContext {
  return {
    user: { id: "alice" },
    subject: {
      id: "alice",
      groups: [],
      hasGroup: () => false,
    },
    auth: { authenticated: true, userId: "alice" },
    transport: {
      type: "http",
      sessionId: "session-1",
      requestId: "downstream-1",
      ...(signal ? { signal } : {}),
    },
    execution: {
      kind: "edge",
      targetName: "personal",
      deploymentId: "fixture",
      edgeNodeId: "node-1",
      connectionGeneration: 2,
      reused: false,
    },
  } as ProxyContext;
}

function successfulResult(message: EdgeMcpOutboundEnvelope): EdgeMcpInboundEnvelope | undefined {
  if (message.kind !== "mcp.request") return undefined;
  const resultByOperation: Record<string, object> = {
    "tools/list": { tools: [{ name: "status", inputSchema: { type: "object" } }] },
    "tools/call": { content: [{ type: "text", text: "edge-result" }] },
    "resources/list": { resources: [] },
    "resources/read": { contents: [{ uri: "file:///readme", text: "ok" }] },
    "resources/templates/list": { resourceTemplates: [] },
    "prompts/list": { prompts: [] },
    "prompts/get": { messages: [{ role: "user", content: { type: "text", text: "ok" } }] },
    "completion/complete": { completion: { values: ["ok"] } },
    ping: {},
  };
  return {
    version: EDGE_MCP_ENVELOPE_VERSION,
    kind: "mcp.result",
    requestId: message.requestId,
    operation: message.operation,
    route: message.route,
    result: resultByOperation[message.operation],
  };
}

describe("EdgeTransport", () => {
  it("forwards every supported MCP operation with stable route and correlation metadata", async () => {
    const channel = new TestChannel();
    channel.responder = successfulResult;
    const transport = new EdgeTransport({ channel, requestId: () => `request-${channel.sent.length + 1}` });

    await transport.withProxyContext(routeContext(), async () => {
      await expect(transport.listTools()).resolves.toMatchObject({ tools: [{ name: "status" }] });
      await expect(transport.callTool({ name: "status" })).resolves.toMatchObject({ content: [{ text: "edge-result" }] });
      await expect(transport.listResources()).resolves.toEqual({ resources: [] });
      await expect(transport.readResource({ uri: "file:///readme" })).resolves.toMatchObject({ contents: [{ text: "ok" }] });
      await expect(transport.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
      await expect(transport.listPrompts()).resolves.toEqual({ prompts: [] });
      await expect(transport.getPrompt({ name: "help" })).resolves.toMatchObject({ messages: [{ role: "user" }] });
      await expect(transport.complete({
        ref: { type: "ref/prompt", name: "help" },
        argument: { name: "topic", value: "" },
      })).resolves.toEqual({ completion: { values: ["ok"] } });
      await expect(transport.ping()).resolves.toEqual({});
    });

    expect(channel.sent.filter((message) => message.kind === "mcp.request").map((message) => message.operation)).toEqual([
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/read",
      "resources/templates/list",
      "prompts/list",
      "prompts/get",
      "completion/complete",
      "ping",
    ]);
    expect(channel.sent[0]).toMatchObject({
      route: {
        edgeNodeId: "node-1",
        connectionGeneration: 2,
        deploymentId: "fixture",
        downstreamSessionId: "session-1",
        subjectId: "alice",
        targetName: "personal",
      },
      trace: { downstreamRequestId: "downstream-1" },
    });
  });

  it("propagates abort cancellation and rejects late results", async () => {
    const channel = new TestChannel();
    const late = vi.fn();
    const controller = new AbortController();
    const transport = new EdgeTransport({ channel, defaultTimeoutMs: 1_000, onLateResult: late });
    const pending = transport.withProxyContext(routeContext(controller.signal), () => transport.callTool({ name: "status" }));
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    const request = channel.sent[0];
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "EDGE_WORKLOAD" });
    await vi.waitFor(() => expect(channel.sent.some((message) => message.kind === "mcp.cancel")).toBe(true));
    if (request.kind === "mcp.request") {
      channel.emit({
        version: EDGE_MCP_ENVELOPE_VERSION,
        kind: "mcp.result",
        requestId: request.requestId,
        operation: request.operation,
        route: request.route,
        result: { content: [] },
      });
    }
    expect(late).toHaveBeenCalledOnce();
  });

  it("enforces deadlines and maps unavailable, malformed, and structured edge errors", async () => {
    const timeoutChannel = new TestChannel();
    const timeoutTransport = new EdgeTransport({ channel: timeoutChannel, defaultTimeoutMs: 5 });
    await expect(
      timeoutTransport.withProxyContext(routeContext(), () => timeoutTransport.callTool({ name: "slow" })),
    ).rejects.toMatchObject({ code: "EDGE_WORKLOAD" });
    expect(timeoutChannel.sent.some((message) => message.kind === "mcp.cancel" && message.reason === "deadline")).toBe(true);

    const unavailableChannel = new TestChannel();
    unavailableChannel.sendError = new Error("offline");
    const unavailable = new EdgeTransport({ channel: unavailableChannel });
    await expect(
      unavailable.withProxyContext(routeContext(), () => unavailable.callTool({ name: "status" })),
    ).rejects.toMatchObject({ code: "EDGE_UNAVAILABLE" });

    const malformedChannel = new TestChannel();
    const malformed = new EdgeTransport({ channel: malformedChannel });
    const malformedPending = malformed.withProxyContext(routeContext(), () => malformed.callTool({ name: "status" }));
    await vi.waitFor(() => expect(malformedChannel.sent).toHaveLength(1));
    const malformedRequest = malformedChannel.sent[0];
    malformedChannel.emit({ kind: "mcp.result", requestId: malformedRequest.requestId });
    await expect(malformedPending).rejects.toMatchObject({ code: "EDGE_PROTOCOL" });

    const errorChannel = new TestChannel();
    errorChannel.responder = (message) => message.kind === "mcp.request" ? {
      version: EDGE_MCP_ENVELOPE_VERSION,
      kind: "mcp.error",
      requestId: message.requestId,
      operation: message.operation,
      route: message.route,
      error: { code: "EDGE_CAPACITY", message: "busy" },
    } : undefined;
    const errorTransport = new EdgeTransport({ channel: errorChannel });
    await expect(
      errorTransport.withProxyContext(routeContext(), () => errorTransport.callTool({ name: "status" })),
    ).rejects.toMatchObject({ code: "EDGE_CAPACITY", message: "busy" });
  });
});

class CloudTransport implements FentarisTransport {
  readonly callTool = vi.fn(async (): Promise<CallToolResult> => ({
    content: [{ type: "text", text: "cloud-result" }],
  }));
  async listTools() {
    return { tools: [{ name: "status", inputSchema: { type: "object" as const } }] };
  }
  async close() {}
}

describe("target-aware proxy dispatch", () => {
  it("routes a governed call to the pinned edge without changing its public name", async () => {
    const channel = new TestChannel();
    channel.responder = successfulResult;
    const edgeTransport = new EdgeTransport({ channel });
    const cloudTransport = new CloudTransport();
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [new McpServer({ name: "fixture", transport: cloudTransport })],
      targets: { personal: edge({ device: edge.userDefaultDevice() }) },
      placements: [{ serverName: "fixture", scope: "global", targetName: "personal" }],
      edge: {
        transport: edgeTransport,
        deviceResolver: {
          resolveUserDefaultDevice: async () => ({ edgeNodeId: "node-1" }),
        },
      },
    });
    const pipeline: string[] = [];
    proxy.use(async (ctx, next) => {
      pipeline.push(`middleware:before:${ctx.operation}`);
      const result = await next();
      pipeline.push(`middleware:after:${ctx.execution?.kind}`);
      return result;
    });
    proxy.on("tool:success", ({ ctx }) => {
      pipeline.push(`event:${ctx.execution?.targetName}`);
    });

    await expect(proxy.callTool(
      { name: "fixture__status" },
      { id: "alice" },
      { authenticated: true, userId: "alice", metadata: { sessionId: "session-1" } },
    )).resolves.toMatchObject({ content: [{ text: "edge-result" }] });
    expect(cloudTransport.callTool).not.toHaveBeenCalled();
    expect(pipeline).toEqual([
      "middleware:before:tool:call",
      "middleware:after:edge",
      "event:personal",
    ]);
    expect(channel.sent[0]).toMatchObject({
      kind: "mcp.request",
      operation: "tools/call",
      params: { name: "status" },
      route: { deploymentId: "fixture", edgeNodeId: "node-1" },
    });
  });

  it("keeps implicit cloud behavior and rejects unresolved cloud runtime references before startup", async () => {
    const cloudTransport = new CloudTransport();
    const cloudProxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [new McpServer({ name: "fixture", transport: cloudTransport })],
    });
    await expect(cloudProxy.callTool({ name: "fixture__status" })).resolves.toMatchObject({
      content: [{ text: "cloud-result" }],
    });

    const unresolved = new StdioTransport({
      command: "never-started",
      args: [runtime.input("workspace")],
    });
    const unresolvedProxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [new McpServer({ name: "local", transport: unresolved })],
    });
    await expect(unresolvedProxy.listTools()).rejects.toMatchObject({
      code: "EDGE_UNRESOLVED_RUNTIME_INPUT",
    });
    expect(unresolved.unresolvedCloudRuntimeRefs()).toEqual(["workspace"]);
    expect(new StdioTransport({
      command: "not-started",
      args: [runtime.input("workspace")],
      runtimeValues: { workspace: "/cloud/workspace" },
    }).unresolvedCloudRuntimeRefs()).toEqual([]);
  });
});
