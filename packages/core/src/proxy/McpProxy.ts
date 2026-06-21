import { existsSync, readFileSync } from "node:fs";
import { type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer } from "node:http";
import path from "node:path";
import { compileToolPattern, matchesToolPattern, type RouteEntry } from "./routes.js";
import { createContextualLogger, createProxyContext, createPolicyCan, createCapabilityContext } from "./context.js";
import { isCapabilityAllowed } from "./capabilities.js";
import { dispatchRouteHandler } from "./middleware.js";
import { routeCompletion, completionTarget, capabilityToolRequest, isStructuredPolicyErrorResult, toStructuredError } from "./operations.js";
import { operationEventName, matchesCallHook, matchesEventFilter, dispatchCallHooks, emitProxyEvent, type EventEntry } from "./events.js";
import { emitLifecycle } from "./lifecycle.js";
import { createSdkServer } from "./sdkServer.js";
import { ServerCatalog } from "./serverCatalog.js";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type CompleteRequest,
  type CompleteResult,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsRequest,
  type ListPromptsResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ListResourceTemplatesRequest,
  type ListResourceTemplatesResult,
  type ListToolsRequest,
  type ListToolsResult,
  type ReadResourceRequest,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { DefaultErrorMapper, FentarisErrorCode } from "../errors.js";
import { Logger } from "../logger.js";
import {
  FentarisExtensionError,
  FentarisMcpError,
  FentarisPolicyError,
  FentarisRuntimeError,
  FentarisTimeoutError,
  FentarisTransportError,
  RuntimeProfiler,
  createRuntimeEvent,
  normalizeRuntimeProfiler,
  runtimeErrorToEventPayload,
  type RuntimeEvent,
  type RuntimeProfilerConfig,
} from "../profiler/index.js";
import {
  RuntimeLifecycleController,
  normalizeRuntimeLifecycleOptions,
  type RuntimeLifecycleOptions,
  type RuntimeLifecycleSnapshot,
  type RuntimeLifecycleTransition,
} from "../lifecycle/index.js";
import {
  normalizeHealthConfig,
  runHealthChecks,
  type HealthCheckResult,
  type HealthConfig,
  type HealthReport,
  type NormalizedHealthConfig,
} from "../health/index.js";
import { McpServer, type McpServerOptions, type ServerCredentialBinding } from "../server/McpServer.js";
import {
  fromProxyPromptName,
  fromProxyResourceTemplateUri,
  fromProxyResourceUri,
  fromProxyToolName,
  toProxyPromptName,
  toProxyResourceTemplateUri,
  toProxyResourceUri,
  toProxyToolName,
} from "../nameMapping.js";
import { filterToolsByPolicy, getToolPermission } from "../policy.js";
import { getCapabilityPermission, toCapabilityPermissions, toCapabilityRequest } from "../policy.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { FentarisAuth } from "../auth.js";
import { resolveCredentialSource, type CredentialSourceMap } from "../credentials/index.js";
import {
  buildSubjectIndex,
  evaluateGroupPolicies,
  filterToolsByGroupPolicies,
  Group as GovernanceGroup,
  Policy as GovernancePolicy,
  type Group,
  type SubjectIndex,
  type User,
} from "../governance.js";
import { HttpProxyExposureTransport } from "../transports/exposure/HttpProxyExposureTransport.js";
import { ResponseController } from "../types/middleware.js";
import { FentarisConfigError, assertValidFentarisConfig, validateFentarisConfig, type FentarisDiagnostic } from "../config/index.js";
import { resolveFentarisConfig } from "../config/resolve.js";
import type { CapabilityOperationRequest, ToolCallRequest } from "../types/mcp-operation.js";
import type { CredentialSourceMetadata, IdentityMetadata, ResolvedSubject, UserContext } from "../types/shared.js";
import type {
  ListToolsHook,
  Middleware,
  MiddlewareContext,
  LegacyMiddleware,
  LifecycleHook,
  LifecycleHookEvent,
  ProxyHookEvent,
  ProxyMiddleware,
  ToolCallHook,
  ToolCallHookFilter,
} from "../types/middleware.js";
import type { ProxyOperationResult } from "../types/mcp-operation.js";
import type { CapabilityPermission, ErrorMapper, IdentityStrategy, Policy, PolicyDecision, RateLimiter, Registry } from "../types/policy.js";
import type {
  ProxyContext,
  ProxyEventFilter,
  ProxyEventHandler,
  ProxyEventName,
  ProxyExposureHandle,
  ProxyExposureTransport,
  ProxyRuntime,
  ProxyGroupHandle,
  ProxyMcpDeclarationConfig,
  ProxyMcpDeclarationOptions,
  ProxyMcpHandle,
  ProxyOperationHandler,
  ProxyToolHandler,
  ProxyToolPattern,
} from "../types/proxy.js";

type ProjectRuntimeDefaults = {
  port?: number;
  host?: string;
  path?: string;
};

function readProjectRuntimeDefaults(fromDir: string = process.cwd()): ProjectRuntimeDefaults {
  let current = path.resolve(fromDir);

  while (true) {
    const defaults = readProjectRuntimeDefaultsFile(path.join(current, "fentaris.json"))
      ?? readProjectRuntimeDefaultsFile(path.join(current, "fentaris.config.json"));
    if (defaults) {
      return defaults;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return {};
    }
    current = parent;
  }
}

function readProjectRuntimeDefaultsFile(configPath: string): ProjectRuntimeDefaults | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return {
      ...(typeof config.port === "number" ? { port: config.port } : {}),
      ...(typeof config.host === "string" ? { host: config.host } : {}),
      ...(typeof config.path === "string" ? { path: config.path } : {}),
    };
  } catch {
    return {};
  }
}

class PolicyDeniedError extends Error {
  readonly code: number;
  readonly context?: ProxyContext;

  constructor(message: string, code: number = FentarisErrorCode.PolicyDenied, context?: ProxyContext) {
    super(message);
    this.code = code;
    this.context = context;
    this.name = "PolicyDeniedError";
  }
}

type FluentGroupDeclaration = {
  id: string;
  users: User[];
  policy?: string | Policy;
};

/**
 * Options for creating an MCP proxy server.
 * @pk
 */
export type McpProxyOptions = {
  servers?: McpServer[];
  port?: number;
  host?: string;
  path?: string;
  logger?: Logger;
  user?: UserContext | ((request: IncomingMessage) => UserContext | Promise<UserContext>);
  identity?: IdentityStrategy | IdentityResolverOptions;
  policy?: Policy;
  groups?: Group[];
  defaults?: {
    credentials?: CredentialSourceMap;
  };
  auth?: FentarisAuth;
  registry?: Registry;
  autoLog?: boolean | AutoLogOptions;
  profiler?: RuntimeProfilerConfig;
  lifecycle?: RuntimeLifecycleOptions;
  health?: HealthConfig;
  errorMapper?: ErrorMapper;
  name?: string;
  version?: string;
};

/**
 * Auto-log configuration for proxied tool calls.
 * @pk
 */
export type AutoLogOptions = {
  enabled?: boolean;
  startLevel?: "debug" | "info";
  successLevel?: "debug" | "info";
  failureLevel?: "warn" | "error";
};

/**
 * Identity resolver configuration for proxy-edge auth.
 * @pk
 */
export type IdentityResolverOptions = {
  strategy: IdentityStrategy;
  required?: boolean;
};

/**
 * Optional start overrides for the MCP proxy.
 * @pk
 */
export type McpProxyStartOptions = {
  port?: number;
  host?: string;
  path?: string;
  startupTimeoutMs?: number;
};

/**
 * Optional stop overrides for the MCP proxy.
 * @pk
 */
export type McpProxyStopOptions = {
  shutdownTimeoutMs?: number;
};


/**
 * HTTP proxy for multiple MCP servers.
 * @pk
 */
export class McpProxy {
  private readonly servers: McpServer[];
  private readonly serverCatalog: ServerCatalog;
  private readonly serverByName = new Map<string, McpServer>();
  private readonly middleware: Middleware[] = [];
  private readonly routes: RouteEntry[] = [];
  private readonly callHooks: Array<{ filter: ToolCallHookFilter; handler: ToolCallHook }> = [];
  private readonly eventHandlers: EventEntry[] = [];
  private readonly lifecycleHooks: LifecycleHook[] = [];
  private readonly listToolsHooks: ListToolsHook[] = [];
  private readonly logger: Logger;
  private readonly userResolver?: McpProxyOptions["user"];
  private identityOptions?: IdentityResolverOptions;
  private readonly usesDeclaredApiKeyIdentity: boolean;
  private globalPolicy?: Policy;
  private readonly configuredGroups: Group[];
  private groups: Group[];
  private readonly defaultCredentials: CredentialSourceMap;
  private subjectIndex?: SubjectIndex;
  private readonly auth?: FentarisAuth;
  private readonly registry?: Registry;
  private readonly autoLog: Required<AutoLogOptions> | null;
  private readonly profiler: RuntimeProfiler;
  private readonly lifecycle: RuntimeLifecycleController;
  private readonly lifecycleDefaults: ReturnType<typeof normalizeRuntimeLifecycleOptions>;
  private readonly healthConfig: NormalizedHealthConfig;
  private readonly errorMapper: ErrorMapper;
  private readonly name: string;
  private readonly version: string;
  private readonly defaultPort?: number;
  private readonly defaultHost?: string;
  private readonly defaultPath: string;
  private runtimeValidationConfig: McpProxyOptions;
  private readonly namedPolicies = new Map<string, GovernancePolicy>();
  private readonly fluentGroups = new Map<string, FluentGroupDeclaration>();
  private httpServer: HttpServer | null = null;
  private readonly exposureHandles = new Set<ProxyExposureHandle>();

