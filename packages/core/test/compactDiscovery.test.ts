import { describe, expect, it, vi } from "vitest";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { McpProxy } from "../src/proxy/McpProxy.js";
import { McpServer } from "../src/server/McpServer.js";
import { policy } from "../src/governance.js";
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

  it("reduces representative serialized tools/list bytes by omitting upstream schemas", async () => {
    const servers = Array.from({ length: 5 }, (_, i) => new McpServer({ name: `server${i}`, transport: new CatalogTransport(`tool${i}`, 20) }));
    const flat = await new McpProxy({ servers }).listTools();
    const compact = await new McpProxy({ discovery: { mode: "compact" }, servers }).listTools();
    const flatBytes = Buffer.byteLength(JSON.stringify(flat)); const compactBytes = Buffer.byteLength(JSON.stringify(compact));
    expect(flatBytes).toBeGreaterThan(compactBytes * 5);
    expect(compact.tools).toHaveLength(4);
  });
});
