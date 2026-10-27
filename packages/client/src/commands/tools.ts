import { readFile } from "node:fs/promises";
import { McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { searchTools, serverOf, splitName, textOf } from "../catalog.js";
import { ClientError, toClientError, type NextAction } from "../errors.js";
import { integerOption, listOption, stringOption, type CommandContext } from "../framework.js";
import { table, truncate, type CommandResult } from "../output.js";
import { argumentPairs, MAX_LIMIT, paginate, quote, usingCatalog, withCursor } from "./shared.js";

/** Structured code @fentaris/core returns when an upstream needs OAuth consent. */
const UPSTREAM_AUTH_CODE = "FENTARIS_OAUTH_AUTHORIZATION_REQUIRED";

export function toolsList(context: CommandContext): Promise<CommandResult> {
  const server = stringOption(context.options, "mcp");
  const compact = context.options.compact === true;
  return usingCatalog(context, async (catalog) => {
    const { page, pagination } = paginate(context, await catalog.list(server), 50);
    const nextActions: NextAction[] = [];
    if (page[0]) nextActions.push(schemaAction(page[0].name));
    if (pagination.nextCursor) nextActions.push({ description: "Show the next page", command: withCursor(`frs tools list${server ? ` --mcp ${quote(server)}` : ""} --limit ${pagination.limit}`, pagination.nextCursor) });
    return {
      data: { mode: catalog.mode, tools: page.map((tool) => summary(tool, compact)) },
      pagination,
      nextActions,
      human: () => page.length
        ? `${table(page.map((tool) => [tool.name, truncate(tool.description ?? tool.title ?? "", 80)]), ["TOOL", "DESCRIPTION"])}\n\n${pageFooter(pagination.total, page.length, pagination.nextCursor)}`
        : server ? `No tools are visible on "${server}".` : "No tools are visible to this identity.",
    };
  });
}

export function toolsSearch(context: CommandContext): Promise<CommandResult> {
  const query = context.args[0]!.trim();
  if (!query) throw new ClientError("INVALID_ARGUMENTS", "The search query is empty.");
  const server = stringOption(context.options, "mcp");
  const limit = integerOption(context.options, "limit", 10, MAX_LIMIT);
  return usingCatalog(context, async (catalog) => {
    const matches = searchTools(await catalog.list(server), query).slice(0, limit);
    return {
      data: { query, mode: catalog.mode, tools: matches.map(({ tool, score }) => ({ ...summary(tool, true), score })) },
      pagination: { limit, cursor: null, nextCursor: null, total: matches.length },
      nextActions: matches.slice(0, 3).map(({ tool }) => schemaAction(tool.name)),
      human: () => matches.length ? table(matches.map(({ tool }) => [tool.name, truncate(tool.description ?? tool.title ?? "", 80)]), ["TOOL", "DESCRIPTION"]) : `No tools match "${query}".`,
    };
  });
}

export function toolsGet(context: CommandContext): Promise<CommandResult> {
  const name = context.args[0]!;
  return usingCatalog(context, async (catalog) => {
    const tool = await requireTool(await catalog.get(name), name);
    const data = { ...summary(tool, false), arguments: argumentSummary(tool), hasOutputSchema: Boolean(tool.outputSchema) };
    return {
      data,
      nextActions: [schemaAction(name), { description: "Call this tool", command: `frs tools call ${name} --args '{}'` }],
      human: () => [
        tool.name,
        tool.description ? `\n${tool.description}` : "",
        data.arguments.length ? `\nArguments:\n${data.arguments.map((arg) => `  ${arg.name}${arg.required ? "" : "?"}: ${arg.type}${arg.description ? ` — ${truncate(arg.description, 100)}` : ""}`).join("\n")}` : "\nArguments: none",
      ].join(""),
    };
  });
}

export function toolsSchema(context: CommandContext): Promise<CommandResult> {
  const name = context.args[0]!;
  const both = context.options.input !== true && context.options.output !== true;
  return usingCatalog(context, async (catalog) => {
    const tool = await requireTool(await catalog.get(name), name);
    const data = {
      name,
      ...(both || context.options.input === true ? { inputSchema: tool.inputSchema } : {}),
      ...(both || context.options.output === true ? { outputSchema: tool.outputSchema ?? null } : {}),
    };
    return { data, nextActions: [{ description: "Call this tool", command: `frs tools call ${name} --args '{}'` }], human: () => JSON.stringify(data, null, 2) };
  });
}

export async function toolsCall(context: CommandContext): Promise<CommandResult> {
  const name = context.args[0]!;
  const raw = context.options.raw === true;
  if (raw && context.global.json) throw new ClientError("INVALID_ARGUMENTS", "Use either --raw or --json, not both.");
  if (!splitName(name)) throw new ClientError("INVALID_ARGUMENTS", `"${name}" is not a proxied tool name such as github__create_issue.`, {}, [{ description: "Search visible tools", command: `frs tools search ${quote(name)}` }]);
  const args = await callArguments(context);
  // No visibility pre-check: the proxy decides, does not disclose hidden tools, and
  // exposes OAuth-protected upstream tools only after their authorization.
  return usingCatalog(context, async (catalog) => {
    const result = await catalog.call(name, args);
    if (raw) {
      context.runtime.write(`${JSON.stringify(result)}\n`);
      return { data: result, written: true, exitCode: result.isError ? 1 : 0 };
    }
    if (result.isError) throw toolError(result, name, context);
    return {
      data: { content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}), isError: false },
      human: () => renderContent(result),
    };
  });
}