  /**
   * Create a new MCP proxy instance.
   * @pk
   */
  constructor(options: McpProxyOptions = {}) {
    const resolved = resolveFentarisConfig(options);
    this.servers = resolved.servers;
    this.logger = options.logger ?? new Logger();
    this.userResolver = options.user;
    this.auth = options.auth;
    this.globalPolicy = options.policy;
    this.configuredGroups = resolved.groups;
    this.groups = resolved.groups;
    this.defaultCredentials = resolved.defaults.credentials;
    const configuredIdentity = options.identity ?? options.auth?.identityStrategy();
    this.usesDeclaredApiKeyIdentity = configuredIdentity === undefined;
    this.identityOptions = normalizeIdentityOptions(
      configuredIdentity ?? declaredApiKeyIdentityStrategy(() => this.groups),
      Boolean(options.auth) || hasDeclaredApiKeys(this.groups),
    );
    this.subjectIndex = resolved.subjectIndex;
    this.serverCatalog = new ServerCatalog({ servers: this.servers, groups: this.groups, subjectIndex: this.subjectIndex });
    this.registry = options.registry;
    this.autoLog = normalizeAutoLog(options.autoLog);
    this.profiler = new RuntimeProfiler(options.profiler === undefined ? null : normalizeRuntimeProfiler(options.profiler, this.logger));
    this.lifecycleDefaults = normalizeRuntimeLifecycleOptions(options.lifecycle);
    this.healthConfig = normalizeHealthConfig(options.health);
    this.errorMapper = options.errorMapper ?? new DefaultErrorMapper();
    this.name = options.name ?? "fentaris-core-proxy";
    this.version = options.version ?? "0.1.0";
    this.lifecycle = new RuntimeLifecycleController({
      name: this.name,
      version: this.version,
      defaults: this.lifecycleDefaults,
      onTransition: (transition) => this.emitLifecycleTransition(transition),
    });
    const projectDefaults = readProjectRuntimeDefaults();
    this.defaultPort = options.port ?? projectDefaults.port;
    this.defaultHost = options.host;
    this.defaultPath = options.path ?? projectDefaults.path ?? "/mcp";
    this.runtimeValidationConfig = {
      ...options,
      servers: this.servers,
      groups: this.groups,
      defaults: { credentials: this.defaultCredentials },
    };

    for (const server of this.serverCatalog.allServers()) {
      this.serverByName.set(server.name, server);
    }
  }

  /**
   * Register a middleware handler.
   * @pk
   */
  use(middleware: Middleware): this {
    this.middleware.push(middleware);
    this.routes.push({ kind: "middleware", handler: middleware });
    return this;
  }

  /**
   * Register a global tool route with a public server.tool pattern.
   * @pk
   */
  tool(pattern: ProxyToolPattern, handler: ProxyToolHandler): this {
    this.routes.push({ kind: "tool", pattern: compileToolPattern(pattern), handler });
    return this;
  }

  /**
   * Register a global operation route for governed non-tool operations.
   * @pk
   */
  operation(operation: ProxyContext["operation"], handler: ProxyOperationHandler): this {
    this.routes.push({ kind: "operation", operation, handler });
    return this;
  }

  /**
   * Register or retrieve a named app-level policy declaration.
   * @pk
   */
  policy(name: string): GovernancePolicy {
    const existing = this.namedPolicies.get(name);
    if (existing) {
      return existing;
    }

    const declared = new GovernancePolicy({ name });
    this.namedPolicies.set(name, declared);
    this.refreshDerivedGovernanceState({ validate: false });
    return declared;
  }

