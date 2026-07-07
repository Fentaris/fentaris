import { describe, expect, it } from "vitest";
import { AgentToolDiscoveryService, StdioTransport, group, mcp, policy, user, type FentarisTransport } from "../src/index.js";

class ToolTransport implements FentarisTransport {
  constructor(private readonly tools: Array<Record<string, unknown>>) {}

  async listTools() {
    return { tools: this.tools };
  }

  async callTool() {
    return { content: [{ type: "text" as const, text: "ok" }] };
  }

  async close() {}
}

describe("agent-native tool discovery", () => {
  it("lists policy-filtered compact tools for the configured default account", async () => {
    const service = new AgentToolDiscoveryService({
      servers: [
        mcp("github", {
          transport: new ToolTransport([
            { name: "read_issue", description: "Read issues", inputSchema: { type: "object" } },
            { name: "delete_repo", description: "Delete repositories", inputSchema: { type: "object" } },
          ]),
        }),
      ],
      groups: [
        group({
          id: "support",
          users: [user("alice")],
          policy: policy("support").mcp("github").allow("read_issue"),
        }),
      ],
      cli: {
        mcpAccounts: {
          github: { default: "user:alice", allowed: ["user:alice"] },
        },
      },
    });

    const result = await service.list({ mcp: "github", compact: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject([
      { name: "github__read_issue", mcp: "github", upstreamName: "read_issue", authStatus: "authenticated" },
    ]);
    expect(result.ok && result.pagination).toMatchObject({ total: 1, returned: 1 });
  });

  it("returns machine-readable errors for disallowed selectors", async () => {
    const service = new AgentToolDiscoveryService({
      servers: [mcp("github", { transport: new ToolTransport([]) })],
      cli: { mcpAccounts: { github: { default: "user:alice", allowed: ["user:alice"] } } },
    });

    const result = await service.list({ mcp: "github", selector: "group:unknown" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "FENTARIS_AUTH_SELECTOR_NOT_ALLOWED" },
      nextActions: [{ command: "fentaris tools auth list --json" }],
    });
  });

  it("inspects one tool schema without returning unrelated schemas", async () => {
    const service = new AgentToolDiscoveryService({
      servers: [
        mcp("github", {
          transport: new ToolTransport([
            { name: "create_issue", inputSchema: { type: "object", required: ["title"] }, outputSchema: { type: "object" } },
            { name: "close_issue", inputSchema: { type: "object" } },
          ]),
        }),
      ],
      cli: { mcpAccounts: { github: { default: "user:alice", allowed: ["user:alice"] } } },
    });

    const result = await service.schema("github__create_issue", { mcp: "github", input: true, output: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      name: "github__create_issue",
      input: { available: true, schema: { required: ["title"] } },
      output: { available: true, schema: { type: "object" } },
    });
    expect(JSON.stringify(result)).not.toContain("close_issue");
  });

  it("adds pagination and narrowing guidance for max-token truncation", async () => {
    const service = new AgentToolDiscoveryService({
      servers: [
        mcp("github", {
          transport: new ToolTransport(Array.from({ length: 10 }, (_, index) => ({
            name: `tool_${index}`,
            description: "long ".repeat(20),
            inputSchema: { type: "object" },
          }))),
        }),
      ],
      cli: { mcpAccounts: { github: { default: "user:alice", allowed: ["user:alice"] } } },
    });

    const result = await service.list({ mcp: "github", limit: 10, maxTokens: 80 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.pagination?.truncated).toBe(true);
    expect(result.ok && result.nextActions.some((action) => action.command?.includes("tools search"))).toBe(true);
  });

  it("reports auth account lists, delegated login, and unconfigured selector refusal", () => {
    const service = new AgentToolDiscoveryService({
      servers: [mcp("github", { transport: new ToolTransport([]) })],
      cli: { mcpAccounts: { github: { default: "user:alice", allowed: ["user:alice"] } } },
    });

    expect(service.authList()).toMatchObject({
      ok: true,
      data: [{ mcp: "github", default: "user:alice", allowed: ["user:alice"], statuses: [{ status: "authenticated" }] }],
    });
    expect(service.authStatusEnvelope("github", "user:alice")).toMatchObject({
      ok: true,
      data: { status: "authenticated" },
    });
    expect(service.authLogin("github", "user:alice")).toMatchObject({
      ok: true,
      data: { loginMode: "delegated" },
      nextActions: [{ command: "fentaris secrets set <reference>" }],
    });
    expect(service.authStatusEnvelope("github", "group:unknown")).toMatchObject({
      ok: false,
      error: { code: "FENTARIS_AUTH_SELECTOR_NOT_ALLOWED" },
    });
  });

  it("reports stdio no-start diagnostics and refresh metadata", async () => {
    const stdioService = new AgentToolDiscoveryService({
      servers: [mcp("local", { transport: new StdioTransport({ command: "node", args: ["fixture.mjs"] }) })],
      cli: { mcpAccounts: { local: { default: "user:alice", allowed: ["user:alice"] } } },
    });

    await expect(stdioService.list({ mcp: "local", noStart: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "FENTARIS_MCP_STDIO_NOT_STARTED" },
      warnings: [{ code: "FENTARIS_MCP_STDIO_NOT_STARTED", mcp: "local" }],
    });

    const refreshService = new AgentToolDiscoveryService({
      servers: [mcp("github", { transport: new ToolTransport([{ name: "read", inputSchema: { type: "object" } }]) })],
      cli: { mcpAccounts: { github: { default: "user:alice", allowed: ["user:alice"] } } },
    });

    const refreshed = await refreshService.list({ mcp: "github", refresh: true });
    expect(refreshed.ok && refreshed.data[0]).toMatchObject({
      discovery: { cacheStatus: "refreshed", refreshed: true },
    });
  });
});
