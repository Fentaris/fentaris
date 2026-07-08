import { McpProxy, type McpProxyOptions } from "../proxy/index.js";
import { resolveFentarisConfig } from "../config/resolve.js";
import { assertValidFentarisConfig } from "../config/index.js";
import { fromProxyToolName } from "../nameMapping.js";
import { StdioTransport } from "../transports/index.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedSubject, UserContext } from "../types/index.js";

export type AgentJsonWarning = {
  code: string;
  message: string;
  mcp?: string;
  selector?: string;
  details?: Record<string, unknown>;
};

export type AgentJsonNextAction = {
  label: string;
  command?: string;
  reason?: string;
};

export type AgentPagination = {
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  returned: number;
  truncated?: boolean;
};

export type AgentJsonSuccess<TData> = {
  ok: true;
  data: TData;
  pagination?: AgentPagination;
  warnings: AgentJsonWarning[];
  nextActions: AgentJsonNextAction[];
};

export type AgentJsonFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  warnings: AgentJsonWarning[];
  nextActions: AgentJsonNextAction[];
};

export type AgentJsonEnvelope<TData> = AgentJsonSuccess<TData> | AgentJsonFailure;

export type ToolDiscoveryOptions = {
  mcp?: string;
  selector?: string;
  compact?: boolean;
  limit?: number;
  cursor?: string;
  maxTokens?: number;
  include?: string[];
  exclude?: string[];
  refresh?: boolean;
  noStart?: boolean;
};

export type CompactToolMetadata = {
  name: string;
  mcp: string;
  upstreamName: string;
  title?: string;
  description?: string;
  available: boolean;
  authStatus: AuthStatus;
  schema: {
    input: "available" | "unavailable";
    output: "available" | "unavailable";
  };
  discovery: DiscoveryMetadata;
};

export type DetailedToolMetadata = CompactToolMetadata & {
  inputSchema?: unknown;
  outputSchema?: unknown;
  sideEffects?: Record<string, unknown>;
};

export type SchemaInspection = {
  name: string;
  mcp: string;
  upstreamName: string;
  input?: { available: boolean; schema?: unknown };
  output?: { available: boolean; schema?: unknown };
};

export type AuthStatus = "authenticated" | "requires-login" | "unsupported" | "blocked";

export type DiscoveryMetadata = {
  transportKind: "stdio" | "custom";
  cacheStatus: "not-used" | "refreshed";
  startupStatus: "started-or-reused" | "not-started" | "not-required";
  refreshed: boolean;
};

type Tool = ListToolsResult["tools"][number];
type ListedTool = { tool: Tool; compact: CompactToolMetadata; detailed: DetailedToolMetadata };

export class ToolDiscoveryError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly warnings: AgentJsonWarning[];
  readonly nextActions: AgentJsonNextAction[];

  constructor(code: string, message: string, options: {
    details?: Record<string, unknown>;
    warnings?: AgentJsonWarning[];
    nextActions?: AgentJsonNextAction[];
  } = {}) {
    super(message);
    this.name = "ToolDiscoveryError";
    this.code = code;
    this.details = options.details;
    this.warnings = options.warnings ?? [];
    this.nextActions = options.nextActions ?? [];
  }
}

export class AgentToolDiscoveryService {
  private readonly config: McpProxyOptions;

  constructor(config: McpProxyOptions) {
    assertValidFentarisConfig(config);
    this.config = config;
  }

  async list(options: ToolDiscoveryOptions = {}): Promise<AgentJsonEnvelope<CompactToolMetadata[] | DetailedToolMetadata[]>> {
    return this.wrapCollection(options, async () => {
      const tools = await this.collect(options);
      return tools.map((entry) => options.compact === false ? entry.detailed : entry.compact);
    });
  }

