import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyLocalHandle, ProxySessionInteraction } from "../types/proxy.js";
import type { IdentityMetadata, ResolvedSubject, UserContext } from "../types/shared.js";

export const COMPACT_DISCOVERY_TOOL_NAMES = ["servers_list", "tools_search", "tools_get", "tools_call"] as const;

export type CompactDiscoveryOptions = {
  /** Enable stable meta-tools instead of exposing every upstream tool schema. */
  mode: "compact";
  /** Default and maximum number of tool summaries returned by one search. */
  defaultPageSize?: number;
  maxPageSize?: number;
  /** Approximate response budget (JSON bytes / 4), not a billing estimate. */
  maxTokens?: number;
};

export type CompactServer = {
  name: string;
  displayName: string;
  description?: string;
  auth: "ready" | "requires-login";
  toolCount: number | "unknown";
};

export type CompactDiscoveryDeps = {
  servers(context: CompactRequestContext): Promise<CompactServer[]>;
  tools(server: string, context: CompactRequestContext): Promise<ListToolsResult["tools"]>;
  call(server: string, tool: string, args: Record<string, unknown> | undefined, context: CompactRequestContext): Promise<CallToolResult>;
};

type CompactRequestContext = {
  user: UserContext;
  identity?: IdentityMetadata;
  subject?: ResolvedSubject;
  interaction?: ProxySessionInteraction;
};

type Arguments = Record<string, unknown> | undefined;

export function registerCompactDiscoveryTools(handle: ProxyLocalHandle, options: CompactDiscoveryOptions, deps: CompactDiscoveryDeps): void {
  const cache = new Map<string, ListToolsResult["tools"]>();
  const limits = { default: options.defaultPageSize ?? 20, max: options.maxPageSize ?? 100, tokens: options.maxTokens ?? 2_000 };

  handle.tool("servers_list", {
    title: "List authorized MCP servers",
    description: "List MCP servers visible to this caller without connecting to upstreams or loading tool schemas.",
    inputSchema: objectSchema({}),
  }, async (ctx) => json({ servers: (await deps.servers(requestContext(ctx))).map((server) => ({ ...server, toolCount: cache.get(server.name)?.length ?? server.toolCount })) }));

  handle.tool("tools_search", {
    title: "Search tools on one MCP server",
    description: "Load and search short tool metadata for one selected server. Full input schemas are omitted.",
    inputSchema: objectSchema({
      server: { type: "string", description: "Server name returned by fentaris__servers_list." },
      query: { type: "string", description: "Optional case-insensitive name, title, or description search." },
      cursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 },
    }, ["server"]),
  }, async (ctx, params) => {
    const args = params.arguments as Arguments;
    const server = requiredString(args, "server");
    if (!server.ok) return error(server.error);
    const tools = await deps.tools(server.value, requestContext(ctx));
    cache.set(server.value, tools);
    const query = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
    const matching = tools.filter((tool) => !query || [tool.name, tool.title, tool.description].some((value) => value?.toLowerCase().includes(query)));
    const start = integer(args?.cursor, 0);
    const limit = Math.min(integer(args?.limit, limits.default), limits.max);
    let page = matching.slice(start, start + limit).map(({ inputSchema: _input, outputSchema: _output, ...tool }) => tool);
    while (page.length && estimateTokens(page) > limits.tokens) page = page.slice(0, -1);
    const nextCursor = start + page.length < matching.length ? start + page.length : null;
    return json({ server: server.value, tools: page, pagination: { cursor: start, limit, returned: page.length, total: matching.length, nextCursor }, measurement: { method: "ceil(JSON UTF-8 bytes / 4)", estimatedTokens: estimateTokens(page), billingEstimate: false } });
  });

  handle.tool("tools_get", {
    title: "Get selected tool schemas",
    description: "Return full definitions only for explicitly selected tools on one server.",
    inputSchema: objectSchema({ server: { type: "string" }, tools: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } }, ["server", "tools"]),
  }, async (ctx, params) => {
    const args = params.arguments as Arguments;
    const server = requiredString(args, "server");
    if (!server.ok) return error(server.error);
    const names = Array.isArray(args?.tools) ? args.tools.filter((name): name is string => typeof name === "string") : [];
    if (!names.length) return error("At least one tool name is required.");
    const tools = cache.get(server.value) ?? await deps.tools(server.value, requestContext(ctx));
    cache.set(server.value, tools);
    return json({ server: server.value, tools: names.map((name) => tools.find((tool) => tool.name === name)).filter(Boolean), missing: names.filter((name) => !tools.some((tool) => tool.name === name)) });
  });

  handle.tool("tools_call", {
    title: "Call a selected MCP tool",
    description: "Execute one upstream tool through the normal Fentaris policy, approval, credential, rate-limit, and audit pipeline.",
    inputSchema: objectSchema({ server: { type: "string" }, tool: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, ["server", "tool"]),
  }, async (ctx, params) => {
    const args = params.arguments as Arguments;
    const server = requiredString(args, "server"); const tool = requiredString(args, "tool");
    if (!server.ok) return error(server.error); if (!tool.ok) return error(tool.error);
    if (server.value === "fentaris") return error("The reserved fentaris namespace cannot be called through compact discovery.");
    const callArgs = args?.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : undefined;
    return deps.call(server.value, tool.value, callArgs, requestContext(ctx));
  });
}

function requestContext(context: Parameters<Parameters<ProxyLocalHandle["tool"]>[2]>[0]): CompactRequestContext {
  return { user: context.user, identity: context.identity, subject: context.subject };
}
function objectSchema(properties: Record<string, object>, required: string[] = []) { return { type: "object" as const, properties, ...(required.length ? { required } : {}), additionalProperties: false }; }
function requiredString(args: Arguments, key: string): { ok: true; value: string } | { ok: false; error: string } { const value = args?.[key]; return typeof value === "string" && value.trim() ? { ok: true, value: value.trim() } : { ok: false, error: `A ${key} is required.` }; }
function integer(value: unknown, fallback: number): number { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback; }
function estimateTokens(value: unknown): number { return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4); }
function json(value: unknown): CallToolResult { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }; }
function error(message: string): CallToolResult { return { isError: true, content: [{ type: "text", text: message }] }; }
