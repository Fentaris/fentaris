import { describe, expect, it, vi } from "vitest";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  McpProxy,
  McpServer,
  InProcessIsolation,
  Logger,
  toProxyToolName,
  type FentarisTransport,
  type PolicyContract,
  type PolicyDecision,
  type ToolCallRequest,
  type UserContext,
  type ProxyExposureTransport,
  type ProxyRuntime,
} from "../../src/index.js";
import type { RuntimeEvent } from "../../src/profiler/index.js";

class MockTransport implements FentarisTransport {
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => ({
    content: [{ type: "text", text: `called:${params.name}` }],
  }));

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => ({
    tools: [{ name: "create_issue", inputSchema: { type: "object" } }],
  }));
}

class TogglePolicy implements PolicyContract {
  readonly name = "toggle";

  constructor(private readonly allowed: boolean) {}

  getPermissions(): [] {
    return [];
  }

  evaluate(request: ToolCallRequest, user: UserContext): PolicyDecision {
    return {
      allowed: this.allowed,
      reason: this.allowed ? "allowed" : "denied",
      metadata: {
        matchedGroups: user.id ? [user.id] : [],
        matchedPermissions: [{ server: request.serverName, tool: request.toolName }],
      },
    };
  }
}

class SlowTransport extends MockTransport {
  override readonly callTool = vi.fn(async (): Promise<CallToolResult> => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { content: [{ type: "text", text: "late" }] };
  });
}

class FailingExposureTransport implements ProxyExposureTransport {
  async listen(_runtime: ProxyRuntime): Promise<{ close(): Promise<void> }> {
    throw new Error("listen failed");
  }
}

describe("McpProxy profiler integration", () => {
  it("emits automatic MCP start, success, and policy allow events", async () => {
    const events: RuntimeEvent[] = [];
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
      policy: new TogglePolicy(true),
      profiler: {
        level: "debug",
        track: ["mcp", "policy", "errors"],
        sink: (event) => events.push(event),
      },
    });

    await proxy.callTool({ name: toProxyToolName("github", "create_issue"), arguments: { token: "secret-token" } }, { id: "alice" });

    expect(events.map((event) => event.name)).toEqual([
      "policy.allowed",
      "mcp.call.start",
      "mcp.call.success",
    ]);
    expect(events[1]).toMatchObject({
      server: "github",
      user: "alice",
      operation: "tool:call",
    });
    expect(JSON.stringify(events)).not.toContain("secret-token");
  });

  it("emits policy deny and MCP error events for denied calls", async () => {
    const events: RuntimeEvent[] = [];
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
      policy: new TogglePolicy(false),
      profiler: {
        track: ["mcp", "policy", "errors"],
        sink: (event) => events.push(event),
      },
    });

    const result = await proxy.callTool({ name: toProxyToolName("github", "create_issue") }, { id: "alice" });

    expect(result.isError).toBe(true);
    expect(transport.callTool).not.toHaveBeenCalled();
    expect(events.map((event) => event.name)).toContain("policy.denied");
    expect(events.map((event) => event.name)).toContain("mcp.call.success");
    expect(events.find((event) => event.name === "policy.denied")).toMatchObject({
      category: "policy",
      level: "warn",
    });
  });

  it("emits extension errors from middleware boundaries", async () => {
    const events: RuntimeEvent[] = [];
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
      profiler: {
        track: ["errors", "extension"],
        sink: (event) => events.push(event),
      },
    });
    proxy.use(() => {
      throw new Error("middleware failed");
    });

    await proxy.callTool({ name: toProxyToolName("github", "create_issue") }, { id: "alice" });

    expect(events.map((event) => event.name)).toContain("extension.error");
    expect(events.find((event) => event.name === "extension.error")).toMatchObject({
      category: "errors",
      level: "error",
    });
  });

  it("emits timeout events from isolated MCP calls", async () => {
    const events: RuntimeEvent[] = [];
    const proxy = new McpProxy({
      servers: [
        new McpServer({
          name: "github",
          transport: new SlowTransport(),
          isolation: new InProcessIsolation(),
          isolationTimeout: 1,
        }),
      ],
      profiler: {
        track: ["mcp", "timeouts", "errors"],
        sink: (event) => events.push(event),
      },
    });

    const result = await proxy.callTool({ name: toProxyToolName("github", "create_issue") }, { id: "alice" });

    expect(result.isError).toBe(true);
    expect(events.map((event) => event.name)).toContain("mcp.call.timeout");
    expect(events.find((event) => event.name === "mcp.call.timeout")).toMatchObject({
      category: "timeouts",
      timeoutMs: 1,
    });
  });

  it("emits transport and lifecycle events at runtime boundaries", async () => {
    const events: RuntimeEvent[] = [];
    const proxy = new McpProxy({
      servers: [],
      profiler: {
        track: ["transport", "errors", "lifecycle"],
        sink: (event) => events.push(event),
      },
    });

    await proxy.emitSessionStart({ user: { id: "alice" }, log: new Logger() });
    await proxy.emitSessionEnd({ user: { id: "alice" }, log: new Logger() });
    await expect(proxy.listen(new FailingExposureTransport())).rejects.toThrow("listen failed");

    expect(events.map((event) => event.name)).toEqual([
      "runtime.ready",
      "runtime.stop",
      "runtime.start",
      "transport.error",
      "runtime.error",
    ]);
  });
});