  async search(query: string, options: ToolDiscoveryOptions = {}): Promise<AgentJsonEnvelope<CompactToolMetadata[] | DetailedToolMetadata[]>> {
    const normalized = query.trim().toLowerCase();
    return this.wrapCollection(options, async () => {
      const tools = await this.collect(options);
      return tools
        .filter((entry) => [entry.compact.name, entry.compact.upstreamName, entry.compact.description, entry.compact.title].some((value) => value?.toLowerCase().includes(normalized)))
        .map((entry) => options.compact === false ? entry.detailed : entry.compact);
    }, [
      { label: "Inspect a matched tool", command: "fentaris tools get <tool> --json" },
    ]);
  }

  async get(toolName: string, options: ToolDiscoveryOptions = {}): Promise<AgentJsonEnvelope<DetailedToolMetadata>> {
    return this.wrap(async () => {
      const tool = (await this.collect(options)).find((entry) => entry.compact.name === toolName);
      if (!tool) {
        throw new ToolDiscoveryError("FENTARIS_TOOL_NOT_FOUND", `Tool "${toolName}" was not found for the selected context.`, {
          nextActions: [{ label: "Search available tools", command: "fentaris tools search <query> --json" }],
        });
      }
      return success(tool.detailed, [], [{ label: "Inspect schemas", command: `fentaris tools schema ${toolName} --input --output --json` }]);
    });
  }

  async schema(toolName: string, options: ToolDiscoveryOptions & { input?: boolean; output?: boolean } = {}): Promise<AgentJsonEnvelope<SchemaInspection>> {
    return this.wrap(async () => {
      const tool = (await this.collect(options)).find((entry) => entry.compact.name === toolName);
      if (!tool) {
        throw new ToolDiscoveryError("FENTARIS_TOOL_NOT_FOUND", `Tool "${toolName}" was not found for the selected context.`);
      }
      const includeInput = options.input === true;
      const includeOutput = options.output === true;
      return success({
        name: tool.compact.name,
        mcp: tool.compact.mcp,
        upstreamName: tool.compact.upstreamName,
        ...(includeInput ? { input: { available: tool.detailed.inputSchema !== undefined, ...(tool.detailed.inputSchema !== undefined ? { schema: tool.detailed.inputSchema } : {}) } } : {}),
        ...(includeOutput ? { output: { available: tool.detailed.outputSchema !== undefined, ...(tool.detailed.outputSchema !== undefined ? { schema: tool.detailed.outputSchema } : {}) } } : {}),
      }, [], []);
    });
  }

  authList(): AgentJsonEnvelope<Array<{ mcp: string; default: string; allowed: string[]; statuses: Array<{ selector: string; status: AuthStatus }> }>> {
    return success(Object.entries(this.config.cli?.mcpAccounts ?? {}).map(([mcp, account]) => ({
      mcp,
      default: account.default,
      allowed: [...account.allowed],
      statuses: account.allowed.map((selector) => ({ selector, status: this.authStatus(mcp, selector) })),
    })), [], [{ label: "Inspect one account", command: "fentaris tools auth status --mcp <mcp> --as <selector> --json" }]);
  }

  authStatus(mcp: string, selector: string): AuthStatus {
    const account = this.config.cli?.mcpAccounts?.[mcp];
    if (!account || !account.allowed.includes(selector)) {
      return "blocked";
    }
    const server = resolveFentarisConfig(this.config).serverBindings.find((binding) => binding.server.name === mcp)?.server;
    if (!server) {
      return "unsupported";
    }
    const needsAuth = server.getCredentialBindings().length > 0 || Boolean(this.config.auth?.getBinding(mcp));
    return needsAuth ? "requires-login" : "authenticated";
  }

  authStatusEnvelope(mcp: string, selector: string): AgentJsonEnvelope<{ mcp: string; selector: string; status: AuthStatus; allowed: string[] }> {
    const account = this.config.cli?.mcpAccounts?.[mcp];
    if (!account || !account.allowed.includes(selector)) {
      return failure("FENTARIS_AUTH_SELECTOR_NOT_ALLOWED", `Selector "${selector}" is not configured for MCP "${mcp}".`, {
        allowed: account?.allowed ?? [],
      }, [], [{ label: "List configured auth accounts", command: "fentaris tools auth list --json" }]);
    }
    return success({ mcp, selector, status: this.authStatus(mcp, selector), allowed: [...account.allowed] }, [], []);
  }

