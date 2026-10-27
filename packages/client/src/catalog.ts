import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ClientError } from "./errors.js";
import type { Session } from "./session.js";

/** Separator used by the proxy between server and upstream names (see @fentaris/core naming). */
export const SEPARATOR = "__";
const COMPACT = { servers: "fentaris__servers_list", search: "fentaris__tools_search", get: "fentaris__tools_get", call: "fentaris__tools_call" };
const COMPACT_PAGE = 100;

export type Catalog = {
  mode: "classic" | "compact";
  list(server?: string): Promise<Tool[]>;
  get(name: string): Promise<Tool | undefined>;
  call(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult>;
};

export function splitName(name: string): { server: string; tool: string } | undefined {
  const separator = name.indexOf(SEPARATOR);
  return separator > 0 && separator + SEPARATOR.length < name.length ? { server: name.slice(0, separator), tool: name.slice(separator + SEPARATOR.length) } : undefined;
}

export function serverOf(name: string): string | undefined {
  return splitName(name)?.server;
}

/** Detect compact discovery once per session and return an adapter with identical identifiers. */
export async function openCatalog(session: Session): Promise<Catalog> {
  const first = await listAll(session);
  const names = new Set(first.map((tool) => tool.name));
  if (names.has(COMPACT.call) && names.has(COMPACT.search) && names.has(COMPACT.servers)) return compactCatalog(session, first);
  return {
    mode: "classic",
    async list(server) { return server ? first.filter((tool) => serverOf(tool.name) === server) : first; },
    async get(name) { return first.find((tool) => tool.name === name); },
    call: (name, args) => session.client.callTool({ name, arguments: args }, undefined, session.options) as Promise<CallToolResult>,
  };
}

async function listAll(session: Session): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.client.listTools(cursor ? { cursor } : undefined, session.options);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function compactCatalog(session: Session, metaTools: Tool[]): Catalog {
  const local = metaTools.filter((tool) => !Object.values(COMPACT).includes(tool.name));
  const meta = async (name: string, args: Record<string, unknown>) => {
    const result = await session.client.callTool({ name, arguments: args }, undefined, session.options) as CallToolResult;
    if (result.isError) throw new ClientError("NOT_FOUND", textOf(result) || `${name} failed.`, { tool: name });
    return result.structuredContent ?? JSON.parse(textOf(result) || "{}") as Record<string, unknown>;
  };
  const servers = async (): Promise<string[]> => ((await meta(COMPACT.servers, {})).servers as Array<{ name: string }> ?? []).map((server) => server.name);
  const searchServer = async (server: string): Promise<Tool[]> => {
    const tools: Tool[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await meta(COMPACT.search, { server, cursor, limit: COMPACT_PAGE }) as { tools?: Array<Omit<Tool, "inputSchema">>; pagination?: { nextCursor: number | null } };
      tools.push(...(page.tools ?? []).map((tool) => ({ ...tool, name: `${server}${SEPARATOR}${tool.name}`, inputSchema: { type: "object" as const } })));
      cursor = page.pagination?.nextCursor ?? null;
    }
    return tools;
  };
  return {
    mode: "compact",
    async list(server) {
      if (server) return server === "fentaris" ? local : searchServer(server);
      const all = [...local];
      for (const name of await servers()) all.push(...await searchServer(name).catch(() => []));
      return all;
    },
    async get(name) {
      if (local.some((tool) => tool.name === name)) return local.find((tool) => tool.name === name);
      const parts = splitName(name);
      if (!parts) return undefined;
      const result = await meta(COMPACT.get, { server: parts.server, tools: [parts.tool] }).catch((error: unknown) => {
        if (error instanceof ClientError && error.code === "NOT_FOUND") return { tools: [] };
        throw error;
      }) as { tools?: Tool[] };
      const tool = result.tools?.[0];
      return tool ? { ...tool, name } : undefined;
    },
    call(name, args) {
      if (local.some((tool) => tool.name === name)) return session.client.callTool({ name, arguments: args }, undefined, session.options) as Promise<CallToolResult>;
      const parts = splitName(name);
      if (!parts) throw new ClientError("INVALID_ARGUMENTS", `"${name}" is not a proxied tool name such as github__create_issue.`);
      return session.client.callTool({ name: COMPACT.call, arguments: { server: parts.server, tool: parts.tool, ...(args ? { arguments: args } : {}) } }, undefined, session.options) as Promise<CallToolResult>;
    },
  };
}

/** Rank by query terms: every term must match name, title, or description. */
export function searchTools(tools: Tool[], query: string): Array<{ tool: Tool; score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked: Array<{ tool: Tool; score: number }> = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const short = (splitName(tool.name)?.tool ?? tool.name).toLowerCase();
    const title = (tool.title ?? tool.annotations?.title ?? "").toLowerCase();
    const description = (tool.description ?? "").toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const termScore = (short === term ? 10 : 0) + (name.includes(term) ? 5 : 0) + (title.includes(term) ? 3 : 0) + (description.includes(term) ? 1 : 0);
      if (!termScore) { matchedAll = false; break; }
      score += termScore;
    }
    if (matchedAll && terms.length) ranked.push({ tool, score });
  }
  return ranked.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
}

export function textOf(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
  return content.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}
