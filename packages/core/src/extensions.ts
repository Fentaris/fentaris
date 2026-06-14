/**
 * Public extension contracts for third-party Fentaris integrations.
 *
 * Import these types when implementing custom transports, policies,
 * registries, rate limiters, logger drivers, middleware, or event handlers.
 * The top-level `@fentaris/core` entrypoint remains supported; this subpath
 * gives extension authors contract names without colliding with declaration
 * helper values such as `Policy`.
 * @pk
 */
export type { LoggerDriver, LoggerOptions, LogEntry, LogLevel } from "./logging/index.js";
export type {
  ApprovalHandler,
  ApprovalMetadata,
  ApprovalResult,
  CapabilityOperationRequest,
  CapabilityPermission,
  ErrorMapper,
  FentarisTransport,
  GovernanceContext,
  IdentityStrategy,
  LegacyMiddleware,
  LifecycleHook,
  LifecycleHookContext,
  LifecycleHookEvent,
  ListToolsContext,
  ListToolsHook,
  MaybePromise,
  Middleware,
  MiddlewareContext,
  Next,
  Policy,
  PolicyDecision,
  ProxyContext,
  ProxyEventFilter,
  ProxyEventHandler,
  ProxyEventName,
  ProxyEventPayload,
  ProxyExposureHandle,
  ProxyExposureTransport,
  ProxyMiddleware,
  ProxyNext,
  ProxyOperation,
  ProxyOperationHandler,
  ProxyOperationResult,
  ProxyRuntime,
  ProxyMcpDeclarationConfig,
  ProxyMcpDeclarationOptions,
  ProxyMcpHandle,
  ProxyToolHandler,
  RateLimitStore,
  RateLimiter,
  Registry,
  ToolCallHook,
  ToolCallHookFilter,
  ToolCallRequest,
  ToolPermission,
  UserContext,
} from "./types/index.js";
