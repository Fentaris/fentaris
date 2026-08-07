import { existsSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer } from "node:http";
import path from "node:path";
import { compileToolPattern, matchesToolPattern, type RouteEntry } from "./routes.js";
import { createContextualLogger, createProxyContext, createPolicyCan, createCapabilityContext } from "./context.js";
import { isCapabilityAllowed } from "./capabilities.js";
import { dispatchRouteHandler } from "./middleware.js";
import { routeCompletion, completionTarget, capabilityToolRequest, isStructuredPolicyErrorResult, toStructuredError } from "./operations.js";
import { operationEventName, matchesCallHook, dispatchCallHooks, emitProxyEvent, type EventEntry } from "./events.js";
import { emitLifecycle } from "./lifecycle.js";
import { createSdkServer } from "./sdkServer.js";
import { ServerCatalog } from "./serverCatalog.js";
import {
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
  fromProxyResourceUri,
  fromProxyToolName,
  toProxyPromptName,
  toProxyResourceTemplateUri,
  toProxyResourceUri,
  toProxyToolName,
} from "../nameMapping.js";
import { filterToolsByPolicy, toCapabilityRequest } from "../policy.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { FentarisAuth } from "../auth.js";
import { resolveCredentialSource, type CredentialSource, type CredentialSourceMap } from "../credentials/index.js";
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
import { startIntegratedEdgeControlPlane, type IntegratedEdgeControlPlaneRuntime } from "../transports/exposure/integratedRuntime.js";
import { ResponseController } from "../types/middleware.js";
import { FentarisConfigError, assertValidFentarisConfig, validateFentarisConfig, type FentarisDiagnostic } from "../config/index.js";
import { resolveFentarisConfig } from "../config/resolve.js";
import { LocalCapabilityRegistry } from "../local/declarations.js";
import {
  createSetupSchema,
  edgeError,
  validateSetupSchema,
  cloud as cloudTarget,
  detectStaticPlacementOverlaps,
  isValidTargetName,
  validateDeviceSelector,
  PlacementResolver,
  EdgeSessionPinner,
  EdgeChildBindingManager,
  EdgeSingleCallCoordinator,
  EdgeFanoutCoordinator,
  InMemoryEdgeChildBindingStore,
  EDGE_CONTROL_NAMESPACE,
  registerEdgeControlProvider,
  type DeviceResolver,
  type EdgeCapabilityCache,
  type EdgeTelemetry,
  type EdgeControlProviderOptions,
  type EdgeControlInvocationRequest,
  type EdgeTrustedChildRoute,
  type EdgeSessionSelectionStore,
  type ExecutionTarget,
  type PlacementBindingModel,
  type PlacementResolution,
  type PlacementRequest,
  type SessionBindingExpiryOptions,
  type SessionBindingListener,
  type SessionBindingStore,
  type SetupFieldDescriptor,
  type SetupSchema,
  type EdgeControlPlaneConfig,
  type SerializableEdgeControlPlaneConfig,
  validateEdgeControlPlaneConfig,
  parseSerializableEdgeControlPlaneConfig,
  mergeEdgeControlPlaneConfig,
} from "../edge/index.js";
import type { SessionPinRequest, SessionPinResult } from "../edge/index.js";
import type { LaunchRecipe } from "../edge/recipe.js";
import { compileEdgeDeploymentCatalog } from "../edge/integratedReconciliation.js";
import type { InstallationRecipe } from "../edge/installation.js";
import { StdioTransport } from "../transports/client/StdioTransport.js";
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
import type { FentarisTransport } from "../types/transport.js";
import type { ErrorMapper, IdentityStrategy, Policy, PolicyDecision, RateLimiter, Registry } from "../types/policy.js";
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
  ProxyLocalHandle,
  ProxyUserHandle,
  ProxyOperationHandler,
  ProxyToolHandler,
  ProxyToolPattern,
} from "../types/proxy.js";