async function callArguments(context: CommandContext): Promise<Record<string, unknown> | undefined> {
  const inline = stringOption(context.options, "args");
  const file = stringOption(context.options, "args-file");
  const pairs = listOption(context.options, "arg");
  if ([inline !== undefined, file !== undefined, pairs.length > 0].filter(Boolean).length > 1) throw new ClientError("INVALID_ARGUMENTS", "Use only one of --args, --args-file, or --arg.");
  if (pairs.length) return argumentPairs(pairs, true);
  if (inline === undefined && file === undefined) return undefined;
  const source = inline ?? (file === "-" ? await context.runtime.readStdin() : await readFile(file!, "utf8").catch((error: Error) => { throw new ClientError("INVALID_ARGUMENTS", `Cannot read --args-file ${file}: ${error.message}`); }));
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new ClientError("INVALID_ARGUMENTS", `${inline !== undefined ? "--args" : "--args-file"} must contain a JSON object.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ClientError("INVALID_ARGUMENTS", `${inline !== undefined ? "--args" : "--args-file"} must contain a JSON object.`);
  return parsed as Record<string, unknown>;
}

function toolError(result: CallToolResult, name: string, context: CommandContext): ClientError {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured?.code === UPSTREAM_AUTH_CODE) {
    return new ClientError("UPSTREAM_AUTH_REQUIRED", `MCP server "${String(structured.server)}" needs your authorization. Open the URL, sign in, then retry.`, {
      server: structured.server, authorizationUrl: structured.authorizationUrl, expiresAt: structured.expiresAt,
    }, [{ description: "Retry after signing in", command: ["frs", ...context.argv.map(quote)].join(" ") }]);
  }
  // The proxy reports governance failures as error results carrying the JSON-RPC code in _meta.
  const governance = (result._meta as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  if (governance && typeof governance.code === "number") {
    const mapped = toClientError(new McpError(governance.code, typeof governance.message === "string" ? governance.message : textOf(result)));
    if (mapped.code !== "PROTOCOL_ERROR") return new ClientError(mapped.code, mapped.message, { tool: name });
  }
  const output = renderContent(result);
  return new ClientError("TOOL_ERROR", truncate(textOf(result) || `Tool ${name} returned an error.`, 500), { content: result.content, ...(structured ? { structuredContent: structured } : {}), ...(context.global.json ? {} : { output }) });
}

export function renderContent(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "image" || item.type === "audio") parts.push(`[${item.type}: ${item.mimeType}, ${Buffer.from(item.data, "base64").length} bytes]`);
    else if (item.type === "resource_link") parts.push(`[resource: ${item.uri}]`);
    else if (item.type === "resource") parts.push("text" in item.resource ? String(item.resource.text) : `[resource: ${item.resource.uri}${item.resource.mimeType ? ` (${item.resource.mimeType})` : ""}]`);
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join("\n");
}

async function requireTool(tool: Tool | undefined, name: string): Promise<Tool> {
  if (tool) return tool;
  throw new ClientError("NOT_FOUND", `Tool "${name}" is not visible to this identity.`, { tool: name }, [{ description: "Search visible tools", command: `frs tools search ${quote(name.split("__").pop() ?? name)}` }]);
}

function summary(tool: Tool, compact: boolean): Record<string, unknown> {
  const server = serverOf(tool.name) ?? null;
  if (compact) return { name: tool.name, server, description: truncate(firstSentence(tool.description ?? tool.title ?? ""), 120) };
  return { name: tool.name, server, ...(tool.title ? { title: tool.title } : {}), ...(tool.description ? { description: tool.description } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) };
}

function argumentSummary(tool: Tool): Array<{ name: string; type: string; required: boolean; description?: string }> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: unknown; description?: string }>;
  const required = new Set(tool.inputSchema.required ?? []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: Array.isArray(schema.type) ? schema.type.join("|") : typeof schema.type === "string" ? schema.type : "any",
    required: required.has(name),
    ...(schema.description ? { description: schema.description } : {}),
  }));
}

function firstSentence(text: string): string {
  const match = text.match(/^(.+?[.!?])(\s|$)/s);
  return match ? match[1]! : text;
}

function schemaAction(name: string): NextAction {
  return { description: "Inspect the input schema", command: `frs tools schema ${name} --input --json` };
}

function pageFooter(total: number, shown: number, nextCursor: string | null): string {
  return `${shown} of ${total} tools${nextCursor ? ` — next page: --cursor ${nextCursor}` : ""}`;
}