  authLogin(mcp: string, selector: string): AgentJsonEnvelope<{ mcp: string; selector: string; status: AuthStatus; loginMode: "delegated"; instructions: string }> {
    const status = this.authStatusEnvelope(mcp, selector);
    if (!status.ok) {
      return status;
    }
    return success({
      mcp,
      selector,
      status: status.data.status,
      loginMode: "delegated",
      instructions: "Complete provider-specific login or store the required credential with `fentaris secrets set`.",
    }, [], [{ label: "Store a credential", command: "fentaris secrets set <reference>" }]);
  }

  private async collect(options: ToolDiscoveryOptions): Promise<ListedTool[]> {
    const resolved = resolveFentarisConfig(this.config);
    const selectedServers = resolved.serverBindings
      .map((binding) => binding.server)
      .filter((server, index, servers) => servers.indexOf(server) === index)
      .filter((server) => !options.mcp || server.name === options.mcp);
    if (options.mcp && selectedServers.length === 0) {
      throw new ToolDiscoveryError("FENTARIS_MCP_NOT_FOUND", `MCP "${options.mcp}" is not configured.`);
    }

    const stdioBlocked = options.noStart === true ? selectedServers.find((server) => server.transport instanceof StdioTransport) : undefined;
    if (stdioBlocked) {
      throw new ToolDiscoveryError("FENTARIS_MCP_STDIO_NOT_STARTED", `MCP "${stdioBlocked.name}" uses stdio and --no-start prevents discovery startup.`, {
        warnings: [{ code: "FENTARIS_MCP_STDIO_NOT_STARTED", message: "Discovery was skipped because process startup is disabled.", mcp: stdioBlocked.name }],
        nextActions: [{ label: "Run discovery with startup", command: `fentaris tools list --mcp ${stdioBlocked.name} --json` }],
      });
    }

    const primaryMcp = options.mcp ?? selectedServers[0]?.name;
    const selector = primaryMcp ? this.resolveSelector(primaryMcp, options.selector) : options.selector;
    const context = selectorToContext(selector);
    const result = await new McpProxy(this.config).listTools(undefined, context.user, { authenticated: selector !== undefined, userId: context.user.id }, context.subject);
    const selectedNames = new Set(selectedServers.map((server) => server.name));
    const tools = result.tools
      .map((tool) => this.toListedTool(tool, selector, options.refresh === true))
      .filter((entry) => selectedNames.has(entry.compact.mcp));

    return applyFilters(tools, options);
  }

  private resolveSelector(mcp: string, requested: string | undefined): string | undefined {
    const account = this.config.cli?.mcpAccounts?.[mcp];
    if (!account) {
      return requested;
    }
    const selector = requested ?? account.default;
    if (!account.allowed.includes(selector)) {
      throw new ToolDiscoveryError("FENTARIS_AUTH_SELECTOR_NOT_ALLOWED", `Selector "${selector}" is not configured for MCP "${mcp}".`, {
        details: { mcp, selector, allowed: account.allowed },
        nextActions: [{ label: "List configured auth accounts", command: "fentaris tools auth list --json" }],
      });
    }
    return selector;
  }

  private toListedTool(tool: Tool, selector: string | undefined, refreshed: boolean): ListedTool {
    const { serverName, toolName } = fromProxyToolName(tool.name);
    const outputSchema = (tool as Tool & { outputSchema?: unknown }).outputSchema;
    const discovery = discoveryMetadata(resolveFentarisConfig(this.config).serverBindings.find((binding) => binding.server.name === serverName)?.server?.transport, refreshed);
    const compact: CompactToolMetadata = {
      name: tool.name,
      mcp: serverName,
      upstreamName: toolName,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      available: true,
      authStatus: selector ? this.authStatus(serverName, selector) : "requires-login",
      schema: { input: tool.inputSchema ? "available" : "unavailable", output: outputSchema ? "available" : "unavailable" },
      discovery,
    };
    return {
      tool,
      compact,
      detailed: {
        ...compact,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(outputSchema ? { outputSchema } : {}),
      },
    };
  }