  /**
   * Apply a named or concrete policy as the global proxy policy.
   * @pk
   */
  usePolicy(policyNameOrPolicy: string | Policy): this {
    const resolvedPolicy = typeof policyNameOrPolicy === "string"
      ? this.namedPolicies.get(policyNameOrPolicy)
      : policyNameOrPolicy;

    if (!resolvedPolicy) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_GLOBAL_POLICY_UNKNOWN",
          title: "Global policy references an unknown policy",
          message: `Global policy references policy "${policyNameOrPolicy}", but no app-level policy with that name exists.`,
          path: ["proxy", "policy"],
          hint: "Declare the named policy with app.policy(name) before calling app.usePolicy(name), or pass a concrete policy instance.",
        },
      ]);
    }

    this.globalPolicy = resolvedPolicy;
    this.refreshDerivedGovernanceState({ validate: false });
    return this;
  }

  /**
   * Register or retrieve a scoped upstream MCP handle.
   * @pk
   */
  mcp(name: string): ProxyMcpHandle;
  mcp(name: string, options: ProxyMcpDeclarationOptions): ProxyMcpHandle;
  mcp(name: string, server: McpServer): ProxyMcpHandle;
  mcp(config: ProxyMcpDeclarationConfig): ProxyMcpHandle;
  mcp(
    nameOrConfig: string | ProxyMcpDeclarationConfig,
    optionsOrServer?: ProxyMcpDeclarationOptions | McpServer,
  ): ProxyMcpHandle {
    const name = typeof nameOrConfig === "string" ? nameOrConfig : nameOrConfig.name;
    const declaration = typeof nameOrConfig === "string" ? optionsOrServer : nameOrConfig;
    if (declaration) {
      const server = declaration instanceof McpServer
        ? declaration
        : new McpServer({ ...(declaration as Omit<McpServerOptions, "name">), name });
      if (server.name !== name) {
        throw new Error(`MCP handle "${name}" cannot register MCP server "${server.name}"`);
      }
      if (!this.serverByName.has(name)) {
        this.servers.push(server);
        this.serverCatalog.addGlobalServer(server);
        this.serverByName.set(name, server);
      }
    }

    if (!declaration && !this.serverByName.has(name)) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_HANDLE_UNKNOWN_SERVER",
          title: "Scoped MCP handle references an unknown upstream",
          message: `MCP handle "${name}" does not match a configured upstream MCP server.`,
          path: ["proxy", "mcp", name],
          hint: "Configure the upstream first or pass MCP options when registering the handle.",
        },
      ]);
    }

    return new McpProxyMcpHandle(this, name);
  }

  /**
   * Register or retrieve a scoped group handle.
   * @pk
   */
  group(groupId: string): ProxyGroupHandle {
    this.fluentGroup(groupId);
    return new McpProxyGroupHandle(this, groupId);
  }

  /**
   * Register an event hook.
   * @pk
   */
  on(event: "call", handler: ToolCallHook): this;
  /**
   * Register a filtered event hook.
   * @pk
   */
  on(event: "call", filter: ToolCallHookFilter, handler: ToolCallHook): this;
  /**
   * Register a unified proxy event handler.
   * @pk
   */
  on(event: ProxyEventName, handler: ProxyEventHandler): this;
  /**
   * Register a filtered unified proxy event handler.
   * @pk
   */
  on(event: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): this;
  on(
    event: ProxyHookEvent | ProxyEventName,
    filterOrHandler: ToolCallHookFilter | ToolCallHook | ProxyEventFilter | ProxyEventHandler,
    maybeHandler?: ToolCallHook | ProxyEventHandler,
  ): this {
    if (event !== "call") {
      const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
      const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
      if (!handler) {
        throw new Error(`Missing handler for proxy event "${event}"`);
      }
      this.eventHandlers.push({
        eventName: event,
        filter,
        handler: handler as ProxyEventHandler,
      });
      return this;
    }

    const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`Missing handler for proxy hook event "${event}"`);
    }

    this.callHooks.push({ filter, handler: handler as ToolCallHook });
    return this;
  }

  /**
   * Register a lifecycle hook.
   * @pk
   */
  onLifecycle(event: LifecycleHookEvent, handler: LifecycleHook): this {
    this.lifecycleHooks.push((emittedEvent, context) => {
      if (emittedEvent === event) {
        return handler(emittedEvent, context);
      }

      return undefined;
    });
    return this;
  }

  /**
   * Register a hook that can transform listed tools.
   * @pk
   */
  onListTools(hook: ListToolsHook): this {
    this.listToolsHooks.push(hook);
    return this;
  }

  /**
   * Start the HTTP server.
   * @pk
   */
  async start(onStarted?: () => void): Promise<HttpServer>;
  /**
   * Start the HTTP server with optional overrides.
   * @pk
   */
  async start(options?: McpProxyStartOptions, onStarted?: () => void): Promise<HttpServer>;
  async start(
    optionsOrCallback: McpProxyStartOptions | (() => void) = {},
    onStarted?: () => void,
  ): Promise<HttpServer> {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : onStarted;
    if (this.httpServer) {
      return this.httpServer;
    }
    this.assertRuntimeConfigValid();

    const startedAt = Date.now();
    const result = await this.lifecycle.start(async () => {
      const port = options.port ?? this.defaultPort ?? 3000;
      const host = options.host ?? this.defaultHost;
      const path = options.path ?? this.defaultPath;
      const handle = await this.listenInternal(
        new HttpProxyExposureTransport({
          port,
          host,
          path,
          onStarted: () => {
            this.printStartupBanner(port, path, host);
            callback?.();
          },
        }),
      );
      this.httpServer = handle.server;
      return this.httpServer;
    }, { startupTimeoutMs: options.startupTimeoutMs ?? this.lifecycleDefaults.startupTimeoutMs });

    if (!result && this.httpServer) {
      return this.httpServer;
    }
    if (!result) {
      throw new FentarisRuntimeError("Runtime start completed without an HTTP server", {
        code: "FENTARIS_RUNTIME_START_FAILED",
      });
    }

    await this.emitRuntimeEvent(createRuntimeEvent({
      name: "runtime.ready",
      category: "lifecycle",
      level: "info",
      runtime: this.name,
      version: this.version,
      operation: "runtime:ready",
      startupMs: Date.now() - startedAt,
      durationMs: Date.now() - startedAt,
      metadata: this.state().metadata as unknown as Record<string, unknown>,
      message: "Runtime ready",
    }));
    return result;
  }

  /**
   * Start the proxy with an explicit downstream exposure transport.
   * @pk
   */
  async listen<THandle extends ProxyExposureHandle>(transport: ProxyExposureTransport<THandle>): Promise<THandle> {
    this.assertRuntimeConfigValid();

    const state = this.state().state;
    if (state === "ready" || state === "degraded") {
      return this.listenInternal(transport);
    }
    if (state === "starting") {
      await this.lifecycle.ready({ startupTimeoutMs: this.lifecycleDefaults.startupTimeoutMs });
      return this.listenInternal(transport);
    }

    return this.lifecycle.start(() => this.listenInternal(transport), {
      startupTimeoutMs: this.lifecycleDefaults.startupTimeoutMs,
    }) as Promise<THandle>;
  }

  private async listenInternal<THandle extends ProxyExposureHandle>(transport: ProxyExposureTransport<THandle>): Promise<THandle> {
    try {
      const handle = await transport.listen(this.createRuntime());
      this.exposureHandles.add(handle);
      return handle;
    } catch (error) {
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "transport.error",
        category: "errors",
        level: "error",
        operation: "transport:listen",
        error: runtimeErrorToEventPayload(new FentarisTransportError("Proxy exposure transport failed", { cause: error })),
      }));
      throw error;
    }
  }

  private assertRuntimeConfigValid(): void {
    this.refreshDerivedGovernanceState({ validate: true });
    assertValidFentarisConfig(this.runtimeValidationConfig);
  }

  private assertDeferredPolicyServerVisibilityValid(): void {
    this.refreshDerivedGovernanceState({ validate: true });
    const result = validateFentarisConfig(this.runtimeValidationConfig);
    const policyServerVisibilityErrors = result.errors.filter((error) => error.code === "FENTARIS_CONFIG_POLICY_SERVER_NOT_VISIBLE");
    if (policyServerVisibilityErrors.length > 0) {
      throw new FentarisConfigError(policyServerVisibilityErrors);
    }
  }

  /**
   * Close the HTTP server and all backends.
   * @pk
   */
  async close(): Promise<void> {
    await this.stop();
  }

  /**
   * Wait for the runtime to reach readiness.
   * @pk
   */
  async ready(options?: RuntimeLifecycleOptions): Promise<RuntimeLifecycleSnapshot> {
    return this.lifecycle.ready(options);
  }

  /**
   * Stop the runtime and close owned resources.
   * @pk
   */
  async stop(options: McpProxyStopOptions = {}): Promise<void> {
    const startedAt = Date.now();
    await this.lifecycle.stop(async () => {
      await Promise.all([...this.exposureHandles].map((handle) => handle.close()));
      this.exposureHandles.clear();
      this.httpServer = null;
      await Promise.all(this.serverCatalog.allServers().map((server) => server.close()));
    }, { shutdownTimeoutMs: options.shutdownTimeoutMs ?? this.lifecycleDefaults.shutdownTimeoutMs });
    await this.emitRuntimeEvent(createRuntimeEvent({
      name: "runtime.stop",
      category: "lifecycle",
      level: "info",
      runtime: this.name,
      operation: "runtime:stop",
      durationMs: Date.now() - startedAt,
      metadata: this.state().metadata as unknown as Record<string, unknown>,
      message: "Runtime stopped",
    }));
  }

  /**
   * Inspect the current runtime lifecycle state.
   * @pk
   */
  state(): RuntimeLifecycleSnapshot {
    return this.lifecycle.state();
  }

  /**
   * Run configured runtime health checks.
   * @pk
   */
  async health(): Promise<HealthReport> {
    const report = await runHealthChecks({
      config: this.healthConfig,
      state: {
        lifecycle: this.state(),
        servers: this.serverCatalog.allServers(),
        groups: this.groups,
        exposureCount: this.exposureHandles.size,
        policy: this.globalPolicy,
        auth: this.auth,
        identityRequired: Boolean(this.identityOptions?.required),
      },
      emitRuntimeEvent: (event) => this.emitRuntimeEvent(event),
    });
    if (report.status === "degraded" && this.state().state === "degraded" && isOnlyLifecycleCheckDegraded(report)) {
      await this.lifecycle.markReady();
      return this.health();
    }
    if (report.status === "degraded") {
      await this.lifecycle.markDegraded("One or more health checks are degraded");
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "runtime.degraded",
        category: "lifecycle",
        level: "warn",
        component: "health",
        reason: "One or more health checks are degraded",
        metadata: { status: report.status },
      }));
    } else if (report.status === "ok") {
      await this.lifecycle.markReady();
    }
    return report;
  }

  /**
   * Ping a configured upstream MCP server by listing tools.
   * @pk
   */
  async pingMcp(name: string): Promise<HealthCheckResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    return this.checkMcpHealth(name);
  }

  /**
   * Check a configured upstream MCP server health.
   * @pk
   */
  async mcpHealth(name: string): Promise<HealthCheckResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    return this.checkMcpHealth(name);
  }

  /**
   * List tools across all configured servers.
   * @pk
   */
  async listTools(
    params?: ListToolsRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListToolsResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const bindings = this.serverCatalog.resolve({ user: resolvedUser, subject: resolvedSubject, operation: "tools:list" });
    const results = await Promise.all(
      bindings.map(async ({ server }) => {
        const { user: userForServer } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
        const result = await server.listTools(params, userForServer);
        const tools = this.groups.length > 0
          ? filterToolsByGroupPolicies(result.tools, server.name, userGroups)
          : this.globalPolicy ? filterToolsByPolicy(result.tools, server.name, this.globalPolicy) : [];
        return tools.map((tool) => ({
          ...tool,
          name: toProxyToolName(server.name, tool.name),
          title: tool.title ?? `${server.displayName}: ${tool.name}`,
          description: annotateDescription(server.displayName, tool.description),
        }));
      }),
    );

    let tools: ListToolsResult["tools"] = results.flat();
    const log = createContextualLogger({ logger: this.logger }, {
      operation: "tools:list",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
    });
    const context = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
      operation: "tools:list",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      log,
      raw: params,
      policy: this.globalPolicy,
    });

    for (const hook of this.listToolsHooks) {
      let result;
      try {
        result = await hook(tools, {
          user: resolvedUser,
          subject: resolvedSubject,
          identity,
          log,
          policy: this.globalPolicy,
          credentialSources: context.credentials.sources,
        });
      } catch (error) {
        await this.emitExtensionError("hook", error, context);
        throw error;
      }
      if (Array.isArray(result)) {
        tools = result;
      } else if (result?.tools) {
        tools = result.tools;
      }
    }

    const eventResult = await emitProxyEvent(this.eventHandlers, "tools:list:after", { ctx: context, tools });
    if (Array.isArray(eventResult)) {
      tools = eventResult;
    } else if (eventResult?.tools) {
      tools = eventResult.tools;
    }

    return { tools: this.filterVisibleProxyTools(tools, userGroups) };
  }

  /**
   * Call a proxied tool with middleware dispatch.
   * @pk
   */
  async callTool(
    params: CallToolRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<CallToolResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, toolName } = fromProxyToolName(params.name);
    const request: ToolCallRequest = {
      serverName,
      toolName,
      proxyToolName: params.name,
      arguments: params.arguments,
      raw: params,
    };
    const server = this.serverCatalog.serverForContext(serverName, { user: resolvedUser, subject: resolvedSubject, operation: "tool:call" });
    const log = createContextualLogger({ logger: this.logger }, {
      operation: "tool:call",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      serverName,
      toolName,
      proxyToolName: params.name,
    });
    const context = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
      operation: "tool:call",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      log,
      request,
      raw: params,
      policy: this.globalPolicy,
    });
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    if (this.groups.length > 0) {
      context.policyDecision = await evaluateGroupPolicies(userGroups, request, resolvedUser, context);
    } else if (this.globalPolicy) {
      context.policyDecision = await this.globalPolicy.evaluate(request, resolvedUser, context);
    } else {
      context.policyDecision = this.defaultDenyDecision(request, resolvedUser);
    }
    context.policy = {
      allowed: context.policyDecision?.allowed,
      reason: context.policyDecision?.reason,
      matchedGroups: context.policyDecision?.metadata?.matchedGroups ?? userGroups.map((group) => group.id),
      matchedPermissions: context.policyDecision?.metadata?.matchedPermissions ?? [],
      metadata: context.policyDecision?.metadata,
      policy: this.globalPolicy,
      decision: context.policyDecision,
      can: createPolicyCan({ groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, resolvedSubject),
    };
    if (context.policyDecision) {
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: context.policyDecision.allowed ? "policy.allowed" : "policy.denied",
        category: "policy",
        level: context.policyDecision.allowed ? "info" : "warn",
        allowed: context.policyDecision.allowed,
        reason: context.policyDecision.reason,
        matchedGroups: context.policy.matchedGroups,
        matchedPermissions: context.policy.matchedPermissions,
        server: serverName,
        group: context.policy.matchedGroups[0],
        user: resolvedUser.id,
        operation: "tool:call",
        metadata: context.policyDecision.metadata,
      }));
    }

    const startedAt = Date.now();
    this.writeAutoLog("start", log, request, context, startedAt);
    try {
      if (!context.policyDecision.allowed) {
        const denied = this.policyDeniedResult(context);
        this.writeAutoLog("failure", log, request, context, startedAt, denied);
        return denied;
      }

      const rateLimited = await this.enforcePolicyLimiter(request, context);
      if (rateLimited) {
        this.writeAutoLog("failure", log, request, context, startedAt, rateLimited);
        return rateLimited;
      }

      let upstreamUser = resolvedUser;
      if (server) {
        const upstream = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
        upstreamUser = upstream.user;
        context.credentialSources = upstream.credentialSource ? [upstream.credentialSource] : undefined;
        context.credentials.sources = context.credentialSources ?? [];
      }

      await emitProxyEvent(this.eventHandlers, "tool:start", { ctx: context, durationMs: 0 });
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "mcp.call.start",
        category: "mcp",
        level: "info",
        server: serverName,
        group: context.policy.matchedGroups[0],
        user: resolvedUser.id,
        operation: "tool:call",
        target: toolName,
        arguments: params.arguments,
        message: "MCP tool call started",
      }));
      const hookResult = await dispatchCallHooks(this.callHooks, request, context);
      const result =
        hookResult ??
        (await this.dispatchRoutes(0, request, context, () => {
          if (!server) {
            return Promise.resolve(new ResponseController().deny(`Unknown MCP server "${serverName}"`));
          }

          return this.forwardToolCall(params, upstreamUser, server);
        }));
      const response = context.res.applyInjections(result);
      this.writeAutoLog("success", log, request, context, startedAt, response);
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "mcp.call.success",
        category: "mcp",
        level: response.isError ? "warn" : "info",
        server: serverName,
        group: context.policy.matchedGroups[0],
        user: resolvedUser.id,
        operation: "tool:call",
        target: toolName,
        result: response,
        durationMs: Date.now() - startedAt,
        message: "MCP tool call completed",
      }));
      await emitProxyEvent(this.eventHandlers, "tool:success", { ctx: context, result: response, durationMs: Date.now() - startedAt, success: true });
      await emitProxyEvent(this.eventHandlers, "tool:after", { ctx: context, result: response, durationMs: Date.now() - startedAt, success: true });
      return response;
    } catch (error) {
      const normalizedError = normalizeError(error);
      const runtimeError = new FentarisMcpError(normalizedError.message, {
        cause: normalizedError,
        context: { server: serverName, operation: "tool:call", tool: toolName, user: resolvedUser.id },
      });
      if (isTimeoutError(normalizedError)) {
        await this.emitRuntimeEvent(createRuntimeEvent({
          name: "mcp.call.timeout",
          category: "timeouts",
          level: "warn",
          server: serverName,
          group: context.policy.matchedGroups[0],
          user: resolvedUser.id,
          operation: "tool:call",
          target: toolName,
          timeoutMs: parseTimeoutMs(normalizedError.message) ?? 0,
          durationMs: Date.now() - startedAt,
          error: runtimeErrorToEventPayload(new FentarisTimeoutError(normalizedError.message, {
            cause: normalizedError,
            context: { server: serverName, operation: "tool:call", tool: toolName, user: resolvedUser.id },
          })),
          message: "MCP tool call timed out",
        }));
      }
      const mappedError = this.errorMapper.mapError(normalizedError, { serverName, toolName });
      this.writeAutoLog("failure", log, request, context, startedAt, undefined, normalizedError);
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "mcp.call.error",
        category: "errors",
        level: "error",
        server: serverName,
        group: context.policy.matchedGroups[0],
        user: resolvedUser.id,
        operation: "tool:call",
        target: toolName,
        durationMs: Date.now() - startedAt,
        error: runtimeErrorToEventPayload(runtimeError),
        message: "MCP tool call failed",
      }));
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "runtime.error",
        category: "errors",
        level: "error",
        operation: "runtime:error",
        server: serverName,
        group: context.policy.matchedGroups[0],
        user: resolvedUser.id,
        error: runtimeErrorToEventPayload(runtimeError),
      }));
      await emitLifecycle(this.lifecycleHooks, "toolFailure", {
        user: resolvedUser,
        subject: resolvedSubject,
        identity,
        request,
        error: normalizedError,
        log,
      });
      await emitProxyEvent(this.eventHandlers, "tool:error", { ctx: context, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
      await context.res.notifyError(normalizedError);
      const injectedResult = context.res.injectedErrorResult();
      if (injectedResult) {
        await emitProxyEvent(this.eventHandlers, "tool:after", { ctx: context, result: injectedResult, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
        return injectedResult;
      }
      const failed = context.res.fail(mappedError.code, mappedError.message);
      await emitProxyEvent(this.eventHandlers, "tool:after", { ctx: context, result: failed, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
      return failed;
    }
  }

  /**
   * List resources across all configured servers.
   * @pk
   */
  async listResources(
    params?: ListResourcesRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListResourcesResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const bindings = this.serverCatalog.resolve({ user: resolvedUser, subject: resolvedSubject, operation: "resources:list" });
    const results = await Promise.all(
      bindings.map(async ({ server }) => {
        const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
          operation: "resources:list",
          serverName: server.name,
          targetKind: "resource",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (
          !isCapabilityAllowed({ groups: this.groups, policy: this.globalPolicy, subjectIndex: this.subjectIndex }, 
            { serverName: server.name, operation: "resources:list", targetKind: "resource" },
            resolvedSubject,
            userGroups,
          )
        ) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listResources(params, userForServer);
          return {
            resources: upstream.resources.filter((resource) =>
              isCapabilityAllowed({ groups: this.groups, policy: this.globalPolicy, subjectIndex: this.subjectIndex }, 
                {
                  serverName: server.name,
                  operation: "resource:read",
                  target: resource.uri,
                  targetKind: "resource",
                  raw: resource,
                },
                resolvedSubject,
                userGroups,
              ),
            ).map((resource) => ({
              ...resource,
              uri: toProxyResourceUri(server.name, resource.uri),
            })),
          };
        }) as ListResourcesResult;
        return result.resources;
      }),
    );

    return { resources: results.flat() };
  }

  /**
   * Read a proxied resource from its owning upstream server.
   * @pk
   */
  async readResource(
    params: ReadResourceRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ReadResourceResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, uri } = fromProxyResourceUri(params.uri);
    const server = this.requireServer(serverName, resolvedUser, resolvedSubject, "resource:read");
    let context: ProxyContext;
    try {
      context = await this.enforceCapabilityPolicy(
        {
          serverName,
          operation: "resource:read",
          target: uri,
          targetKind: "resource",
          proxyTarget: params.uri,
          raw: params,
        },
        resolvedUser,
        resolvedSubject,
        identity,
      );
    } catch (error) {
      await this.emitDeniedCapabilityError(error);
      throw error;
    }
    return this.runCapabilityOperation(context, async () => {
      const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
      context.credentialSources = credentialSource ? [credentialSource] : undefined;
      context.credentials.sources = context.credentialSources ?? [];
      const result = await this.dispatchOperationRoutes(context, async () => server.readResource({ ...params, uri }, userForServer)) as ReadResourceResult;

      return {
        ...result,
        contents: result.contents.map((content) => ({
          ...content,
          uri: toProxyResourceUri(server.name, content.uri),
        })),
      };
    }) as Promise<ReadResourceResult>;
  }

  /**
   * List resource templates across all configured servers.
   * @pk
   */
  async listResourceTemplates(
    params?: ListResourceTemplatesRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListResourceTemplatesResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const bindings = this.serverCatalog.resolve({ user: resolvedUser, subject: resolvedSubject, operation: "resource-templates:list" });
    const results = await Promise.all(
      bindings.map(async ({ server }) => {
        const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
          operation: "resource-templates:list",
          serverName: server.name,
          targetKind: "resourceTemplate",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (
          !isCapabilityAllowed({ groups: this.groups, policy: this.globalPolicy, subjectIndex: this.subjectIndex }, 
            { serverName: server.name, operation: "resource-templates:list", targetKind: "resourceTemplate" },
            resolvedSubject,
            userGroups,
          )
        ) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listResourceTemplates(params, userForServer);
          return {
            resourceTemplates: upstream.resourceTemplates.filter((template) =>
              isCapabilityAllowed({ groups: this.groups, policy: this.globalPolicy, subjectIndex: this.subjectIndex }, 
                {
                  serverName: server.name,
                  operation: "resource-templates:list",
                  target: template.uriTemplate,
                  targetKind: "resourceTemplate",
                  raw: template,
                },
                resolvedSubject,
                userGroups,
              ),
            ).map((template) => ({
              ...template,
              uriTemplate: toProxyResourceTemplateUri(server.name, template.uriTemplate),
            })),
          };
        }) as ListResourceTemplatesResult;
        return result.resourceTemplates;
      }),
    );

    return { resourceTemplates: results.flat() };
  }

  /**
   * List prompts across all configured servers.
   * @pk
   */
  async listPrompts(
    params?: ListPromptsRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListPromptsResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const bindings = this.serverCatalog.resolve({ user: resolvedUser, subject: resolvedSubject, operation: "prompts:list" });
    const results = await Promise.all(
      bindings.map(async ({ server }) => {
        const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
          operation: "prompts:list",
          serverName: server.name,
          targetKind: "prompt",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (!isCapabilityAllowed({ groups: this.groups, policy: this.globalPolicy, subjectIndex: this.subjectIndex }, { serverName: server.name, operation: "prompts:list", targetKind: "prompt" }, resolvedSubject, userGroups)) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listPrompts(params, userForServer);
          return {
            prompts: upstream.prompts.filter((prompt) =>
              isCapabilityAllowed({ groups: this.groups, policy: this.globalPolicy, subjectIndex: this.subjectIndex }, 
                {
                  serverName: server.name,
                  operation: "prompt:get",
                  target: prompt.name,
                  targetKind: "prompt",
                  raw: prompt,
                },
                resolvedSubject,
                userGroups,
              ),
            ).map((prompt) => ({
              ...prompt,
              name: toProxyPromptName(server.name, prompt.name),
            })),
          };
        }) as ListPromptsResult;
        return result.prompts;
      }),
    );

    return { prompts: results.flat() };
  }

  /**
   * Get a proxied prompt from its owning upstream server.
   * @pk
   */
  async getPrompt(
    params: GetPromptRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<GetPromptResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, promptName } = fromProxyPromptName(params.name);
    const server = this.requireServer(serverName, resolvedUser, resolvedSubject, "prompt:get");
    let context: ProxyContext;
    try {
      context = await this.enforceCapabilityPolicy(
        {
          serverName,
          operation: "prompt:get",
          target: promptName,
          targetKind: "prompt",
          proxyTarget: params.name,
          raw: params,
        },
        resolvedUser,
        resolvedSubject,
        identity,
      );
    } catch (error) {
      await this.emitDeniedCapabilityError(error);
      throw error;
    }
    return this.runCapabilityOperation(context, async () => {
      const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
      context.credentialSources = credentialSource ? [credentialSource] : undefined;
      context.credentials.sources = context.credentialSources ?? [];
      return this.dispatchOperationRoutes(context, async () => server.getPrompt({ ...params, name: promptName }, userForServer)) as Promise<GetPromptResult>;
    }) as Promise<GetPromptResult>;
  }

  /**
   * Complete a proxied prompt or resource-template argument.
   * @pk
   */
  async complete(
    params: CompleteRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<CompleteResult> {
    this.assertDeferredPolicyServerVisibilityValid();
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const routed = routeCompletion(params);
    const server = this.requireServer(routed.serverName, resolvedUser, resolvedSubject, "completion:complete");
    let context: ProxyContext;
    try {
      context = await this.enforceCapabilityPolicy(
        {
          serverName: routed.serverName,
          operation: "completion:complete",
          target: completionTarget(routed.params),
          targetKind: "completion",
          proxyTarget: completionTarget(params),
          completionRefType: params.ref.type,
          argumentName: params.argument.name,
          raw: params,
        },
        resolvedUser,
        resolvedSubject,
        identity,
      );
    } catch (error) {
      await this.emitDeniedCapabilityError(error);
      throw error;
    }
    return this.runCapabilityOperation(context, async () => {
      const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
      context.credentialSources = credentialSource ? [credentialSource] : undefined;
      context.credentials.sources = context.credentialSources ?? [];
      return this.dispatchOperationRoutes(context, async () => server.complete(routed.params, userForServer)) as Promise<CompleteResult>;
    }) as Promise<CompleteResult>;
  }

  /**
   * Handle an MCP HTTP request for session setup or routing.
   * @pk
   */

  /**
   * Resolve user context from an HTTP downstream request.
   * @pk
   */
  async resolveHttpUser(req: IncomingMessage): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    return this.resolveUser(req);
  }

  /**
   * Resolve user context for non-HTTP stdio downstream exposure.
   * @pk
   */
  async resolveStdioUser(): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    const user = typeof this.userResolver === "function" ? await this.userResolver({} as IncomingMessage) : this.userResolver ?? {};
    return { user, subject: this.resolveSubject(user) };
  }

  /**
   * Emit a downstream session start lifecycle event.
   * @pk
   */
  async emitSessionStart(context: Parameters<LifecycleHook>[1]): Promise<void> {
    await emitLifecycle(this.lifecycleHooks, "sessionStart", context);
    await this.emitRuntimeEvent(createRuntimeEvent({
      name: "runtime.ready",
      category: "lifecycle",
      level: "info",
      runtime: this.name,
      version: this.version,
      operation: "session:start",
      user: context.user.id,
      startupMs: 0,
      durationMs: 0,
      metadata: { sessionId: context.sessionId },
      message: "Runtime session started",
    }));
    const proxyContext = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
      operation: "session:start",
      user: context.user,
      subject: context.subject,
      identity: context.identity,
      log: createContextualLogger({ logger: this.logger }, {
        operation: "session:start",
        user: context.user,
        subject: context.subject,
        identity: context.identity,
        sessionId: context.sessionId,
      }),
      request: context.request,
      transport: { sessionId: context.sessionId },
      policy: this.globalPolicy,
    });
    await emitProxyEvent(this.eventHandlers, "session:start", { ctx: proxyContext });
  }

  /**
   * Emit a downstream session end lifecycle event.
   * @pk
   */
  async emitSessionEnd(context: Parameters<LifecycleHook>[1]): Promise<void> {
    await emitLifecycle(this.lifecycleHooks, "sessionEnd", context);
    await this.emitRuntimeEvent(createRuntimeEvent({
      name: "runtime.stop",
      category: "lifecycle",
      level: "info",
      runtime: this.name,
      operation: "session:end",
      user: context.user.id,
      metadata: { sessionId: context.sessionId },
      message: "Runtime session ended",
    }));
    const proxyContext = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
      operation: "session:end",
      user: context.user,
      subject: context.subject,
      identity: context.identity,
      log: createContextualLogger({ logger: this.logger }, {
        operation: "session:end",
        user: context.user,
        subject: context.subject,
        identity: context.identity,
        sessionId: context.sessionId,
      }),
      request: context.request,
      transport: { sessionId: context.sessionId },
      policy: this.globalPolicy,
    });
    await emitProxyEvent(this.eventHandlers, "session:end", { ctx: proxyContext });
  }

  registerServerMiddleware(serverName: string, handler: Middleware, groupId?: string): void {
    this.assertServerHandleVisible(serverName, groupId);
    this.routes.push({ kind: "middleware", scopeServer: serverName, scopeGroup: groupId, handler });
  }

  registerServerTool(serverName: string, pattern: ProxyToolPattern, handler: ProxyToolHandler, groupId?: string): void {
    this.assertServerHandleVisible(serverName, groupId);
    this.routes.push({ kind: "tool", scopeServer: serverName, scopeGroup: groupId, pattern: compileToolPattern(pattern, serverName), handler });
  }

  registerServerOperation(serverName: string, operation: ProxyContext["operation"], handler: ProxyOperationHandler, groupId?: string): void {
    this.assertServerHandleVisible(serverName, groupId);
    this.routes.push({ kind: "operation", scopeServer: serverName, scopeGroup: groupId, operation, handler });
  }

  registerServerEvent(serverName: string, eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler, groupId?: string): void {
    this.assertServerHandleVisible(serverName, groupId);
    this.eventHandlers.push({
      eventName,
      filter: {
        ...filter,
        server: serverName,
        group: groupId ?? filter.group,
      },
      handler,
    });
  }

  registerGroupMiddleware(groupId: string, handler: Middleware): void {
    this.assertGroupHandleKnown(groupId);
    this.routes.push({ kind: "middleware", scopeGroup: groupId, handler });
  }

  registerGroupOperation(groupId: string, operation: ProxyContext["operation"], handler: ProxyOperationHandler): void {
    this.assertGroupHandleKnown(groupId);
    this.routes.push({ kind: "operation", scopeGroup: groupId, operation, handler });
  }

  registerGroupEvent(groupId: string, eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): void {
    this.assertGroupHandleKnown(groupId);
    this.eventHandlers.push({
      eventName,
      filter: {
        ...filter,
        group: groupId,
      },
      handler,
    });
  }

  addGroupUsers(groupId: string, users: User[]): void {
    const declaration = this.fluentGroup(groupId);
    declaration.users.push(...users);
    this.refreshDerivedGovernanceState({ validate: false });
  }

  setGroupPolicy(groupId: string, policy: string | Policy): void {
    const declaration = this.fluentGroup(groupId);
    declaration.policy = policy;
    this.refreshDerivedGovernanceState({ validate: false });
  }

  assertServerHandleVisible(serverName: string, groupId?: string): void {
    if (!this.serverByName.has(serverName)) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_HANDLE_UNKNOWN_SERVER",
          title: "Scoped server handle references an unknown server",
          message: `Server handle "${serverName}" does not match a configured MCP server.`,
          path: groupId ? ["proxy", "group", groupId, "server", serverName] : ["proxy", "server", serverName],
          hint: "Configure the server before registering scoped routes.",
        },
      ]);
    }

    if (groupId && !this.groupCanSeeServer(groupId, serverName)) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_HANDLE_SERVER_NOT_VISIBLE",
          title: "Scoped server handle is not visible to the group",
          message: `Server "${serverName}" is not visible to group "${groupId}".`,
          path: ["proxy", "group", groupId, "server", serverName],
          hint: "Declare the server globally or in the same group.",
        },
      ]);
    }
  }

  assertGroupHandleKnown(groupId: string): void {
    this.refreshDerivedGovernanceState({ validate: true });
    if (this.groups.some((group) => group.id === groupId)) {
      return;
    }
    throw new FentarisConfigError([
      {
        severity: "error",
        code: "FENTARIS_CONFIG_HANDLE_UNKNOWN_GROUP",
        title: "Scoped group handle references an unknown group",
        message: `Group handle "${groupId}" does not match a configured group.`,
        path: ["proxy", "group", groupId],
      },
    ]);
  }

  private groupCanSeeServer(groupId: string, serverName: string): boolean {
    this.refreshDerivedGovernanceState({ validate: true });
    const group = this.groups.find((entry) => entry.id === groupId);
    if (!group) {
      return false;
    }

    return this.servers.some((server) => server.name === serverName) || group.servers.some((server) => server.name === serverName);
  }

  private fluentGroup(groupId: string): FluentGroupDeclaration {
    const existing = this.fluentGroups.get(groupId);
    if (existing) {
      return existing;
    }

    const declaration: FluentGroupDeclaration = { id: groupId, users: [] };
    this.fluentGroups.set(groupId, declaration);
    return declaration;
  }

  private refreshDerivedGovernanceState(options: { validate: boolean }): void {
    const groups = this.resolveFluentGroups(options.validate);
    this.groups = groups;
    this.subjectIndex = groups.length > 0 ? buildSubjectIndex(groups) : undefined;
    this.refreshDeclaredApiKeyIdentityOptions();
    this.runtimeValidationConfig = {
      ...this.runtimeValidationConfig,
      policy: this.globalPolicy,
      servers: this.servers,
      groups,
      defaults: { credentials: this.defaultCredentials },
    };
  }

  private refreshDeclaredApiKeyIdentityOptions(): void {
    if (!this.usesDeclaredApiKeyIdentity) {
      return;
    }

    this.identityOptions = normalizeIdentityOptions(
      declaredApiKeyIdentityStrategy(() => this.groups),
      hasDeclaredApiKeys(this.groups),
    );
  }

  private resolveFluentGroups(validate: boolean): Group[] {
    const diagnostics = validate ? this.validateFluentGovernance() : [];
    if (diagnostics.length > 0) {
      throw new FentarisConfigError(diagnostics);
    }

    const groups = [...this.configuredGroups];
    for (const declaration of this.fluentGroups.values()) {
      if (this.configuredGroups.some((group) => group.id === declaration.id)) {
        continue;
      }

      if (declaration.users.length === 0 || !declaration.policy) {
        continue;
      }

      const resolvedPolicy = typeof declaration.policy === "string"
        ? this.namedPolicies.get(declaration.policy)
        : declaration.policy;
      if (!resolvedPolicy) {
        continue;
      }

      groups.push(new GovernanceGroup({
        id: declaration.id,
        users: declaration.users,
        policy: resolvedPolicy,
      }));
    }

    return groups;
  }

  private validateFluentGovernance(): FentarisDiagnostic[] {
    const diagnostics: FentarisDiagnostic[] = [];
    for (const declaration of this.fluentGroups.values()) {
      const path = ["proxy", "group", declaration.id];
      const configuredIndex = this.configuredGroups.findIndex((group) => group.id === declaration.id);
      if (configuredIndex >= 0 && (declaration.users.length > 0 || declaration.policy)) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_DUPLICATE_GROUP",
          title: "Duplicate group id",
          message: `Group "${declaration.id}" is declared both in constructor config and through app.group(...).`,
          path,
          related: [{ path: ["groups", configuredIndex, "id"], message: "Constructor-time declaration with this group id." }],
        });
        continue;
      }

      if (configuredIndex >= 0) {
        continue;
      }

      if (declaration.users.length === 0) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_GROUP_EMPTY_USERS",
          title: "Fluent group has no users",
          message: `Group "${declaration.id}" must include at least one user.`,
          path: [...path, "users"],
          hint: "Call app.group(id).users(user(...)) before starting the proxy.",
        });
      }

      if (!declaration.policy) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_GROUP_POLICY_MISSING",
          title: "Fluent group has no policy",
          message: `Group "${declaration.id}" must attach a policy.`,
          path: [...path, "policy"],
          hint: "Call app.group(id).policy(policyNameOrPolicy) before starting the proxy.",
        });
      }

      if (typeof declaration.policy === "string" && !this.namedPolicies.has(declaration.policy)) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_GROUP_POLICY_UNKNOWN",
          title: "Fluent group references an unknown policy",
          message: `Group "${declaration.id}" references policy "${declaration.policy}", but no app-level policy with that name exists.`,
          path: [...path, "policy"],
          hint: "Declare the named policy with app.policy(name) or pass a concrete policy instance.",
        });
      }
    }

    const configuredPolicyNames = new Map<string, number>();
    for (const [index, group] of this.configuredGroups.entries()) {
      if (group.policy.name) {
        configuredPolicyNames.set(group.policy.name, index);
      }
    }

    for (const name of this.namedPolicies.keys()) {
      const configuredGroupIndex = configuredPolicyNames.get(name);
      if (configuredGroupIndex !== undefined) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_DUPLICATE_POLICY",
          title: "Duplicate policy name",
          message: `Policy "${name}" is declared both in constructor config and through app.policy(...).`,
          path: ["proxy", "policy", name],
          related: [{ path: ["groups", configuredGroupIndex, "policy"], message: "Constructor-time policy with this name." }],
        });
      }
    }

    return diagnostics;
  }

  private createRuntime(): ProxyRuntime {
    return {
      createSdkServer: (user, identity, subject) => createSdkServer(this as unknown as Parameters<typeof createSdkServer>[0], user, identity, subject),
      resolveHttpUser: (request) => this.resolveHttpUser(request as IncomingMessage),
      resolveStdioUser: () => this.resolveStdioUser(),
      emitSessionStart: (context) => this.emitSessionStart(context),
      emitSessionEnd: (context) => this.emitSessionEnd(context),
      emitRuntimeEvent: (event) => this.emitRuntimeEvent(event),
      logger: this.logger,
      identityRequired: Boolean(this.identityOptions?.required),
    };
  }

  private async emitRuntimeEvent(event: RuntimeEvent): Promise<void> {
    await this.profiler.emit(event);
  }

  private async emitLifecycleTransition(transition: RuntimeLifecycleTransition): Promise<void> {
    if (transition.to === "starting") {
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "runtime.start",
        category: "lifecycle",
        level: "info",
        runtime: this.name,
        version: this.version,
        operation: "runtime:start",
        metadata: { from: transition.from, to: transition.to },
        message: "Runtime starting",
      }));
      return;
    }

    if (transition.to === "failed") {
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "runtime.error",
        category: "errors",
        level: "error",
        operation: "runtime:transition",
        error: runtimeErrorToEventPayload(new FentarisRuntimeError("Runtime lifecycle transition failed", {
          context: { from: transition.from, to: transition.to },
        })),
        metadata: { from: transition.from, to: transition.to },
        message: "Runtime failed",
      }));
    }
  }

  private async emitExtensionError(
    boundary: "hook" | "middleware" | "route" | "sink" | "extension",
    error: unknown,
    context?: ProxyContext,
  ): Promise<void> {
    const normalized = normalizeError(error);
    await this.emitRuntimeEvent(createRuntimeEvent({
      name: "extension.error",
      category: "errors",
      level: "error",
      boundary,
      server: context?.server?.name,
      group: context?.policy.matchedGroups[0],
      user: context?.user.id,
      operation: context?.operation,
      error: runtimeErrorToEventPayload(new FentarisExtensionError(normalized.message, {
        cause: normalized,
        context: context ? capabilityErrorContext(context) : {},
      })),
    }));
  }

  private async enforceCapabilityPolicy(
    request: CapabilityOperationRequest & {
      proxyTarget?: string;
      completionRefType?: "ref/prompt" | "ref/resource";
      argumentName?: string;
    },
    user: UserContext,
    subject: ResolvedSubject | undefined,
    identity: IdentityMetadata | undefined,
  ): Promise<ProxyContext> {
    const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
      ...request,
      user,
      subject,
      identity,
    });
    const userGroups = subject ? this.subjectIndex?.groupsFor(subject.id) ?? [] : [];
    let decision;

    if (this.groups.length > 0) {
      decision = await evaluateGroupPolicies(userGroups, request, user, context);
    } else if (this.globalPolicy) {
      decision = await this.globalPolicy.evaluate(request, user, context);
    } else {
      decision = this.defaultDenyDecision(request, user);
    }

    context.policyDecision = decision;
    context.policy = {
      allowed: decision?.allowed,
      reason: decision?.reason,
      matchedGroups: decision?.metadata?.matchedGroups ?? userGroups.map((group) => group.id),
      matchedPermissions: decision?.metadata?.matchedPermissions ?? [],
      metadata: decision?.metadata,
      policy: this.globalPolicy,
      decision,
      can: createPolicyCan({ groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, subject),
    };

    if (decision) {
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: decision.allowed ? "policy.allowed" : "policy.denied",
        category: "policy",
        level: decision.allowed ? "info" : "warn",
        allowed: decision.allowed,
        reason: decision.reason,
        matchedGroups: context.policy.matchedGroups,
        matchedPermissions: context.policy.matchedPermissions,
        server: request.serverName,
        group: context.policy.matchedGroups[0],
        user: user.id,
        operation: request.operation,
        metadata: decision.metadata,
      }));
    }

    if (decision && !decision.allowed) {
      throw new PolicyDeniedError(decision.reason ?? `Operation "${request.operation}" denied by policy`, FentarisErrorCode.PolicyDenied, context);
    }

    return context;
  }

  private defaultDenyDecision(request: ToolCallRequest | CapabilityOperationRequest, user: UserContext): PolicyDecision {
    const capability = toCapabilityRequest(request);
    const reason = capability.operation === "tool:call"
      ? `Tool "${capability.target ?? "*"}" not permitted by policy`
      : `Operation "${capability.operation}" not permitted by policy`;
    return {
      allowed: false,
      reason,
      metadata: {
        policyName: "default-deny",
        matchedPermissions: [],
        denialReason: reason,
        serverName: capability.serverName,
        operation: capability.operation,
        target: capability.target,
        targetKind: capability.targetKind,
        toolName: capability.targetKind === "tool" ? capability.target : undefined,
        userId: user.id,
        effect: "deny",
      },
    };
  }

  private filterVisibleProxyTools(tools: ListToolsResult["tools"], groups: Group[]): ListToolsResult["tools"] {
    return tools.filter((tool) => {
      const serverName = serverNameFromProxyTool(tool.name);
      if (this.groups.length > 0) {
        return filterToolsByGroupPolicies([tool], serverName, groups).length > 0;
      }
      if (this.globalPolicy) {
        return filterToolsByPolicy([tool], serverName, this.globalPolicy).length > 0;
      }
      return false;
    });
  }

  private policyDeniedResult(context: ProxyContext): CallToolResult {
    const denied = context.res.fail(
      FentarisErrorCode.PolicyDenied,
      context.policyDecision?.reason ?? "Tool call denied by policy",
    );
    return {
      ...denied,
      _meta: {
        ...denied._meta,
        error: {
          ...(isRecord(denied._meta?.error) ? denied._meta.error : {}),
          policy: context.policyDecision?.metadata,
        },
      },
    };
  }

  private async enforcePolicyLimiter(request: ToolCallRequest, context: ProxyContext): Promise<CallToolResult | undefined> {
    const limiter = context.policyDecision?.metadata?.limiter;
    if (!isRateLimiter(limiter)) {
      return undefined;
    }

    const key = rateLimitKey(request, context.user);
    if (!(await limiter.checkLimit(key))) {
      return context.res.deny("Rate limit exceeded");
    }

    await limiter.recordCall(key);
    return undefined;
  }

  /**
   * Execute middleware in sequence.
   * @pk
   */
  private async dispatchMiddleware(
    index: number,
    request: ToolCallRequest,
    context: MiddlewareContext,
    terminal: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const middleware = this.middleware[index];
    if (!middleware) {
      return terminal();
    }

    let nextCalled = false;
    let nextResult: CallToolResult | undefined;
    const result = await (middleware as LegacyMiddleware)(request, context, async () => {
      if (nextCalled) {
        throw new Error("Middleware next() called multiple times");
      }

      nextCalled = true;
      nextResult = await this.dispatchMiddleware(index + 1, request, context, terminal);
      return nextResult;
    });

    if (result) {
      return result;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchMiddleware(index + 1, request, context, terminal);
  }

  private async dispatchRoutes(
    index: number,
    request: ToolCallRequest,
    context: ProxyContext,
    terminal: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const route = this.routes.slice(index).find((entry) => this.matchesRoute(entry, request, context));
    if (!route) {
      return terminal();
    }
    const routeIndex = this.routes.indexOf(route);

    let nextCalled = false;
    let nextResult: CallToolResult | undefined;
    const next = async () => {
      if (nextCalled) {
        throw new Error("Middleware next() called multiple times");
      }

      nextCalled = true;
      nextResult = await this.dispatchRoutes(routeIndex + 1, request, context, terminal);
      return nextResult;
    };

    let result;
    try {
      result = await dispatchRouteHandler(route.handler, request, context, next);
    } catch (error) {
      await this.emitExtensionError(route.kind === "middleware" ? "middleware" : "route", error, context);
      throw error;
    }

    if (result) {
      return result as CallToolResult;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchRoutes(routeIndex + 1, request, context, terminal);
  }

  private async dispatchOperationRoutes(
    context: ProxyContext,
    terminal: () => Promise<ProxyOperationResult>,
    index = 0,
  ): Promise<ProxyOperationResult> {
    const route = this.routes.slice(index).find((entry) => this.matchesOperationRoute(entry, context));
    if (!route) {
      return terminal();
    }
    const routeIndex = this.routes.indexOf(route);

    let nextCalled = false;
    let nextResult: ProxyOperationResult | undefined;
    const next = async () => {
      if (nextCalled) {
        throw new Error("Middleware next() called multiple times");
      }

      nextCalled = true;
      nextResult = await this.dispatchOperationRoutes(context, terminal, routeIndex + 1);
      return nextResult;
    };

    let result;
    try {
      result = await dispatchRouteHandler(route.handler, context.tool ? {
        serverName: context.server?.name ?? "",
        toolName: context.tool.name,
        proxyToolName: context.tool.proxyName,
        arguments: context.args,
        raw: context.raw as CallToolRequest["params"],
      } : capabilityToolRequest(context), context, next);
    } catch (error) {
      await this.emitExtensionError(route.kind === "middleware" ? "middleware" : "route", error, context);
      throw error;
    }

    if (result) {
      if (isStructuredPolicyErrorResult(result)) {
        const error = toStructuredError(result._meta?.error);
        throw new PolicyDeniedError(error?.message ?? "Operation denied by middleware", error?.code);
      }

      return result;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchOperationRoutes(context, terminal, routeIndex + 1);
  }

  private async runCapabilityOperation(
    context: ProxyContext,
    terminal: () => Promise<ProxyOperationResult>,
  ): Promise<ProxyOperationResult> {
    const startedAt = Date.now();
    await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "start"), { ctx: context, durationMs: 0 });
    await this.emitRuntimeEvent(createRuntimeEvent({
      name: "mcp.call.start",
      category: "mcp",
      level: "info",
      server: context.server?.name,
      group: context.policy.matchedGroups[0],
      user: context.user.id,
      operation: context.operation,
      target: context.resource?.uri ?? context.resource?.uriTemplate ?? context.prompt?.name ?? context.completion?.target,
      message: "MCP operation started",
    }));
    this.writeCapabilityAuditLog("start", context, startedAt);

    try {
      const result = await terminal();
      const durationMs = Date.now() - startedAt;
      this.writeCapabilityAuditLog("success", context, startedAt, result);
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "mcp.call.success",
        category: "mcp",
        level: "info",
        server: context.server?.name,
        group: context.policy.matchedGroups[0],
        user: context.user.id,
        operation: context.operation,
        target: context.resource?.uri ?? context.resource?.uriTemplate ?? context.prompt?.name ?? context.completion?.target,
        result,
        durationMs,
        message: "MCP operation completed",
      }));
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "success"), { ctx: context, result, durationMs, success: true });
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "after"), { ctx: context, result, durationMs, success: true });
      return result;
    } catch (error) {
      const normalizedError = normalizeError(error);
      const durationMs = Date.now() - startedAt;
      const runtimeError = normalizedError instanceof PolicyDeniedError
        ? new FentarisPolicyError(normalizedError.message, { cause: normalizedError, context: capabilityErrorContext(context) })
        : new FentarisMcpError(normalizedError.message, { cause: normalizedError, context: capabilityErrorContext(context) });
      this.writeCapabilityAuditLog("failure", context, startedAt, undefined, normalizedError);
      if (isTimeoutError(normalizedError)) {
        await this.emitRuntimeEvent(createRuntimeEvent({
          name: "mcp.call.timeout",
          category: "timeouts",
          level: "warn",
          server: context.server?.name,
          group: context.policy.matchedGroups[0],
          user: context.user.id,
          operation: context.operation,
          target: context.resource?.uri ?? context.resource?.uriTemplate ?? context.prompt?.name ?? context.completion?.target,
          timeoutMs: parseTimeoutMs(normalizedError.message) ?? 0,
          durationMs,
          error: runtimeErrorToEventPayload(new FentarisTimeoutError(normalizedError.message, {
            cause: normalizedError,
            context: capabilityErrorContext(context),
          })),
          message: "MCP operation timed out",
        }));
      }
      await this.emitRuntimeEvent(createRuntimeEvent({
        name: "mcp.call.error",
        category: "errors",
        level: "error",
        server: context.server?.name,
        group: context.policy.matchedGroups[0],
        user: context.user.id,
        operation: context.operation,
        target: context.resource?.uri ?? context.resource?.uriTemplate ?? context.prompt?.name ?? context.completion?.target,
        durationMs,
        error: runtimeErrorToEventPayload(runtimeError),
        message: "MCP operation failed",
      }));
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "error"), { ctx: context, error: normalizedError, durationMs, success: false });
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "after"), { ctx: context, error: normalizedError, durationMs, success: false });
      throw error;
    }
  }

  private async emitDeniedCapabilityError(error: unknown): Promise<void> {
    if (!(error instanceof PolicyDeniedError) || !error.context) {
      return;
    }

    const startedAt = Date.now();
    const runtimeError = new FentarisPolicyError(error.message, { cause: error, context: capabilityErrorContext(error.context) });
    this.writeCapabilityAuditLog("failure", error.context, startedAt, undefined, error);
    await this.emitRuntimeEvent(createRuntimeEvent({
      name: "mcp.call.error",
      category: "errors",
      level: "error",
      server: error.context.server?.name,
      group: error.context.policy.matchedGroups[0],
      user: error.context.user.id,
      operation: error.context.operation,
      durationMs: 0,
      error: runtimeErrorToEventPayload(runtimeError),
      message: "MCP operation denied",
    }));
    await emitProxyEvent(this.eventHandlers, operationEventName(error.context.operation, "error"), {
      ctx: error.context,
      error,
      durationMs: 0,
      success: false,
    });
    await emitProxyEvent(this.eventHandlers, operationEventName(error.context.operation, "after"), {
      ctx: error.context,
      error,
      durationMs: 0,
      success: false,
    });
  }

  private matchesRoute(entry: RouteEntry, request: ToolCallRequest, context: ProxyContext): boolean {
    if (entry.scopeServer && entry.scopeServer !== request.serverName) {
      return false;
    }

    if (entry.scopeGroup && !context.subject?.hasGroup(entry.scopeGroup)) {
      return false;
    }

    if (entry.kind === "tool") {
      return context.operation === "tool:call" && entry.pattern !== undefined && matchesToolPattern(entry.pattern, request);
    }

    return true;
  }

  private matchesOperationRoute(entry: RouteEntry, context: ProxyContext): boolean {
    if (entry.scopeServer && entry.scopeServer !== context.server?.name) {
      return false;
    }

    if (entry.scopeGroup && !context.subject?.hasGroup(entry.scopeGroup)) {
      return false;
    }

    if (entry.kind === "tool") {
      return false;
    }

    if (entry.kind === "operation") {
      return entry.operation === context.operation;
    }

    return true;
  }

  /**
   * Execute matching call hooks in registration order.
   * @pk
   */
  private async dispatchCallHooks(
    request: ToolCallRequest,
    context: MiddlewareContext,
  ): Promise<CallToolResult | undefined> {
    for (const hook of this.callHooks) {
      if (!matchesCallHook(hook.filter, request)) {
        continue;
      }

      const result = await hook.handler(request, context);
      if (result) {
        return result;
      }
    }

    return undefined;
  }

  /**
   * Print the startup banner to stderr.
   * @pk
   */
  private printStartupBanner(port: number, path: string, host = "127.0.0.1"): void {
    const art = [
      "███████╗███████╗███╗   ██╗████████╗ █████╗ ██████╗ ██╗███████╗",
      "██╔════╝██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██║██╔════╝",
      "█████╗  █████╗  ██╔██╗ ██║   ██║   ███████║██████╔╝██║███████╗",
      "██╔══╝  ██╔══╝  ██║╚██╗██║   ██║   ██╔══██║██╔══██╗██║╚════██║",
      "██║     ███████╗██║ ╚████║   ██║   ██║  ██║██║  ██║██║███████║",
      "╚═╝     ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝",
    ];

    const width = Math.max(...art.map((line) => line.length));
    const top = ` ╭${"─".repeat(width + 4)}╮`;
    const bottom = ` ╰${"─".repeat(width + 4)}╯`;
    const empty = ` │${" ".repeat(width + 4)}│`;

    const gradientLine = (text: string): string => {
      let output = "";
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === " ") {
          output += char;
          continue;
        }

        const ratio = i / Math.max(1, text.length - 1);
        const red = Math.round(79 + ratio * (6 - 79));
        const green = Math.round(70 + ratio * (182 - 70));
        const blue = Math.round(229 + ratio * (212 - 229));
        output += `\x1b[38;2;${red};${green};${blue}m${char}`;
      }

      return `${output}\x1b[0m`;
    };

    console.error();
    console.error(gradientLine(top));
    console.error(gradientLine(empty));
    for (const line of art) {
      const padded = ` │  ${line}${" ".repeat(width - line.length)}  │`;
      console.error(gradientLine(padded));
    }
    console.error(gradientLine(empty));
    console.error(gradientLine(bottom));
    console.error();
    console.error(" \x1b[38;2;6;182;212m🐾 Fentaris Proxy\x1b[0m \x1b[90mv0.1.0\x1b[0m");
    console.error(" \x1b[32m\x1b[1m🚀 Proxy ready\x1b[0m");
    console.error(` \x1b[36m⚡ Listening on:\x1b[0m  http://${host}:${port}${path}`);
    console.error();
  }

  /**
   * Forward a tool call to the selected server.
   * @pk
   */
  private async forwardToolCall(params: CallToolRequest["params"], user: UserContext, server: McpServer): Promise<CallToolResult> {
    const { toolName } = fromProxyToolName(params.name);

    return server.callTool(
      {
        ...params,
        name: toolName,
      },
      user,
    );
  }

  private requireServer(
    serverName: string,
    user: UserContext,
    subject: ResolvedSubject | undefined,
    operation: string,
  ): McpServer {
    const server = this.serverCatalog.serverForContext(serverName, { user, subject, operation });
    if (!server) {
      throw new Error(`Unknown MCP server "${serverName}"`);
    }

    return server;
  }

  /**
   * Resolve the user context from the incoming request.
   * @pk
   */
  private async resolveUser(req: IncomingMessage): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    if (this.identityOptions) {
      const resolved = await this.identityOptions.strategy.resolve({ headers: normalizeHeaders(req.headers), request: req });
      const subject = this.resolveSubject(resolved ?? {});
      return {
        user: resolved ?? {},
        subject,
        identity: {
          strategy: this.identityOptions.strategy.name,
          authenticated: Boolean(resolved),
          userId: resolved?.id,
        },
      };
    }

    if (typeof this.userResolver === "function") {
      const user = await this.userResolver(req);
      return { user, subject: this.resolveSubject(user) };
    }

    const user = this.userResolver ?? {};
    return { user, subject: this.resolveSubject(user) };
  }

  private async resolveRegistryUser(user: UserContext): Promise<UserContext> {
    if (!this.registry || !user.id) {
      return user;
    }

    const [registryUser, secrets, tokens] = await Promise.all([
      this.registry.getUser(user.id),
      this.registry.getSecrets(user.id),
      this.registry.getTokens(user.id),
    ]);

    return {
      ...(registryUser ?? {}),
      ...user,
      id: user.id,
      ...(secrets ? { secrets } : {}),
      ...(tokens ? { tokens } : {}),
    };
  }

  private resolveSubject(user: UserContext, subject?: ResolvedSubject): ResolvedSubject | undefined {
    if (subject) {
      return subject;
    }

    if (!this.subjectIndex) {
      return undefined;
    }

    if (!user.id) {
      return undefined;
    }

    const resolved = this.subjectIndex.resolve(user.id);
    if (!resolved) {
      throw new Error(`Authenticated user "${user.id}" is not declared in any configured group`);
    }

    return resolved;
  }

  private async applyUpstreamAuth(
    server: McpServer,
    user: UserContext,
    subject: ResolvedSubject | undefined,
  ): Promise<{ user: UserContext; credentialSource?: CredentialSourceMetadata }> {
    const bindings = server.getCredentialBindings();
    const legacyBinding = bindings.length === 0 ? this.auth?.getBinding(server.name) : undefined;
    const effectiveBindings: ServerCredentialBinding[] = legacyBinding
      ? [{ ...legacyBinding, credential: { reference: legacyBinding.credential } as ServerCredentialBinding["credential"] }]
      : bindings;
    if (effectiveBindings.length === 0) {
      return { user };
    }

    if (!subject) {
      throw new Error(`Upstream auth for server "${server.name}" requires an authenticated subject`);
    }

    let resolvedUser = user;
    let firstCredentialSource: CredentialSourceMetadata | undefined;
    for (const binding of effectiveBindings) {
      const credential = await this.resolveCredential(binding.credential.reference, subject);
      if (!credential) {
        throw new Error(`Missing upstream credential "${binding.credential.reference}" for server "${server.name}"`);
      }

      firstCredentialSource ??= {
        reference: credential.reference,
        source: credential.source,
        userId: credential.userId,
        groupId: credential.groupId,
      };
      resolvedUser = {
        ...resolvedUser,
        __fentarisUpstreamEnv: {
          ...(isRecord(resolvedUser.__fentarisUpstreamEnv) ? resolvedUser.__fentarisUpstreamEnv : {}),
          ...toUpstreamEnv(binding, credential.value),
        },
      };
    }

    return {
      user: resolvedUser,
      credentialSource: firstCredentialSource,
    };
  }

  private async resolveCredential(
    reference: string,
    subject: ResolvedSubject,
  ): Promise<(CredentialSourceMetadata & { value: string }) | null> {
    const user = this.groups.flatMap((group) => group.users).find((candidate) => candidate.id === subject.id);
    const userSource = user?.credentials[reference];
    if (userSource) {
      return { reference, value: await resolveCredentialSource(userSource), source: "user", userId: subject.id };
    }

    for (const membership of subject.groups) {
      const group = this.groups.find((candidate) => candidate.id === membership.id);
      const source = group?.credentials[reference];
      if (source) {
        return { reference, value: await resolveCredentialSource(source), source: "group", groupId: group.id };
      }
    }

    const defaultSource = this.defaultCredentials[reference];
    if (defaultSource) {
      return { reference, value: await resolveCredentialSource(defaultSource), source: "default" };
    }

    return this.auth?.resolveCredential(reference, subject) ?? null;
  }

  private writeAutoLog(
    event: "start" | "success" | "failure",
    log: Logger,
    request: ToolCallRequest,
    context: MiddlewareContext,
    startedAt: number,
    result?: CallToolResult,
    error?: Error,
  ): void {
    if (!this.autoLog) {
      return;
    }

    const metadata = {
      event: `tool.${event}`,
      durationMs: event === "start" ? undefined : Date.now() - startedAt,
      userId: context.user.id,
      identity: context.identity,
      policy: context.policyDecision?.metadata,
      allowed: context.policyDecision?.allowed,
      isError: result?.isError,
      error: error?.message,
      arguments: event === "start" ? request.arguments : undefined,
    };

    if (event === "start") {
      log[this.autoLog.startLevel]("Tool call started", metadata);
    } else if (event === "success") {
      log[this.autoLog.successLevel]("Tool call completed", metadata);
    } else {
      log[this.autoLog.failureLevel]("Tool call failed", metadata);
    }
  }

  private writeCapabilityAuditLog(
    event: "start" | "success" | "failure",
    context: ProxyContext,
    startedAt: number,
    result?: ProxyOperationResult,
    error?: Error,
  ): void {
    const metadata = {
      event: `${context.operation}.${event}`,
      operation: context.operation,
      durationMs: event === "start" ? undefined : Date.now() - startedAt,
      subjectId: context.subject?.id,
      userId: context.user.id,
      serverName: context.server?.name,
      target: context.resource?.uri ?? context.resource?.uriTemplate ?? context.prompt?.name ?? context.completion?.target,
      policy: context.policy.decision?.metadata,
      allowed: context.policy.allowed,
      credentialSource: context.credentials.sources[0]?.source,
      credentialReference: context.credentials.sources[0]?.reference,
      success: event === "success" ? true : undefined,
      isError: result && "isError" in result ? result.isError : undefined,
      error: error?.message,
    };

    if (event === "failure") {
      context.log.warn("MCP capability operation failed", metadata);
    } else {
      context.log.info("MCP capability operation", metadata);
    }
  }

  private async checkMcpHealth(name: string): Promise<HealthCheckResult> {
    const checkedAt = new Date();
    const startedAt = Date.now();
    const server = this.serverByName.get(name);
    if (!server) {
      return {
        name: `mcp.${name}.ping`,
        status: "unknown",
        message: `MCP server "${name}" is not configured`,
        checkedAt,
        durationMs: Date.now() - startedAt,
        metadata: { name },
      };
    }

    try {
      await server.listTools();
      return {
        name: `mcp.${name}.ping`,
        status: "ok",
        message: "MCP server ping succeeded",
        checkedAt,
        durationMs: Date.now() - startedAt,
        metadata: { name: server.name, displayName: server.displayName },
      };
    } catch (error) {
      return {
        name: `mcp.${name}.ping`,
        status: "down",
        message: "MCP server ping failed",
        checkedAt,
        durationMs: Date.now() - startedAt,
        metadata: { name: server.name, displayName: server.displayName },
        error: runtimeErrorToEventPayload(new FentarisMcpError("MCP server ping failed", { cause: error })),
      };
    }
  }
}

