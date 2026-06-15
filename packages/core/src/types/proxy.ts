import type {
  CallToolRequest,
  CompleteRequest,
  GetPromptRequest,
  ListPromptsRequest,
  ListResourcesRequest,
  ListResourceTemplatesRequest,
  ListToolsRequest,
  ListToolsResult,
  ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logging/index.js";
import type { HealthCheckResult } from "../health/index.js";
import type { RuntimeEvent } from "../profiler/index.js";
import type {
  CompleteResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult as SdkListToolsResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CredentialSourceMetadata,
  IdentityMetadata,
  MaybePromise,
  PolicyMetadata,
  ResolvedSubject,
  UserContext,
} from "./shared.js";
import type {
  ProxyOperation,
  ProxyOperationResult,
} from "./mcp-operation.js";
import type {
  LifecycleHookContext,
  Middleware,
  MiddlewareContext,
  ProxyMiddleware,
  ResponseController,
} from "./middleware.js";
import type { Policy, PolicyDecision } from "./policy.js";
import type { McpServerOptions } from "../server/index.js";

/**
 * Safe downstream transport metadata attached to a proxy operation.
 * @pk
 */
export type ProxyTransportContext = {
  type?: "http" | "stdio" | "sse" | "unknown";
  sessionId?: string;
  requestId?: string;
};

/**
 * Normalized authentication metadata exposed through the unified context.
 * @pk
 */
export type ProxyAuthContext = {
  strategy?: string;
  authenticated: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Structured policy metadata exposed through the unified context.
 * @pk
 */
export type ProxyPolicyContext = {
  allowed?: boolean;
  reason?: string;
  matchedGroups: string[];
  matchedPermissions: NonNullable<PolicyMetadata["matchedPermissions"]>;
  metadata?: Record<string, unknown>;
  policy?: Policy;
  decision?: PolicyDecision;
  can(server: string, tool: string): MaybePromise<boolean>;
};

/**
 * Selected upstream server metadata.
 * @pk
 */
export type ProxyServerContext = {
  name: string;
  displayName?: string;
};

/**
 * Selected tool metadata.
 * @pk
 */
export type ProxyToolContext = {
  name: string;
  proxyName: string;
};

/**
 * Selected resource metadata.
 * @pk
 */
export type ProxyResourceContext = {
  uri?: string;
  proxyUri?: string;
  uriTemplate?: string;
  proxyUriTemplate?: string;
};

/**
 * Selected prompt metadata.
 * @pk
 */
export type ProxyPromptContext = {
  name: string;
  proxyName: string;
};

/**
 * Selected completion metadata.
 * @pk
 */
export type ProxyCompletionContext = {
  refType: "ref/prompt" | "ref/resource";
  target: string;
  proxyTarget?: string;
  argumentName: string;
};

/**
 * Unified context for new proxy middleware, routes, and events.
 * @pk
 */
export type ProxyContext = MiddlewareContext & {
  operation: ProxyOperation;
  transport: ProxyTransportContext;
  auth: ProxyAuthContext;
  policy: ProxyPolicyContext;
  credentials: {
    sources: CredentialSourceMetadata[];
  };
  server?: ProxyServerContext;
  tool?: ProxyToolContext;
  resource?: ProxyResourceContext;
  prompt?: ProxyPromptContext;
  completion?: ProxyCompletionContext;
  args?: CallToolRequest["params"]["arguments"];
  raw?:
    | CallToolRequest["params"]
    | CompleteRequest["params"]
    | GetPromptRequest["params"]
    | ListPromptsRequest["params"]
    | ListResourcesRequest["params"]
    | ListResourceTemplatesRequest["params"]
    | ListToolsRequest["params"]
    | ReadResourceRequest["params"];
  state: Record<string, unknown>;
  response: ResponseController;
  deny(message: string): import("@modelcontextprotocol/sdk/types.js").CallToolResult;
  fail(code: number, message: string): import("@modelcontextprotocol/sdk/types.js").CallToolResult;
  continue(): undefined;
  inject(message: string): void;
  error(code: number, message: string): import("@modelcontextprotocol/sdk/types.js").CallToolResult;
};

/**
 * Express-like tool route handler signature.
 * @pk
 */
export type ProxyToolHandler = ProxyMiddleware;

/**
 * Express-like handler for a governed MCP operation route.
 * @pk
 */
export type ProxyOperationHandler = ProxyMiddleware;

/**
 * Public tool pattern using `server.tool` dot notation and `*` wildcards.
 * @pk
 */
export type ProxyToolPattern = string;

/**
 * Unified event names emitted by the proxy runtime.
 * @pk
 */
export type ProxyEventName =
  | "session:start"
  | "session:end"
  | "tools:list:after"
  | "tool:start"
  | "tool:success"
  | "tool:error"
  | "tool:after"
  | "resource:start"
  | "resource:success"
  | "resource:error"
  | "resource:after"
  | "prompt:start"
  | "prompt:success"
  | "prompt:error"
  | "prompt:after"
  | "completion:start"
  | "completion:success"
  | "completion:error"
  | "completion:after";

/**
 * Filter for unified proxy events.
 * @pk
 */
export type ProxyEventFilter = {
  server?: string;
  group?: string;
  tool?: string;
  proxyTool?: string;
};

/**
 * Unified event payload.
 * @pk
 */
export type ProxyEventPayload = {
  ctx: ProxyContext;
  tools?: ListToolsResult["tools"];
  result?: ProxyOperationResult;
  error?: Error;
  durationMs?: number;
  success?: boolean;
};

/**
 * Unified event handler.
 * @pk
 */
export type ProxyEventHandler = (
  payload: ProxyEventPayload,
) => MaybePromise<ListToolsResult["tools"] | SdkListToolsResult | void>;

/**
 * Scoped upstream MCP handle returned by `proxy.mcp(name)`.
 * @pk
 */
export type ProxyMcpHandle = {
  readonly name: string;
  use(handler: Middleware): ProxyMcpHandle;
  tool(pattern: ProxyToolPattern, handler: ProxyToolHandler): ProxyMcpHandle;
  operation(operation: ProxyOperation, handler: ProxyOperationHandler): ProxyMcpHandle;
  on(eventName: ProxyEventName, handler: ProxyEventHandler): ProxyMcpHandle;
  on(eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): ProxyMcpHandle;
  ping(): Promise<HealthCheckResult>;
  health(): Promise<HealthCheckResult>;
};

/**
 * Scoped group handle returned by `proxy.group(id)`.
 * @pk
 */
export type ProxyGroupHandle = {
  readonly id: string;
  mcp(name: string): ProxyMcpHandle;
  use(handler: Middleware): ProxyGroupHandle;
  operation(operation: ProxyOperation, handler: ProxyOperationHandler): ProxyGroupHandle;
  on(eventName: ProxyEventName, handler: ProxyEventHandler): ProxyGroupHandle;
  on(eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): ProxyGroupHandle;
};

/**
 * Active downstream proxy exposure handle.
 * @pk
 */
export type ProxyExposureHandle = {
  close(): Promise<void>;
};

/**
 * Runtime operations shared by downstream proxy exposure transports.
 * @pk
 */
export type ProxyRuntime = {
  createSdkServer(user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): unknown;
  resolveHttpUser(request: unknown): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }>;
  resolveStdioUser(): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }>;
  emitSessionStart(context: LifecycleHookContext): Promise<void>;
  emitSessionEnd(context: LifecycleHookContext): Promise<void>;
  emitRuntimeEvent(event: RuntimeEvent): Promise<void>;
  logger: Logger;
  identityRequired: boolean;
};

/**
 * Options for declaring an upstream MCP server through `proxy.mcp(name, options)`.
 * @pk
 */
export type ProxyMcpDeclarationOptions = Omit<McpServerOptions, "name">;

/**
 * Config object for declaring an upstream MCP server through `proxy.mcp(config)`.
 * @pk
 */
export type ProxyMcpDeclarationConfig = McpServerOptions;

/**
 * Transport interface for exposing the Fentaris proxy to downstream MCP clients.
 * @pk
 */
export type ProxyExposureTransport<THandle extends ProxyExposureHandle = ProxyExposureHandle> = {
  listen(runtime: ProxyRuntime): Promise<THandle>;
};
