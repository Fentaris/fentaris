import { describe, expect, it, vi } from "vitest";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { McpProxy } from "../src/proxy/McpProxy.js";
import { McpServer } from "../src/server/McpServer.js";
import { group, policy, user } from "../src/governance.js";
import type { FentarisTransport } from "../src/types.js";

class CatalogTransport implements FentarisTransport {
  constructor(readonly prefix: string, readonly count = 3) {}
  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => ({ tools: Array.from({ length: this.count }, (_, index) => ({ name: `${this.prefix}_${index}`, description: `Tool ${index}`, inputSchema: { type: "object", properties: { value: { type: "string" } } } })) }));
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => ({ content: [{ type: "text", text: `called:${params.name}` }] }));
  async close() {}
}

type ToolData = { servers: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>>; measurement: { billingEstimate: boolean } };
function data(result: CallToolResult): ToolData { return result.structuredContent as unknown as ToolData; }

describe("compact MCP discovery", () => {
  it("is opt-in and keeps a constant initial stable tool set without upstream discovery", async () => {
    const one = new CatalogTransport("one"); const two = new CatalogTransport("two", 50);
    const classic = new McpProxy({ servers: [new McpServer({ name: "one", transport: one })] });
    expect((await classic.listTools()).tools).toHaveLength(3);

    const compact = new McpProxy({ discovery: { mode: "compact" }, servers: [new McpServer({ name: "one", transport: one }), new McpServer({ name: "two", transport: two })] });
    expect((await compact.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "fentaris__servers_list", "fentaris__tools_call", "fentaris__tools_get", "fentaris__tools_search",
    ]);
    expect(one.listTools).toHaveBeenCalledTimes(1); // classic only
    expect(two.listTools).not.toHaveBeenCalled();
    const servers = data(await compact.callTool({ name: "fentaris__servers_list", arguments: {} }));
    expect(servers.servers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "one", toolCount: "unknown" }), expect.objectContaining({ name: "two" })]));
    expect(two.listTools).not.toHaveBeenCalled();
  });

  it("discovers only the selected server, paginates summaries, returns schemas explicitly, and governs calls", async () => {
    const one = new CatalogTransport("one", 4); const unrelated = new CatalogTransport("secret", 20);
    const compact = new McpProxy({ discovery: { mode: "compact", defaultPageSize: 2 }, policy: policy("limited").mcp("one").allow("one_0"), servers: [new McpServer({ name: "one", transport: one }), new McpServer({ name: "unrelated", transport: unrelated })] });
    expect((await compact.listTools()).tools).toHaveLength(4);
    const search = data(await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one" } }));
    expect(search.tools).toEqual([{ name: "one_0", description: "Tool 0" }]);
    expect(search.tools[0]).not.toHaveProperty("inputSchema");
    expect(search.measurement.billingEstimate).toBe(false);
    expect(unrelated.listTools).not.toHaveBeenCalled();

    const schema = data(await compact.callTool({ name: "fentaris__tools_get", arguments: { server: "one", tools: ["one_0"] } }));
    expect(schema.tools[0].inputSchema).toEqual(expect.objectContaining({ type: "object" }));
    const allowed = await compact.callTool({ name: "fentaris__tools_call", arguments: { server: "one", tool: "one_0", arguments: { value: "x" } } });
    expect(allowed.content).toEqual([{ type: "text", text: "called:one_0" }]);
    const denied = await compact.callTool({ name: "fentaris__tools_call", arguments: { server: "unrelated", tool: "secret_0" } });
    expect(denied.isError).toBe(true);
    expect(unrelated.callTool).not.toHaveBeenCalled();
  });

  it("reauthorizes schema retrieval for each caller instead of sharing discovered definitions", async () => {
    const one = new CatalogTransport("one", 2);
    const compact = new McpProxy({
      discovery: { mode: "compact" },
      groups: [
        group({ id: "alice", users: [user("alice")], policy: policy("alice").mcp("one").allow("one_0") }),
        group({ id: "bob", users: [user("bob")], policy: policy("bob").mcp("one").allow("one_1") }),
      ],
      servers: [new McpServer({ name: "one", transport: one })],
    });

    const aliceSearch = data(await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one" } }, { id: "alice" }));
    expect(aliceSearch.tools.map(({ name }) => name)).toEqual(["one_0"]);

    const bobSchemas = data(await compact.callTool({ name: "fentaris__tools_get", arguments: { server: "one", tools: ["one_0", "one_1"] } }, { id: "bob" }));
    expect(bobSchemas.tools.map(({ name }) => name)).toEqual(["one_1"]);
    expect(bobSchemas).toMatchObject({ missing: ["one_0"] });
    expect(one.listTools).toHaveBeenCalledTimes(2);
  });

  it("returns a bounded error rather than a nonadvancing cursor for oversized metadata", async () => {
    const one = new CatalogTransport("one", 3);
    one.listTools.mockResolvedValueOnce({ tools: [
      { name: "oversized", description: "x".repeat(2_000), inputSchema: { type: "object" } },
      { name: "reachable", description: "small", inputSchema: { type: "object" } },
    ] });
    const compact = new McpProxy({ discovery: { mode: "compact", maxTokens: 300 }, servers: [new McpServer({ name: "one", transport: one })] });

    const result = await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("cursor 0") });
    expect(result.structuredContent).toBeUndefined();
  });

  it("advances cursors across token-bounded pages", async () => {
    const one = new CatalogTransport("one", 3);
    const compact = new McpProxy({ discovery: { mode: "compact", defaultPageSize: 1 }, servers: [new McpServer({ name: "one", transport: one })] });

    const first = data(await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one" } }));
    expect(first).toMatchObject({ tools: [{ name: "one_0" }], pagination: { cursor: 0, nextCursor: 1 } });
    const second = data(await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one", cursor: 1 } }));
    expect(second).toMatchObject({ tools: [{ name: "one_1" }], pagination: { cursor: 1, nextCursor: 2 } });
    const last = data(await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one", cursor: 2 } }));
    expect(last).toMatchObject({ tools: [{ name: "one_2" }], pagination: { cursor: 2, nextCursor: null } });
  });

  it("budgets and measures the entire serialized MCP response", async () => {
    const one = new CatalogTransport("one", 3);
    one.listTools.mockResolvedValueOnce({ tools: Array.from({ length: 3 }, (_, index) => ({
      name: `one_${index}`, description: "é".repeat(80), inputSchema: { type: "object" },
    })) });
    const maxTokens = 300;
    const compact = new McpProxy({ discovery: { mode: "compact", maxTokens }, servers: [new McpServer({ name: "one", transport: one })] });

    const result = await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one" } });
    expect(result.isError).toBeFalsy();
    const estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(result), "utf8") / 4);
    expect(estimatedTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.structuredContent).toMatchObject({ measurement: { estimatedTokens } });
    expect(data(result).tools.length).toBeGreaterThan(0);
    expect(data(result).tools.length).toBeLessThan(3);
  });

  it("returns a bounded error when even an empty response exceeds the budget", async () => {
    const compact = new McpProxy({ discovery: { mode: "compact", maxTokens: 10 }, servers: [new McpServer({ name: "one", transport: new CatalogTransport("one", 0) })] });
    const result = await compact.callTool({ name: "fentaris__tools_search", arguments: { server: "one" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("response metadata exceeds") });
    expect(result.structuredContent).toBeUndefined();
  });

  it("rejects invalid compact discovery limits at construction", () => {
    expect(() => new McpProxy({ discovery: { mode: "compact", maxTokens: 0 } })).toThrow(/positive integer/);
    expect(() => new McpProxy({ discovery: { mode: "compact", defaultPageSize: 3, maxPageSize: 2 } })).toThrow(/cannot exceed/);
  });

  it("reduces representative serialized tools/list bytes by omitting upstream schemas", async () => {
    const servers = Array.from({ length: 5 }, (_, i) => new McpServer({ name: `server${i}`, transport: new CatalogTransport(`tool${i}`, 20) }));
    const flat = await new McpProxy({ servers }).listTools();
    const compact = await new McpProxy({ discovery: { mode: "compact" }, servers }).listTools();
    const flatBytes = Buffer.byteLength(JSON.stringify(flat)); const compactBytes = Buffer.byteLength(JSON.stringify(compact));
    expect(flatBytes).toBeGreaterThan(compactBytes * 5);
    expect(compact.tools).toHaveLength(4);
  });
});