/**
 * Create a Fentaris proxy with the express-like routing API.
 * @pk
 */
export function createProxy(options: McpProxyOptions = {}): McpProxy {
  assertValidFentarisConfig(options, { requirePolicyServerVisibility: false });
  return new McpProxy(options);
}

/**
 * Create a Fentaris proxy with the express-like routing API.
 * @pk
 */
export const fentaris = createProxy;

class McpProxyMcpHandle implements ProxyMcpHandle {
  constructor(
    private readonly proxy: McpProxy,
    readonly name: string,
    private readonly groupId?: string,
  ) {}

  use(handler: Middleware): ProxyMcpHandle {
    this.proxy.registerServerMiddleware(this.name, handler, this.groupId);
    return this;
  }

  tool(pattern: ProxyToolPattern, handler: ProxyToolHandler): ProxyMcpHandle {
    this.proxy.registerServerTool(this.name, pattern, handler, this.groupId);
    return this;
  }

  operation(operation: ProxyContext["operation"], handler: ProxyOperationHandler): ProxyMcpHandle {
    this.proxy.registerServerOperation(this.name, operation, handler, this.groupId);
    return this;
  }

  on(eventName: ProxyEventName, handler: ProxyEventHandler): ProxyMcpHandle;
  on(eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): ProxyMcpHandle;
  on(
    eventName: ProxyEventName,
    filterOrHandler: ProxyEventFilter | ProxyEventHandler,
    maybeHandler?: ProxyEventHandler,
  ): ProxyMcpHandle {
    const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`Missing handler for proxy event "${eventName}"`);
    }
    this.proxy.registerServerEvent(this.name, eventName, filter, handler, this.groupId);
    return this;
  }

  ping(): Promise<HealthCheckResult> {
    return this.proxy.pingMcp(this.name);
  }

  health(): Promise<HealthCheckResult> {
    return this.proxy.mcpHealth(this.name);
  }
}