  private async wrapCollection<T>(options: ToolDiscoveryOptions, getData: () => Promise<T[]>, nextActions: AgentJsonNextAction[] = []): Promise<AgentJsonEnvelope<T[]>> {
    return this.wrap(async () => {
      const all = await getData();
      const limit = normalizeLimit(options.limit);
      const start = cursorToOffset(options.cursor);
      let data = all.slice(start, start + limit);
      let truncated = false;
      if (options.maxTokens && estimatedTokens(data) > options.maxTokens) {
        while (data.length > 0 && estimatedTokens(data) > options.maxTokens) {
          data = data.slice(0, -1);
        }
        truncated = true;
      }
      const nextCursor = start + data.length < all.length ? String(start + data.length) : null;
      return success(data, [], [
        ...nextActions,
        ...(nextCursor ? [{ label: "Fetch next page", command: `fentaris tools list --cursor ${nextCursor} --json` }] : []),
        ...(truncated ? [{ label: "Narrow the response", command: "fentaris tools search <query> --limit 10 --compact --json", reason: "--max-tokens truncated the response." }] : []),
      ], { limit, cursor: options.cursor ?? null, nextCursor, total: all.length, returned: data.length, ...(truncated ? { truncated } : {}) });
    });
  }

  private async wrap<T>(run: () => Promise<AgentJsonEnvelope<T>>): Promise<AgentJsonEnvelope<T>> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ToolDiscoveryError) {
        return failure(error.code, error.message, error.details, error.warnings, error.nextActions);
      }
      return failure("FENTARIS_TOOL_DISCOVERY_FAILED", error instanceof Error ? error.message : String(error), undefined, [], []);
    }
  }
}

export function success<T>(data: T, warnings: AgentJsonWarning[], nextActions: AgentJsonNextAction[], pagination?: AgentPagination): AgentJsonSuccess<T> {
  return { ok: true, data, ...(pagination ? { pagination } : {}), warnings, nextActions };
}

export function failure(code: string, message: string, details: Record<string, unknown> | undefined, warnings: AgentJsonWarning[], nextActions: AgentJsonNextAction[]): AgentJsonFailure {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) }, warnings, nextActions };
}

function selectorToContext(selector: string | undefined): { user: UserContext; subject?: ResolvedSubject } {
  if (!selector) {
    return { user: {} };
  }
  if (selector.startsWith("user:")) {
    return { user: { id: selector.slice("user:".length) } };
  }
  const groupId = selector.slice("group:".length);
  return {
    user: { id: selector },
    subject: {
      id: selector,
      groups: [{ id: groupId }],
      hasGroup: (candidate) => candidate === groupId,
    },
  };
}

function discoveryMetadata(transport: unknown, refreshed: boolean): DiscoveryMetadata {
  const stdio = transport instanceof StdioTransport;
  return {
    transportKind: stdio ? "stdio" : "custom",
    cacheStatus: refreshed ? "refreshed" : "not-used",
    startupStatus: stdio ? "started-or-reused" : "not-required",
    refreshed,
  };
}

function applyFilters(tools: ListedTool[], options: ToolDiscoveryOptions): ListedTool[] {
  return tools.filter((entry) => {
    const haystack = `${entry.compact.name} ${entry.compact.description ?? ""} ${entry.compact.title ?? ""}`;
    return (options.include ?? []).every((pattern) => haystack.includes(pattern))
      && !(options.exclude ?? []).some((pattern) => haystack.includes(pattern));
  });
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return 20;
  }
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function cursorToOffset(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