type ProjectRuntimeDefaults = {
  port?: number;
  host?: string;
  path?: string;
  edgeControlPlane?: SerializableEdgeControlPlaneConfig;
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
    const edge = config.edge && typeof config.edge === "object" && !Array.isArray(config.edge)
      ? config.edge as Record<string, unknown>
      : undefined;
    const controlPlaneDiagnostics: FentarisDiagnostic[] = [];
    const edgeControlPlane = edge?.controlPlane !== undefined
      ? parseSerializableEdgeControlPlaneConfig(edge.controlPlane, controlPlaneDiagnostics)
      : undefined;
    void controlPlaneDiagnostics;
    return {
      ...(typeof config.port === "number" ? { port: config.port } : {}),
      ...(typeof config.host === "string" ? { host: config.host } : {}),
      ...(typeof config.path === "string" ? { path: config.path } : {}),
      ...(edgeControlPlane ? { edgeControlPlane } : {}),
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

type PlacementScope = "global" | "group" | "user";

/** A placement binding declared through fluent or constructor-style config. @pk */
export type PlacementBindingConfig = {
  /** Server name the binding applies to. @pk */
  serverName: string;
  /** Scope of the binding. @pk */
  scope: PlacementScope;
  /** Group id for group-scoped bindings. @pk */
  groupId?: string;
  /** User id for user-scoped bindings. @pk */
  userId?: string;
  /** Registered or built-in target name. @pk */
  targetName: string;
};

type PlacementBinding = PlacementBindingConfig;

const CLOUD_TARGET_NAME = "cloud";

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
  /** Constructor-style execution-target declarations. @pk */
  targets?: Record<string, ExecutionTarget>;
  /** Constructor-style per-server setup schemas. @pk */
  setup?: Record<string, Record<string, SetupFieldDescriptor> | SetupSchema>;
  /** Constructor-style managed installation recipes keyed by MCP server name. @pk */
  installations?: Record<string, InstallationRecipe>;
  /** Constructor-style placement bindings. @pk */
  placements?: PlacementBindingConfig[];
  /** Agent-facing CLI configuration. @pk */
  cli?: FentarisCliOptions;
  /**
   * Edge execution wiring: control-plane device resolver, replaceable
   * session-binding store, expiry, and removal listener. When omitted, edge
   * targets cannot be pinned and the runtime behaves as cloud-only.
   * @pk
   */
  edge?: EdgeRuntimeOptions;
};

/**
 * Agent-facing CLI configuration embedded in Fentaris app config.
 * @pk
 */
export type FentarisCliOptions = {
  /** Configured MCP account selectors available to CLI discovery/auth commands. @pk */
  mcpAccounts?: Record<string, FentarisCliMcpAccountConfig>;
};

/**
 * CLI account selector configuration for one MCP server.
 * @pk
 */
export type FentarisCliMcpAccountConfig = {
  /** Default selector used when `--as` is omitted for this MCP. @pk */
  default: string;
  /** Selectors the CLI may use for this MCP. @pk */
  allowed: string[];
};

/**
 * Edge runtime wiring supplied to {@link McpProxyOptions.edge}.
 * @pk
 */
export type EdgeRuntimeOptions = {
  /** Control-plane device resolver used to pin edge targets. @pk */
  deviceResolver?: DeviceResolver;
  /** Replaceable session-binding store; defaults to in-memory. @pk */
  sessionBindingStore?: SessionBindingStore;
  /** Expiry configuration for the default in-memory binding store. @pk */
  sessionBindingExpiry?: SessionBindingExpiryOptions;
  /** Removal listener for session-target bindings. @pk */
  sessionBindingListener?: SessionBindingListener;
  /** Virtual edge transport used after an edge target has been pinned. @pk */
  transport?: FentarisTransport;
  /** Validated per-deployment manifest cache used by edge discovery. @pk */
  capabilityCache?: EdgeCapabilityCache;
  /** Structured, redacted edge lifecycle telemetry. @pk */
  telemetry?: EdgeTelemetry;
  /** Durable store for agent-requested pre-pin selections. @pk */
  sessionSelectionStore?: EdgeSessionSelectionStore;
  /** Explicit opt-in configuration for the governed Edge Control provider. @pk */
  control?: ({ readonly enabled: true } & EdgeControlProviderOptions) | { readonly enabled?: false };
  /** Optional managed child-binding manager for explicit orchestration. @pk */
  childBindingManager?: EdgeChildBindingManager;
  /**
   * Integrated Edge control-plane configuration. When enabled, `app.start()`
   * mounts authorization, enrollment, revocation, and gateway routes. Disabled
   * by default; omitting this field preserves low-level edge wiring only.
   * @pk
   */
  controlPlane?: EdgeControlPlaneConfig;
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
  private readonly localRegistry = new LocalCapabilityRegistry();
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
  private readonly targets = new Map<string, ExecutionTarget>();
  private readonly setupSchemas = new Map<string, SetupSchema>();
  private readonly installationRecipes = new Map<string, InstallationRecipe>();
  private readonly placementBindings: PlacementBinding[] = [];
  private readonly fluentUsers = new Set<string>();
  private readonly edgeOptions?: EdgeRuntimeOptions;
  private edgeSessionPinnerCache?: EdgeSessionPinner;
  private edgeChildBindingManagerCache?: EdgeChildBindingManager;
  private edgeSingleCallCoordinatorCache?: EdgeSingleCallCoordinator;
  private edgeFanoutCoordinatorCache?: EdgeFanoutCoordinator;
  private readonly edgeChildExecution = new AsyncLocalStorage<EdgeTrustedChildRoute>();
  private readonly edgeChildParentSessions = new Set<string>();
  private httpServer: HttpServer | null = null;
  private readonly exposureHandles = new Set<ProxyExposureHandle>();
  private edgeControlPlaneRuntime?: IntegratedEdgeControlPlaneRuntime;

  private static readonly BUILTIN_TARGET_NAMES = new Set<string>([CLOUD_TARGET_NAME]);

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
    this.defaultHost = options.host ?? projectDefaults.host;
    this.defaultPath = options.path ?? projectDefaults.path ?? "/mcp";
    const mergedControlPlane = mergeEdgeControlPlaneConfig(
      options.edge?.controlPlane,
      projectDefaults.edgeControlPlane,
    );
    this.edgeOptions = options.edge || mergedControlPlane
      ? {
          ...options.edge,
          ...(mergedControlPlane ? { controlPlane: mergedControlPlane } : {}),
        }
      : undefined;
    this.runtimeValidationConfig = {
      ...options,
      servers: this.servers,
      groups: this.groups,
      defaults: { credentials: this.defaultCredentials },
      ...(this.edgeOptions ? { edge: this.edgeOptions } : {}),
    };

    if (options.edge?.control?.enabled) {
      const configured = options.edge.control.invoker;
      registerEdgeControlProvider(this.localRegistry.namespace(EDGE_CONTROL_NAMESPACE), {
        ...options.edge.control,
        invoker: {
          call: (request) => configured?.call(request) ?? this.invokeEdgeControlCall(request),
          callMany: (request) => configured?.callMany(request) ?? this.invokeEdgeControlCallMany(request),
        },
      });
      this.materializeLocalNamespaces();
    }

    for (const server of this.serverCatalog.allServers()) {
      this.serverByName.set(server.name, server);
    }

    // Normalize constructor-style target, setup, and placement declarations
    // into the same internal model the fluent API uses. @pk
    if (options.targets) {
      for (const [name, target] of Object.entries(options.targets)) {
        if (!isValidTargetName(name) || McpProxy.BUILTIN_TARGET_NAMES.has(name)) {
          continue;
        }
        this.targets.set(name, target.kind === "cloud" ? cloudTarget : target);
      }
    }
    if (options.setup) {
      for (const [serverName, schema] of Object.entries(options.setup)) {
        if (!this.serverByName.has(serverName)) {
          continue;
        }
        const built = "version" in schema && "fields" in schema ? (schema as SetupSchema) : createSetupSchema(schema as Record<string, SetupFieldDescriptor>);
        this.setupSchemas.set(serverName, built);
      }
    }
    if (options.installations) {
      for (const [serverName, recipe] of Object.entries(options.installations)) {
        if (this.serverByName.has(serverName)) this.installationRecipes.set(serverName, recipe);
      }
    }
    if (options.placements) {
      for (const binding of options.placements) {
        this.registerPlacementBinding(binding);
      }
    }
  }

  /**
   * Register a middleware handler.
   * @pk
   */
  use(middleware: ProxyMiddleware): this;
  use(middleware: LegacyMiddleware): this;
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
      if (this.localRegistry.hasNamespace(name)) {
        throw this.localNamespaceCollisionError(name);
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
   * Register or retrieve a scoped upstream MCP handle.
   * Alias for `mcp(...)`.
   * @pk
   */
  server(name: string): ProxyMcpHandle;
  server(name: string, options: ProxyMcpDeclarationOptions): ProxyMcpHandle;
  server(name: string, server: McpServer): ProxyMcpHandle;
  server(config: ProxyMcpDeclarationConfig): ProxyMcpHandle;
  server(
    nameOrConfig: string | ProxyMcpDeclarationConfig,
    optionsOrServer?: ProxyMcpDeclarationOptions | McpServer,
  ): ProxyMcpHandle {
    if (typeof nameOrConfig !== "string") {
      return this.mcp(nameOrConfig);
    }

    if (optionsOrServer instanceof McpServer) {
      return this.mcp(nameOrConfig, optionsOrServer);
    }

    return optionsOrServer ? this.mcp(nameOrConfig, optionsOrServer) : this.mcp(nameOrConfig);
  }

  /**
   * Register or retrieve a named local MCP capability namespace.
   * @pk
   */
  local(name: string): ProxyLocalHandle {
    if (name === EDGE_CONTROL_NAMESPACE) {
      throw new FentarisConfigError([{
        severity: "error",
        code: "FENTARIS_CONFIG_LOCAL_NAMESPACE_RESERVED",
        title: "Reserved local namespace",
        message: `Local namespace "${name}" is reserved for the opt-in Edge Control provider.`,
        path: ["proxy", "local", name],
        hint: "Enable edge.control or choose another local namespace.",
      }]);
    }
    const namespace = this.localRegistry.namespace(name);
    this.materializeLocalNamespaces();
    return namespace;
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
   * Register or retrieve a reusable named execution target. Target bindings
   * describe where an MCP runs and never grant MCP capability access. The
   * built-in `cloud` target always executes the configured transport on the
   * Fentaris host and need not be registered.
   * @pk
   */
  target(name: string, target?: ExecutionTarget): this {
    if (!isValidTargetName(name)) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_TARGET_INVALID_NAME",
          title: "Invalid execution target name",
          message: `Execution target name "${name}" is not a valid identifier.`,
          path: ["proxy", "target", name],
          hint: "Use lowercase letters, digits, and hyphens; start with a letter or digit; 1-63 characters.",
        },
      ]);
    }
    if (McpProxy.BUILTIN_TARGET_NAMES.has(name)) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_TARGET_RESERVED",
          title: "Reserved execution target name",
          message: `Execution target name "${name}" is reserved.`,
          path: ["proxy", "target", name],
          hint: "Choose a different name; \"cloud\" is always available as the implicit target.",
        },
      ]);
    }
    if (target === undefined) {
      return this; // retrieval-only form `app.target(name)` is not supported; ignore harmlessly
    }
    if (!target || (target.kind !== "cloud" && target.kind !== "edge")) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_TARGET_INVALID",
          title: "Invalid execution target",
          message: `Execution target "${name}" is not a cloud or edge target.`,
          path: ["proxy", "target", name],
        },
      ]);
    }
    if (this.targets.has(name)) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_TARGET_DUPLICATE",
          title: "Duplicate execution target",
          message: `Execution target "${name}" is already declared.`,
          path: ["proxy", "target", name],
          hint: "Reuse the named target via app.mcp(name).target(name).",
        },
      ]);
    }
    const stored = target.kind === "cloud" ? cloudTarget : target;
    this.targets.set(name, stored);
    this.runtimeValidationConfig = { ...this.runtimeValidationConfig };
    return this;
  }

  /** Resolve a registered or built-in target by name. @pk */
  resolveTarget(name: string): ExecutionTarget {
    const known = this.targets.get(name);
    if (known) {
      return known;
    }
    if (McpProxy.BUILTIN_TARGET_NAMES.has(name)) {
      return cloudTarget;
    }
    throw new FentarisConfigError([
      {
        severity: "error",
        code: "FENTARIS_CONFIG_TARGET_UNKNOWN",
        title: "Unknown execution target",
        message: `Execution target "${name}" is not registered.`,
        path: ["proxy", "target", name],
        hint: "Declare it with app.target(name, edge(...)) or use the built-in \"cloud\" target.",
      },
    ]);
  }

  /**
   * Build a {@link PlacementResolver} over the registered targets and
   * normalized placement bindings. The resolver never grants capability
   * access; callers must have already established server-catalog visibility
   * and policy authorization before relying on its result.
   * @pk
   */
  placementResolver(): PlacementResolver {
    return new PlacementResolver({
      targets: this.targets,
      bindings: this.placementBindings as readonly PlacementBindingModel[],
    });
  }

  /**
   * Resolve a placement for an already-authorized request. Intended to be
   * called at dispatch time, after server-catalog visibility and policy
   * authorization have established that the subject may use the server.
   * Throws `EDGE_UNAUTHORIZED_TARGET` for an ineligible explicit selection and
   * `EDGE_PLACEMENT_AMBIGUOUS` for unresolved runtime group overlap.
   * @pk
   */
  resolvePlacement(request: PlacementRequest): PlacementResolution {
    return this.placementResolver().resolve(request);
  }

  /**
   * Lazily build (and cache) the edge session pinner over the registered
   * targets, normalized bindings, and configured device resolver. Returns
   * `undefined` when no device resolver is configured (cloud-only runtime).
   * @pk
   */
  edgeSessionPinner(): EdgeSessionPinner | undefined {
    const deviceResolver = this.edgeOptions?.deviceResolver ?? this.edgeControlPlaneRuntime?.deviceResolver;
    if (!deviceResolver) {
      return undefined;
    }
    if (!this.edgeSessionPinnerCache) {
      const pinner = new EdgeSessionPinner({
        targets: this.targets,
        bindings: this.placementBindings as readonly PlacementBindingModel[],
        deviceResolver,
        store: this.edgeOptions?.sessionBindingStore,
        expiry: this.edgeOptions?.sessionBindingExpiry,
        selectionStore: this.edgeOptions?.sessionSelectionStore,
      });
      if (this.edgeOptions?.sessionBindingListener) {
        pinner.addListener(this.edgeOptions.sessionBindingListener);
      }
      this.edgeSessionPinnerCache = pinner;
    }
    return this.edgeSessionPinnerCache;
  }

  /**
   * Lazily resolve and pin a downstream session to one eligible edge device
   * per logical target before the first edge-dependent operation. Cloud
   * targets return without pinning. Throws normalized edge errors.
   * @pk
   */
  async pinSessionTarget(request: SessionPinRequest): Promise<SessionPinResult> {
    const pinner = this.edgeSessionPinner();
    if (!pinner) {
      const placement = this.resolvePlacement(request);
      if (placement.kind === "edge") {
        throw edgeError("EDGE_UNAVAILABLE", "Edge placement requires a configured device resolver.", {
          details: { targetName: placement.targetName },
        });
      }
      return { kind: "cloud", targetName: "cloud", placement };
    }
    return pinner.pin(request);
  }

  /**
   * Dispatch an already-visible and already-authorized server operation to its
   * cloud transport or pinned edge transport. Placement never participates in
   * catalog visibility or policy decisions.
   */
  private async dispatchTargetOperation<T>(
    server: McpServer,
    context: ProxyContext,
    cloud: () => Promise<T>,
    edge: (transport: FentarisTransport) => Promise<T>,
  ): Promise<T> {
    const child = this.edgeChildExecution.getStore();
    if (child) {
      if (child.deploymentId !== server.name) {
        throw edgeError("EDGE_PROTOCOL", "Trusted child route does not match the effective tool deployment.");
      }
      const edgeTransport = this.edgeOptions?.transport ?? this.edgeControlPlaneRuntime?.transport;
      if (!edgeTransport) throw edgeError("EDGE_UNAVAILABLE", "No Edge transport is configured for explicit invocation.");
      context.transport = {
        ...context.transport,
        sessionId: child.childSessionId,
        requestId: child.childRequestId,
        deadline: child.deadline,
        signal: child.signal,
      };
      context.requestId = child.childRequestId;
      context.execution = {
        kind: "edge",
        targetName: child.targetName,
        deploymentId: child.deploymentId,
        edgeNodeId: child.edgeNodeId,
        connectionGeneration: child.connectionGeneration,
        reused: false,
      };
      const run = () => edge(edgeTransport);
      return edgeTransport.withProxyContext ? edgeTransport.withProxyContext(context, run) : run();
    }
    const metadata = context.auth.metadata;
    const groupIds = context.subject
      ? (this.subjectIndex?.groupsFor(context.subject.id) ?? []).map((group) => group.id)
      : [];
    const placementRequest: PlacementRequest = {
      serverName: server.name,
      groupIds,
      ...(context.subject?.id ?? context.user.id
        ? { subjectId: context.subject?.id ?? context.user.id }
        : {}),
      ...(metadataString(metadata, "target") ?? metadataString(metadata, "requestedTarget")
        ? { requestedTarget: metadataString(metadata, "target") ?? metadataString(metadata, "requestedTarget") }
        : {}),
    };
    const placement = this.resolvePlacement(placementRequest);
    await this.edgeOptions?.telemetry?.emit({
      name: "edge.target.resolved",
      subjectId: context.subject?.id ?? context.user.id,
      tenantId: metadataString(metadata, "tenantId"),
      targetName: placement.targetName,
      deploymentId: server.name,
      downstreamSessionId: context.transport.sessionId,
      outcome: placement.kind,
      metadata: { source: placement.source },
    }).catch(() => undefined);
    if (placement.kind === "cloud") {
      this.assertCloudLaunchReady(server);
      context.execution = {
        kind: "cloud",
        targetName: placement.targetName,
        deploymentId: server.name,
      };
      return server.withProxyContext(context, cloud);
    }

    const capabilityCache = this.edgeOptions?.capabilityCache ?? this.edgeControlPlaneRuntime?.capabilityCache;
    if (capabilityCache && isDiscoveryOperation(context.operation)) {
      const tenantId = metadataString(metadata, "tenantId")
        ?? (typeof context.subject?.metadata?.tenantId === "string" ? context.subject.metadata.tenantId : undefined)
        ?? "default";
      context.execution = {
        kind: "edge-cache",
        targetName: placement.targetName,
        deploymentId: server.name,
        tenantId,
      };
      const discovery = capabilityCache.discoveryTransport(tenantId, server.name);
      const run = () => edge(discovery);
      return discovery.withProxyContext ? discovery.withProxyContext(context, run) : run();
    }

    const sessionId = context.transport.sessionId;
    if (!sessionId) {
      throw edgeError("EDGE_UNAVAILABLE", "Edge execution requires a downstream MCP session.", {
        details: { targetName: placement.targetName, serverName: server.name },
      });
    }
    const edgeTransport = this.edgeOptions?.transport ?? this.edgeControlPlaneRuntime?.transport;
    if (!edgeTransport) {
      throw edgeError("EDGE_UNAVAILABLE", "No edge transport is configured for the selected target.", {
        details: { targetName: placement.targetName, serverName: server.name },
      });
    }
    const pin = await this.pinSessionTarget({
      ...placementRequest,
      sessionId,
      ...(metadataString(metadata, "requestedDeviceId")
        ? { requestedDeviceId: metadataString(metadata, "requestedDeviceId") }
        : {}),
      ...(metadataString(metadata, "tenantId") ? { tenantId: metadataString(metadata, "tenantId") } : {}),
      ...(metadataNumber(metadata, "connectionGeneration") !== undefined
        ? { connectionGeneration: metadataNumber(metadata, "connectionGeneration") }
        : {}),
    });
    if (pin.kind !== "edge") {
      throw edgeError("EDGE_PROTOCOL", "Edge placement unexpectedly resolved to cloud during pinning.", {
        details: { targetName: placement.targetName, serverName: server.name },
      });
    }
    context.execution = {
      kind: "edge",
      targetName: pin.targetName,
      deploymentId: server.name,
      edgeNodeId: pin.binding.edgeNodeId,
      connectionGeneration: pin.binding.connectionGeneration,
      reused: pin.reused,
    };
    await this.edgeOptions?.telemetry?.emit({
      name: "edge.session.bound",
      subjectId: context.subject?.id ?? context.user.id,
      tenantId: metadataString(metadata, "tenantId"),
      targetName: pin.targetName,
      deploymentId: server.name,
      edgeNodeId: pin.binding.edgeNodeId,
      connectionGeneration: pin.binding.connectionGeneration,
      downstreamSessionId: sessionId,
      outcome: pin.reused ? "reused" : "created",
    }).catch(() => undefined);
    const run = () => edge(edgeTransport);
    return edgeTransport.withProxyContext ? edgeTransport.withProxyContext(context, run) : run();
  }

  /** Compile and validate a cloud stdio recipe before dispatch can start it. */
  private assertCloudLaunchReady(server: McpServer): void {
    if (!(server.transport instanceof StdioTransport)) {
      return;
    }
    const recipe = server.transport.toLaunchRecipe(this.setupSchemas.get(server.name));
    const unresolved = server.transport.unresolvedCloudRuntimeRefs();
    if (unresolved.length > 0) {
      throw edgeError("EDGE_UNRESOLVED_RUNTIME_INPUT", `Cloud launch for "${server.name}" has unresolved runtime inputs.`, {
        details: { serverName: server.name, refs: unresolved, recipeDigest: recipe.digest },
      });
    }
  }

  /** Remove every session-target binding for a downstream session. @pk */
  async endEdgeSession(sessionId: string): Promise<void> {
    await this.edgeSessionPinner()?.endSession(sessionId);
    await this.edgeChildBindingManagerCache?.endParent(sessionId);
    this.edgeChildParentSessions.delete(sessionId);
  }

  /** Remove every session-target binding on runtime shutdown. @pk */
  async shutdownEdgeSessions(): Promise<void> {
    await this.edgeSessionPinner()?.shutdown();
    await this.edgeChildBindingManagerCache?.shutdown([...this.edgeChildParentSessions]);
    this.edgeChildParentSessions.clear();
    this.edgeSessionPinnerCache = undefined;
    this.edgeSingleCallCoordinatorCache = undefined;
    this.edgeFanoutCoordinatorCache = undefined;
    this.edgeChildBindingManagerCache = undefined;
  }

  private edgeChildBindingManager(): EdgeChildBindingManager {
    if (!this.edgeChildBindingManagerCache) {
      this.edgeChildBindingManagerCache = this.edgeOptions?.childBindingManager
        ?? new EdgeChildBindingManager({ store: new InMemoryEdgeChildBindingStore() });
    }
    return this.edgeChildBindingManagerCache;
  }

  private edgeSingleCallCoordinator(): EdgeSingleCallCoordinator {
    const control = this.edgeOptions?.control;
    if (!control?.enabled) throw edgeError("EDGE_UNAVAILABLE", "Edge Control is not enabled.");
    if (!this.edgeSingleCallCoordinatorCache) {
      this.edgeSingleCallCoordinatorCache = new EdgeSingleCallCoordinator({
        inventory: control.inventory,
        children: this.edgeChildBindingManager(),
        listTools: async (user, identity, subject) => (await this.listTools(undefined, user, identity, subject)).tools,
        dispatch: (route, toolName, args, context) => {
          this.edgeChildParentSessions.add(route.parentSessionId);
          return this.edgeChildExecution.run(route, () => this.callTool(
            { name: toolName, arguments: args },
            context.user,
            context.identity,
            context.subject,
          ));
        },
      });
    }
    return this.edgeSingleCallCoordinatorCache;
  }

  private invokeEdgeControlCall(request: EdgeControlInvocationRequest): Promise<CallToolResult> {
    return this.edgeSingleCallCoordinator().call(request.context, request.arguments);
  }

  private edgeFanoutCoordinator(): EdgeFanoutCoordinator {
    const control = this.edgeOptions?.control;
    if (!control?.enabled) throw edgeError("EDGE_UNAVAILABLE", "Edge Control is not enabled.");
    if (!this.edgeFanoutCoordinatorCache) {
      this.edgeFanoutCoordinatorCache = new EdgeFanoutCoordinator({
        inventory: control.inventory,
        single: this.edgeSingleCallCoordinator(),
        limits: control.limits,
        telemetry: this.edgeOptions?.telemetry,
        approve: control.approveOrchestration,
      });
    }
    return this.edgeFanoutCoordinatorCache;
  }

  private invokeEdgeControlCallMany(request: EdgeControlInvocationRequest): Promise<CallToolResult> {
    return this.edgeFanoutCoordinator().callMany(request.context, request.arguments);
  }

  /** Register a setup schema for a server. @pk */
  registerServerSetup(serverName: string, schema: Record<string, SetupFieldDescriptor> | SetupSchema): void {
    if (!this.serverByName.has(serverName)) {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_HANDLE_UNKNOWN_SERVER",
          title: "Setup schema references an unknown server",
          message: `Setup schema for "${serverName}" does not match a configured upstream MCP server.`,
          path: ["proxy", "mcp", serverName, "setup"],
        },
      ]);
    }
    const built = "version" in schema && "fields" in schema ? (schema as SetupSchema) : createSetupSchema(schema as Record<string, SetupFieldDescriptor>);
    this.setupSchemas.set(serverName, built);
  }

  /** Record a placement binding unless a conflicting one already exists. @pk */
  registerPlacementBinding(binding: PlacementBinding): void {
    const existing = this.placementBindings.find(
      (entry) =>
        entry.serverName === binding.serverName &&
        entry.scope === binding.scope &&
        entry.groupId === binding.groupId &&
        entry.userId === binding.userId &&
        entry.targetName === binding.targetName,
    );
    if (existing) {
      return;
    }
    this.placementBindings.push(binding);
  }

  /**
   * Retrieve a user-scoped MCP handle. Records placement bindings without
   * creating or authenticating a subject.
   * @pk
   */
  user(userId: string): ProxyUserHandle {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new FentarisConfigError([
        {
          severity: "error",
          code: "FENTARIS_CONFIG_USER_ID_EMPTY",
          title: "Empty user id",
          message: "app.user(id) requires a non-empty subject id.",
          path: ["proxy", "user"],
        },
      ]);
    }
    this.fluentUsers.add(userId);
    return new McpProxyUserHandle(this, userId);
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
      await this.assertRuntimeCredentialsAvailable();
      const port = options.port ?? this.defaultPort ?? 3000;
      const host = options.host ?? this.defaultHost;
      const path = options.path ?? this.defaultPath;
      let httpRoutes: IntegratedEdgeControlPlaneRuntime["httpRoutes"] | undefined;
      let upgradeRoutes: IntegratedEdgeControlPlaneRuntime["upgradeRoutes"] | undefined;

      try {
        if (this.edgeOptions?.controlPlane?.enabled === true) {
          const catalog = compileEdgeDeploymentCatalog({
            servers: this.serverCatalog.allServers(),
            targets: this.targets,
            bindings: this.placementBindings as readonly PlacementBindingModel[],
            setupSchemas: this.setupSchemas,
            installationRecipes: this.installationRecipes,
          });
          this.edgeControlPlaneRuntime = await startIntegratedEdgeControlPlane({
            controlPlane: this.edgeOptions.controlPlane,
            listenerHost: host ?? "127.0.0.1",
            listenerPort: port,
            catalog,
            groupsForSubject: (subjectId) => (this.subjectIndex?.groupsFor(subjectId) ?? []).map((group) => group.id),
            telemetry: this.edgeOptions.telemetry,
            ...(this.edgeOptions.controlPlane.publicOrigin
              ? { publicOrigin: this.edgeOptions.controlPlane.publicOrigin }
              : {}),
          });
          httpRoutes = this.edgeControlPlaneRuntime.httpRoutes;
          upgradeRoutes = this.edgeControlPlaneRuntime.upgradeRoutes;
        }

        const handle = await this.listenInternal(
          new HttpProxyExposureTransport({
            port,
            host,
            path,
            ...(httpRoutes ? { httpRoutes } : {}),
            ...(upgradeRoutes ? { upgradeRoutes } : {}),
            onStarted: () => {
              this.printStartupBanner(port, path, host);
              callback?.();
            },
          }),
        );
        this.httpServer = handle.server;
        return this.httpServer;
      } catch (error) {
        await this.edgeControlPlaneRuntime?.close().catch(() => undefined);
        this.edgeControlPlaneRuntime = undefined;
        throw error;
      }
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

    return this.lifecycle.start(async () => {
      await this.assertRuntimeCredentialsAvailable();
      return this.listenInternal(transport);
    }, {
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
    this.materializeLocalNamespaces();
    this.refreshDerivedGovernanceState({ validate: true });
    assertValidFentarisConfig(this.runtimeValidationConfig);
    const edgeDiagnostics = this.validateEdgeConfiguration();
    if (edgeDiagnostics.length > 0) {
      throw new FentarisConfigError(edgeDiagnostics);
    }
  }

  private async assertRuntimeCredentialsAvailable(): Promise<void> {
    const requirements = new Map<string, { source: CredentialSource; usages: string[] }>();
    const add = (source: CredentialSource, usage: string) => {
      const key = credentialReadinessKey(source);
      const existing = requirements.get(key);
      if (existing) existing.usages.push(usage);
      else requirements.set(key, { source, usages: [usage] });
    };

    for (const [reference, source] of Object.entries(this.defaultCredentials)) add(source, `default credential ${reference}`);
    for (const group of this.groups) {
      for (const [reference, source] of Object.entries(group.credentials)) add(source, `group ${group.id} credential ${reference}`);
      for (const user of group.users) {
        for (const [reference, source] of Object.entries(user.credentials)) add(source, `user ${user.id} credential ${reference}`);
        for (const source of user.apiKeys) add(source, `user ${user.id} API key`);
      }
    }

    const unavailable: Array<{ source: string; locator: string; usages: string[] }> = [];
    await Promise.all([...requirements.values()].map(async (requirement) => {
      try {
        await resolveCredentialSource(requirement.source);
      } catch {
        unavailable.push({
          source: requirement.source.type,
          locator: requirement.source.type === "env"
            ? requirement.source.name
            : `${requirement.source.file ?? ".fentaris/credentials.enc.json"}#${requirement.source.path}`,
          usages: [...new Set(requirement.usages)].sort(),
        });
      }
    }));

    if (unavailable.length === 0) return;
    unavailable.sort((left, right) => `${left.source}:${left.locator}`.localeCompare(`${right.source}:${right.locator}`));
    const lines = unavailable.flatMap((entry) => entry.usages.map((usage) => `- ${usage} (${entry.source}:${entry.locator})`));
    throw new FentarisRuntimeError(`Declared credentials are unavailable:\n${lines.join("\n")}`, {
      code: "FENTARIS_CREDENTIALS_UNAVAILABLE",
      hints: ["Run fentaris secrets setup before starting the proxy."],
      context: { requirements: unavailable },
    });
  }

  /**
   * Validate fluent and constructor-style target, setup, and placement
   * declarations: unresolved user handles, missing targets, duplicate
   * conflicting bindings, incompatible setup fields, undeclared runtime
   * references, unused required fields, and unsafe secret defaults. Target
   * bindings never grant MCP capability access.
   * @pk
   */
  validateEdgeConfiguration(): FentarisDiagnostic[] {
    const diagnostics: FentarisDiagnostic[] = [];

    // Unresolved user handles: a user-scoped binding whose subject has no
    // corresponding declared user in any group. We cannot know at config time
    // whether an identity strategy will resolve it, so flag only the missing
    // declared-subject case as a warning. @pk
    const declaredUserIds = new Set<string>();
    for (const group of this.groups) {
      for (const user of group.users) {
        declaredUserIds.add(user.id);
      }
    }
    for (const userId of this.fluentUsers) {
      if (!declaredUserIds.has(userId)) {
        const hasBinding = this.placementBindings.some((binding) => binding.userId === userId);
        if (hasBinding) {
          diagnostics.push({
            severity: "warning",
            code: "FENTARIS_CONFIG_USER_UNRESOLVED",
            title: "Unresolved user handle",
            message: `app.user("${userId}") records placement bindings but no declared subject resolves this id.`,
            path: ["proxy", "user", userId],
            hint: "Ensure an identity strategy or declared group user resolves this subject before relying on its bindings.",
          });
        }
      }
    }

    // Missing targets and duplicate conflicting bindings. @pk
    const conflictKey = (binding: PlacementBinding) =>
      `${binding.serverName}|${binding.scope}|${binding.groupId ?? ""}|${binding.userId ?? ""}`;
    const seen = new Map<string, string>();
    for (const binding of this.placementBindings) {
      const path = ["proxy", "placement", binding.serverName, binding.scope, binding.groupId ?? binding.userId ?? "global"];
      if (!this.serverByName.has(binding.serverName)) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_PLACEMENT_UNKNOWN_SERVER",
          title: "Placement binding references an unknown server",
          message: `Placement binding for "${binding.serverName}" does not match a configured upstream MCP server.`,
          path,
        });
        continue;
      }
      if (!this.targets.has(binding.targetName) && !McpProxy.BUILTIN_TARGET_NAMES.has(binding.targetName)) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_PLACEMENT_UNKNOWN_TARGET",
          title: "Placement binding references an unknown target",
          message: `Execution target "${binding.targetName}" is not registered.`,
          path,
          hint: "Declare it with app.target(name, edge(...)) or use the built-in \"cloud\" target.",
        });
      }
      const key = conflictKey(binding);
      const previous = seen.get(key);
      if (previous !== undefined && previous !== binding.targetName) {
        diagnostics.push({
          severity: "error",
          code: "FENTARIS_CONFIG_PLACEMENT_DUPLICATE",
          title: "Conflicting placement binding",
          message: `Server "${binding.serverName}" has multiple target bindings (${previous}, ${binding.targetName}) for the same ${binding.scope} scope.`,
          path,
        });
      } else if (previous === undefined) {
        seen.set(key, binding.targetName);
      }
    }

    // Setup schema validation and runtime-reference reconciliation. @pk
    for (const [serverName, schema] of this.setupSchemas) {
      const server = this.serverByName.get(serverName);
      const schemaPath = ["proxy", "mcp", serverName, "setup"];
      for (const diag of validateSetupSchema(schema)) {
        diagnostics.push({
          severity: diag.severity,
          code: diag.code,
          title: "Setup schema validation",
          message: diag.message,
          path: diag.field ? [...schemaPath, diag.field] : schemaPath,
        });
      }
      if (!server) {
        continue;
      }
      const recipe = this.serverLaunchRecipe(serverName);
      if (!recipe) {
        continue;
      }
      const fieldMap = schema.fields;
      const referenced = new Set(recipe.setupFieldRefs);

      // Undeclared runtime references: a token references a field not in the schema. @pk
      for (const ref of referenced) {
        if (!fieldMap[ref]) {
          diagnostics.push({
            severity: "error",
            code: "EDGE_SETUP_UNDECLARED_REFERENCE",
            title: "Undeclared runtime reference",
            message: `Runtime reference "${ref}" used by "${serverName}" is not declared in its setup schema.`,
            path: schemaPath,
            hint: `Add a matching setup field for "${ref}".`,
          });
        }
      }

      // Incompatible setup fields: a secret runtime reference must map to a secret field. @pk
      const secretRefs = this.collectSecretRuntimeRefs(server);
      for (const ref of secretRefs) {
        const field = fieldMap[ref];
        if (field && field.kind !== "secret") {
          diagnostics.push({
            severity: "error",
            code: "EDGE_SETUP_INCOMPATIBLE_FIELD",
            title: "Incompatible setup field",
            message: `Runtime secret reference "${ref}" is bound to a non-secret ${field.kind} field.`,
            path: [...schemaPath, ref],
          });
        }
      }

      // Unused required fields: a required field not referenced by the recipe. @pk
      for (const [fieldName, field] of Object.entries(fieldMap)) {
        if (field.required && !referenced.has(fieldName) && field.kind !== "secret") {
          diagnostics.push({
            severity: "warning",
            code: "EDGE_SETUP_UNUSED_REQUIRED",
            title: "Unused required setup field",
            message: `Required setup field "${fieldName}" is not referenced by the launch recipe.`,
            path: [...schemaPath, fieldName],
          });
        }
      }
    }

    // Statically overlapping group bindings with different targets are an
    // actionable configuration error at startup. Dynamic overlap that cannot
    // be known at startup is left to runtime EDGE_PLACEMENT_AMBIGUOUS errors.
    // @pk
    const staticSubjectGroups = new Map<string, string[]>();
    for (const group of this.groups) {
      for (const user of group.users) {
        const list = staticSubjectGroups.get(user.id);
        if (list) {
          list.push(group.id);
        } else {
          staticSubjectGroups.set(user.id, [group.id]);
        }
      }
    }
    const userBindingKeys = new Set<string>();
    for (const binding of this.placementBindings) {
      if (binding.scope === "user" && binding.userId !== undefined) {
        userBindingKeys.add(`${binding.serverName}|${binding.userId}`);
      }
    }
    for (const overlap of detectStaticPlacementOverlaps({
      subjectGroups: staticSubjectGroups,
      bindings: this.placementBindings as readonly PlacementBindingModel[],
      userBindings: userBindingKeys,
    })) {
      diagnostics.push({
        severity: "error",
        code: "FENTARIS_CONFIG_PLACEMENT_AMBIGUOUS",
        title: "Overlapping group placement bindings",
        message: `Subject "${overlap.subjectId}" belongs to groups binding "${overlap.serverName}" to different targets (${overlap.targets.join(", ")}).`,
        path: ["proxy", "placement", overlap.serverName],
        hint: "Add an app.user(subjectId).mcp(name).target(...) binding or align the group target declarations.",
      });
    }

    // Validate edge target device selectors. @pk
    for (const [name, target] of this.targets) {
      if (target.kind === "edge") {
        const selectorErrors = validateDeviceSelector(target.device);
        for (const message of selectorErrors) {
          diagnostics.push({
            severity: "error",
            code: "FENTARIS_CONFIG_TARGET_INVALID_SELECTOR",
            title: "Invalid edge device selector",
            message: `Target "${name}": ${message}`,
            path: ["proxy", "target", name],
          });
        }
      }
    }

    diagnostics.push(...validateEdgeControlPlaneConfig(this.edgeOptions?.controlPlane, {
      mcpPath: this.defaultPath,
      listenerHost: this.defaultHost,
    }));

    return diagnostics;
  }

  /** Compile a launch recipe for a registered server, if it uses stdio. @pk */
  private serverLaunchRecipe(serverName: string): LaunchRecipe | undefined {
    const server = this.serverByName.get(serverName);
    if (!server) {
      return undefined;
    }
    const transport = server.transport;
    if (transport instanceof StdioTransport) {
      const schema = this.setupSchemas.get(serverName);
      return transport.toLaunchRecipe(schema);
    }
    return undefined;
  }

  /** Collect runtime secret references used by a server's stdio transport. @pk */
  private collectSecretRuntimeRefs(server: McpServer): string[] {
    const transport = server.transport;
    if (!(transport instanceof StdioTransport)) {
      return [];
    }
    const refs: string[] = [];
    for (const token of transport.runtimeValueTokens()) {
      if (token.kind === "secret") refs.push(token.ref);
    }
    return [...new Set(refs)];
  }

  private assertDeferredPolicyServerVisibilityValid(): void {
    this.materializeLocalNamespaces();
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
      if (this.edgeControlPlaneRuntime) {
        await this.edgeControlPlaneRuntime.close();
        this.edgeControlPlaneRuntime = undefined;
      }
      await Promise.all(this.serverCatalog.allServers().map((server) => server.close()));
      // Remove every session-target binding and notify dependent workloads. @pk
      await this.shutdownEdgeSessions();
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
    let report = await runHealthChecks({
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
    if (this.edgeControlPlaneRuntime) {
      const checkedAt = new Date();
      const startedAt = Date.now();
      const edge = await this.edgeControlPlaneRuntime.health();
      const edgeStatus = edge.status === "down" ? "down" : edge.status === "degraded" ? "degraded" : "ok";
      report = {
        ...report,
        status: healthStatusMax(report.status, edgeStatus),
        checks: [...report.checks, {
          name: "edge-control-plane",
          status: edgeStatus,
          message: edgeStatus === "ok" ? "Integrated Edge control plane is ready" : edge.warnings[0] ?? "Integrated Edge control plane is unavailable",
          durationMs: Date.now() - startedAt,
          checkedAt,
          metadata: edge,
        }],
      };
    }
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
        if (!this.shouldDiscoverToolsForServer(server.name, userGroups)) {
          return [];
        }
        const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.globalPolicy }, {
          operation: "tools:list",
          serverName: server.name,
          targetKind: "tool",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity,
        });
        const { user: userForServer } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
        const result = await this.dispatchTargetOperation(
          server,
          context,
          () => server.listTools(params, userForServer),
          (transport) => transport.listTools(params),
        );
        const tools = this.groups.length > 0
          ? filterToolsByGroupPolicies(result.tools, server.name, userGroups)
          : this.globalPolicy ? filterToolsByPolicy(result.tools, server.name, this.globalPolicy) : result.tools;
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

  private shouldDiscoverToolsForServer(serverName: string, userGroups: Group[]): boolean {
    // Exact allow rules win over `*` deny when filtering tools, so any allow means
    // the server still has at least one potentially visible tool. @pk
    const hasVisibleTool = (policy: Policy): boolean =>
      policy.getPermissions(serverName).some((permission) => permission.effect === "allow");

    if (this.groups.length > 0) {
      return userGroups.some((group) => hasVisibleTool(group.policy));
    }

    return this.globalPolicy ? hasVisibleTool(this.globalPolicy) : true;
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
      context.policyDecision = this.defaultAllowDecision(request, resolvedUser);
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

          return this.dispatchTargetOperation(
            server,
            context,
            () => this.forwardToolCall(params, upstreamUser, server),
            (transport) => server.runIsolated(upstreamUser, () => transport.callTool({
              ...params,
              name: toolName,
            })),
          );
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
          const upstream = await this.dispatchTargetOperation(
            server,
            context,
            () => server.listResources(params, userForServer),
            (transport) => transport.listResources?.(params) ?? Promise.resolve({ resources: [] }),
          );
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
      const result = await this.dispatchOperationRoutes(
        context,
        async () => this.dispatchTargetOperation(
          server,
          context,
          () => server.readResource({ ...params, uri }, userForServer),
          (transport) => {
            if (!transport.readResource) {
              throw edgeError("EDGE_PROTOCOL", `Edge transport does not support resources for "${server.name}".`);
            }
            return transport.readResource({ ...params, uri });
          },
        ),
      ) as ReadResourceResult;

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
          const upstream = await this.dispatchTargetOperation(
            server,
            context,
            () => server.listResourceTemplates(params, userForServer),
            (transport) => transport.listResourceTemplates?.(params) ?? Promise.resolve({ resourceTemplates: [] }),
          );
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
          const upstream = await this.dispatchTargetOperation(
            server,
            context,
            () => server.listPrompts(params, userForServer),
            (transport) => transport.listPrompts?.(params) ?? Promise.resolve({ prompts: [] }),
          );
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
      return this.dispatchOperationRoutes(
        context,
        async () => this.dispatchTargetOperation(
          server,
          context,
          () => server.getPrompt({ ...params, name: promptName }, userForServer),
          (transport) => {
            if (!transport.getPrompt) {
              throw edgeError("EDGE_PROTOCOL", `Edge transport does not support prompts for "${server.name}".`);
            }
            return transport.getPrompt({ ...params, name: promptName });
          },
        ),
      ) as Promise<GetPromptResult>;
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
      return this.dispatchOperationRoutes(
        context,
        async () => this.dispatchTargetOperation(
          server,
          context,
          () => server.complete(routed.params, userForServer),
          (transport) => {
            if (!transport.complete) {
              throw edgeError("EDGE_PROTOCOL", `Edge transport does not support completions for "${server.name}".`);
            }
            return transport.complete(routed.params);
          },
        ),
      ) as Promise<CompleteResult>;
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
    // Release session-target bindings and notify dependent workloads. @pk
    if (context.sessionId) {
      await this.endEdgeSession(context.sessionId);
    }
  }

  private materializeLocalNamespaces(): void {
    for (const server of this.localRegistry.servers()) {
      const existing = this.serverByName.get(server.name);
      if (existing) {
        if (existing === server) {
          continue;
        }

        throw new FentarisConfigError([
          this.localNamespaceCollisionDiagnostic(server.name),
        ]);
      }

      this.servers.push(server);
      this.serverCatalog.addGlobalServer(server);
      this.serverByName.set(server.name, server);
    }
  }

  private localNamespaceCollisionError(name: string): FentarisConfigError {
    return new FentarisConfigError([this.localNamespaceCollisionDiagnostic(name)]);
  }

  private localNamespaceCollisionDiagnostic(name: string) {
    return {
      severity: "error" as const,
      code: "FENTARIS_CONFIG_LOCAL_NAMESPACE_COLLISION",
      title: "Local namespace collides with an MCP server",
      message: `Local namespace "${name}" collides with a configured upstream MCP server.`,
      path: ["proxy", "local", name],
      hint: "Choose a local namespace that does not match any configured MCP server name.",
    };
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
      decision = this.defaultAllowDecision(request, user);
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

  private defaultAllowDecision(request: ToolCallRequest | CapabilityOperationRequest, user: UserContext): PolicyDecision {
    const capability = toCapabilityRequest(request);
    return {
      allowed: true,
      metadata: {
        policyName: "default-allow",
        matchedPermissions: [],
        serverName: capability.serverName,
        operation: capability.operation,
        target: capability.target,
        targetKind: capability.targetKind,
        toolName: capability.targetKind === "tool" ? capability.target : undefined,
        userId: user.id,
        effect: "allow",
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
      return true;
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
    if (!(await consumePolicyRateLimit(limiter, key))) {
      return context.res.deny("Rate limit exceeded");
    }

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
  private readonly scope: PlacementScope;

  constructor(
    private readonly proxy: McpProxy,
    readonly name: string,
    private readonly groupId?: string,
    private readonly userId?: string,
  ) {
    this.scope = userId !== undefined ? "user" : groupId !== undefined ? "group" : "global";
  }

  use(handler: ProxyMiddleware): ProxyMcpHandle;
  use(handler: LegacyMiddleware): ProxyMcpHandle;
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

  setup(schema: Record<string, SetupFieldDescriptor> | SetupSchema): ProxyMcpHandle {
    this.proxy.registerServerSetup(this.name, schema);
    return this;
  }

  target(targetName: string): ProxyMcpHandle {
    // Defer target resolution to configuration validation so fluent and
    // constructor-style declarations surface unknown targets consistently. @pk
    this.proxy.registerPlacementBinding({
      serverName: this.name,
      scope: this.scope,
      ...(this.groupId !== undefined ? { groupId: this.groupId } : {}),
      ...(this.userId !== undefined ? { userId: this.userId } : {}),
      targetName,
    });
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

  server(name: string): ProxyMcpHandle {
    return this.mcp(name);
  }

  users(...users: User[]): ProxyGroupHandle {
    this.proxy.addGroupUsers(this.id, users);
    return this;
  }

  policy(policyNameOrPolicy: string | Policy): ProxyGroupHandle {
    this.proxy.setGroupPolicy(this.id, policyNameOrPolicy);
    return this;
  }

  use(handler: ProxyMiddleware): ProxyGroupHandle;
  use(handler: LegacyMiddleware): ProxyGroupHandle;
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
 * Scoped user handle returned by `proxy.user(id)`. Records placement bindings
 * without creating or authenticating a subject.
 * @pk
 */
class McpProxyUserHandle implements ProxyUserHandle {
  constructor(
    private readonly proxy: McpProxy,
    readonly id: string,
  ) {}

  mcp(name: string): ProxyMcpHandle {
    return new McpProxyMcpHandle(this.proxy, name, undefined, this.id);
  }

  server(name: string): ProxyMcpHandle {
    return this.mcp(name);
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

function credentialReadinessKey(source: CredentialSource): string {
  return source.type === "env"
    ? `env:${source.name}`
    : `json:${source.file ?? ""}:${source.path}:${source.keyEnv ?? ""}:${source.key === undefined ? "key:env" : "key:explicit"}`;
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

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isDiscoveryOperation(operation: ProxyContext["operation"]): boolean {
  return operation === "tools:list"
    || operation === "resources:list"
    || operation === "resource-templates:list"
    || operation === "prompts:list";
}

function serverNameFromProxyTool(toolName: string): string {
  try {
    return fromProxyToolName(toolName).serverName;
  } catch {
    return "*";
  }
}

type RateLimiterLike = {
  consume?: RateLimiter["consume"];
  checkLimit: RateLimiter["checkLimit"];
  recordCall: RateLimiter["recordCall"];
  getRemainingCalls: RateLimiter["getRemainingCalls"];
};

async function consumePolicyRateLimit(limiter: RateLimiterLike, key: string): Promise<boolean> {
  if (typeof limiter.consume === "function") {
    return limiter.consume(key);
  }

  if (!(await limiter.checkLimit(key))) {
    return false;
  }

  await limiter.recordCall(key);
  return true;
}

function isRateLimiter(value: unknown): value is RateLimiterLike {
  return (
    value !== null &&
    typeof value === "object" &&
    "checkLimit" in value &&
    "recordCall" in value &&
    "getRemainingCalls" in value &&
    (!("consume" in value) || typeof (value as Record<string, unknown>).consume === "function")
  );
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

function healthStatusMax(left: HealthReport["status"], right: HealthReport["status"]): HealthReport["status"] {
  const rank: Record<HealthReport["status"], number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };
  return rank[left] >= rank[right] ? left : right;
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