class McpProxyGroupHandle implements ProxyGroupHandle {
  constructor(
    private readonly proxy: McpProxy,
    readonly id: string,
  ) {}

  mcp(name: string): ProxyMcpHandle {
    return new McpProxyMcpHandle(this.proxy, name, this.id);
  }

  users(...users: User[]): ProxyGroupHandle {
    this.proxy.addGroupUsers(this.id, users);
    return this;
  }

  policy(policyNameOrPolicy: string | Policy): ProxyGroupHandle {
    this.proxy.setGroupPolicy(this.id, policyNameOrPolicy);
    return this;
  }

  use(handler: Middleware): ProxyGroupHandle {
    this.proxy.registerGroupMiddleware(this.id, handler);
    return this;
  }

  operation(operation: ProxyContext["operation"], handler: ProxyOperationHandler): ProxyGroupHandle {
    this.proxy.registerGroupOperation(this.id, operation, handler);
    return this;
  }

  on(eventName: ProxyEventName, handler: ProxyEventHandler): ProxyGroupHandle;
  on(eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): ProxyGroupHandle;
  on(
    eventName: ProxyEventName,
    filterOrHandler: ProxyEventFilter | ProxyEventHandler,
    maybeHandler?: ProxyEventHandler,
  ): ProxyGroupHandle {
    const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`Missing handler for proxy event "${eventName}"`);
    }
    this.proxy.registerGroupEvent(this.id, eventName, filter, handler);
    return this;
  }
}

/**
 * Prefix tool descriptions with the server name.
 * @pk
 */
function annotateDescription(serverName: string, description: string | undefined): string {
  return description ? `[${serverName}] ${description}` : `Proxied from ${serverName}`;
}

/**
 * Normalize thrown values into Error instances.
 * @pk
 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeIdentityOptions(
  identity: McpProxyOptions["identity"] | undefined,
  required = false,
): IdentityResolverOptions | undefined {
  if (!identity) {
    return undefined;
  }

  return "strategy" in identity ? { required, ...identity } : { strategy: identity, required };
}

function hasDeclaredApiKeys(groups: Group[]): boolean {
  return groups.some((group) => group.users.some((user) => user.apiKeys.length > 0));
}

function declaredApiKeyIdentityStrategy(groups: () => Group[]): IdentityStrategy | undefined {
  if (!hasDeclaredApiKeys(groups())) {
    return undefined;
  }

  return {
    name: "declared-api-key",
    async resolve(request) {
      const apiKey = request.headers?.["x-fentaris-api-key"];
      if (!apiKey) {
        return null;
      }

      for (const user of groups().flatMap((group) => group.users)) {
        for (const source of user.apiKeys) {
          const candidate = await resolveCredentialSource(source);
          if (FentarisAuth.compareApiKey(candidate, apiKey)) {
            return { id: user.id };
          }
        }
      }

      return null;
    },
  };
}

function toUpstreamEnv(binding: ServerCredentialBinding, credential: string): Record<string, string> {
  if (binding.type === "bearer") {
    return { AUTHORIZATION: `Bearer ${credential}` };
  }

  if (binding.type === "header") {
    return { [binding.header]: credential };
  }

  return { [binding.env]: credential };
}

function isRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serverNameFromProxyTool(toolName: string): string {
  try {
    return fromProxyToolName(toolName).serverName;
  } catch {
    return "*";
  }
}

function isRateLimiter(value: unknown): value is RateLimiter {
  return (
    value !== null &&
    typeof value === "object" &&
    "checkLimit" in value &&
    "recordCall" in value &&
    "getRemainingCalls" in value
  );
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(", ");
    } else if (value !== undefined) {
      normalized[key.toLowerCase()] = value;
    }
  }

  return normalized;
}

function isOnlyLifecycleCheckDegraded(report: HealthReport): boolean {
  return report.checks.every((check) => {
    if (check.name === "runtime.lifecycle") {
      return check.status === "degraded";
    }
    return check.status === "ok";
  });
}

function normalizeAutoLog(autoLog: McpProxyOptions["autoLog"] | undefined): Required<AutoLogOptions> | null {
  if (!autoLog) {
    return null;
  }

  const options = autoLog === true ? {} : autoLog;
  if (options.enabled === false) {
    return null;
  }

  return {
    enabled: true,
    startLevel: options.startLevel ?? "debug",
    successLevel: options.successLevel ?? "info",
    failureLevel: options.failureLevel ?? "error",
  };
}

function capabilityErrorContext(context: ProxyContext): Record<string, unknown> {
  return {
    server: context.server?.name,
    group: context.policy.matchedGroups[0],
    user: context.user.id,
    operation: context.operation,
    target: context.tool?.name ?? context.resource?.uri ?? context.resource?.uriTemplate ?? context.prompt?.name ?? context.completion?.target,
    transport: context.transport,
  };
}

function isTimeoutError(error: Error): boolean {
  return /timed out|timeout/i.test(error.message);
}

function parseTimeoutMs(message: string): number | undefined {
  const match = message.match(/after\s+(\d+)ms/i);
  return match ? Number(match[1]) : undefined;
}
