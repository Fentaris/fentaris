/**
 * Core public exports for Fentaris.
 * @pk
 */

/**
 * Logger utilities for core runtime logging.
 * @pk
 */
export { Logger, ConsoleLoggerDriver, JsonConsoleLoggerDriver, RedisLoggerDriver, jsonConsoleLogger } from "./logging/index.js";
/**
 * Runtime profiler, event, sink, and runtime error APIs.
 * @pk
 */
export {
  FentarisExtensionError,
  FentarisMcpError,
  FentarisPolicyError,
  FentarisRuntimeError,
  FentarisTimeoutError,
  FentarisTransportError,
  RuntimeProfiler,
  createRuntimeEvent,
  functionProfilerSink,
  jsonProfilerSink,
  loggerProfilerSink,
  normalizeRuntimeError,
  normalizeRuntimeProfiler,
  prettyProfilerSink,
  profiler,
  redactProfilerValue,
  renderRuntimeError,
  runtimeErrorEvent,
  runtimeErrorToEventPayload,
  toRuntimeErrorPayload,
} from "./profiler/index.js";
/**
 * Standard error mapping.
 * @pk
 */
export { DefaultErrorMapper, FentarisErrorCode } from "./errors/index.js";
/**
 * Logger type definitions.
 * @pk
 */
export type {
  JsonConsoleLoggerDriverOptions,
  JsonConsoleLoggerOptions,
  LogEntry,
  LoggerDriver,
  LoggerOptions,
  LoggerRedactionOptions,
  LogLevel,
  RedisLoggerClient,
  RedisLoggerDriverOptions,
} from "./logging/index.js";
export type {
  LoggerSinkOptions,
  NormalizedProfilerRedaction,
  NormalizedRuntimeProfiler,
  ProfilerFailureMode,
  ProfilerFilter,
  ProfilerFunctionSink,
  ProfilerHandlerOptions,
  ProfilerObjectConfig,
  ProfilerPrettySinkOptions,
  ProfilerRedactionOptions,
  ProfilerRedactionRule,
  ProfilerSink,
  ProfilerSinkLike,
  ProfilerTrack,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeEventCategory,
  RuntimeEventDimensions,
  RuntimeEventHandler,
  RuntimeEventLevel,
  RuntimeEventMap,
  RuntimeEventName,
  RuntimeExtensionEvent,
  RuntimeHealthEvent,
  RuntimeLifecycleEvent,
  RuntimeMcpEvent,
  RuntimePolicyEvent,
  RuntimeProfilerConfig,
  RuntimeProfilerErrorPayload,
  RuntimeProfilerEvent,
  RuntimeProfilerHandlerEntry,
  RuntimeTransportEvent,
} from "./profiler/index.js";
/**
 * Runtime lifecycle and health APIs.
 * @pk
 */
export { health } from "./health/index.js";
export type {
  HealthBuilderOptions,
  HealthCheckContext,
  HealthCheckHandler,
  HealthCheckResult,
  HealthConfig,
  HealthGroupContext,
  HealthIncludeCategory,
  HealthReport,
  HealthRuntimeContext,
  HealthServerContext,
  HealthStatus,
  HealthTransportContext,
} from "./health/index.js";
export type {
  RuntimeLifecycle,
  RuntimeLifecycleMetadata,
  RuntimeLifecycleOptions,
  RuntimeLifecycleSnapshot,
  RuntimeLifecycleState,
} from "./lifecycle/index.js";
/**
 * MCP proxy server.
 * @pk
 */
export { McpProxy, createProxy, fentaris } from "./proxy/index.js";
/**
 * TypeScript-first configuration validation and diagnostic APIs.
 * @pk
 */
export {
  FentarisConfigError,
  assertValidFentarisConfig,
  defineFentarisConfig,
  formatFentarisDiagnostics,
  validateFentarisConfig,
} from "./config/index.js";
/**
 * Agent-native tool discovery helpers.
 * @pk
 */
export { AgentToolDiscoveryService, ToolDiscoveryError, failure as agentJsonFailure, success as agentJsonSuccess } from "./tools/index.js";
export type {
  AgentJsonEnvelope,
  AgentJsonFailure,
  AgentJsonNextAction,
  AgentJsonSuccess,
  AgentJsonWarning,
  AgentPagination,
  AuthStatus,
  CompactToolMetadata,
  DetailedToolMetadata,
  DiscoveryMetadata,
  SchemaInspection,
  ToolDiscoveryOptions,
} from "./tools/index.js";
export type {
  FentarisConfigPath,
  FentarisConfigValidationOptions,
  FentarisConfigValidationResult,
  FentarisDiagnostic,
  FentarisDiagnosticFormat,
  FentarisDiagnosticFormatterOptions,
  FentarisDiagnosticRelatedEntry,
  FentarisDiagnosticSeverity,
  FentarisDiagnosticSuggestion,
} from "./config/index.js";
/**
 * MCP proxy options.
 * @pk
 */
export type {
  AutoLogOptions,
  EdgeRuntimeOptions,
  FentarisCliMcpAccountConfig,
  FentarisCliOptions,
  IdentityResolverOptions,
  McpProxyOptions,
  McpProxyStartOptions,
  McpProxyStopOptions,
  PlacementBindingConfig,
} from "./proxy/index.js";
/**
 * MCP server wrapper.
 * @pk
 */
export { McpServer, bearer, header, mcp } from "./server/index.js";
/**
 * MCP server option types.
 * @pk
 */
export type {
  BearerCredentialAuth,
  EnvResolver,
  EnvValue,
  HeaderCredentialAuth,
  McpServerAuth,
  McpServerOptions,
  ServerCredentialBinding,
} from "./server/index.js";
/**
 * Stdio transport for MCP clients.
 * @pk
 */
export { StdioTransport, stdio } from "./transports/index.js";
/**
 * Stdio transport option types.
 * @pk
 */
export type { StdioTransportOptions } from "./transports/index.js";
/**
 * HTTP transport for MCP clients.
 * @pk
 */
export { HttpTransport } from "./transports/index.js";
/**
 * HTTP transport option types.
 * @pk
 */
export type { HttpTransportEnvHeaderMap, HttpTransportOptions, UpstreamHttpNetworkOptions } from "./transports/index.js";
/**
 * Native MCP Streamable HTTP transport for upstream MCP servers.
 * @pk
 */
export { StreamableHttpMcpTransport, streamableHttp } from "./transports/index.js";
export type { StreamableHttpMcpTransportOptions } from "./transports/index.js";
/**
 * Native MCP SSE transport for upstream MCP servers.
 * @pk
 */
export { SseMcpTransport } from "./transports/index.js";
export type { SseMcpTransportOptions } from "./transports/index.js";
/**
 * Downstream proxy exposure transports.
 * @pk
 */
export { HttpProxyExposureTransport } from "./transports/index.js";
export type { HttpProxyExposureHandle, HttpProxyExposureTransportOptions } from "./transports/index.js";
export { StdioProxyExposureTransport } from "./transports/index.js";
export type { StdioProxyExposureTransportOptions } from "./transports/index.js";
export { SseProxyExposureTransport } from "./transports/index.js";
export type { SseProxyExposureHandle, SseProxyExposureTransportOptions } from "./transports/index.js";
/**
 * Shared HTTP-family transport auth helpers.
 * @pk
 */
export { MissingHttpTransportCredentialError, resolveHttpTransportHeaders } from "./transports/auth/index.js";
export type { HttpTransportApiKeyAuth, HttpTransportAuthContext, HttpTransportAuthOptions } from "./transports/auth/index.js";
/**
 * Response controller for middleware.
 * @pk
 */
export { ResponseController } from "./types/index.js";
/**
 * Core middleware and transport types.
 * @pk
 */
export type {
  ErrorMapper,
  ApprovalDecisionController,
  ApprovalHandler,
  ApprovalMetadata,
  ApprovalResult,
  CompleteParams,
  CompleteResponse,
  CredentialSourceMetadata,
  GetPromptParams,
  GetPromptResponse,
  GovernanceContext,
  GroupMembership,
  IdentityMetadata,
  IdentityStrategy,
  Isolation,
  ListPromptsParams,
  ListPromptsResponse,
  ListResourcesParams,
  ListResourcesResponse,
  ListResourceTemplatesParams,
  ListResourceTemplatesResponse,
  LifecycleHook,
  LifecycleHookContext,
  LifecycleHookEvent,
  ListToolsContext,
  ListToolsHook,
  MaybePromise,
  LegacyMiddleware,
  Middleware,
  MiddlewareContext,
  Next,
  FentarisTransport,
  Policy as PolicyContract,
  PolicyDecision,
  PolicyMetadata,
  CapabilityOperationRequest,
  CapabilityPermission,
  CapabilityTargetKind,
  McpOperationName,
  ToolApprovalRequest,
  ProxyAuthContext,
  ProxyContext,
  ProxyEventFilter,
  ProxyEventHandler,
  ProxyEventName,
  ProxyExecutionContext,
  ProxyExposureHandle,
  ProxyExposureTransport,
  ProxyRuntime,
  ProxyGroupHandle,
  ProxyHookEvent,
  ProxyLocalHandle,
  ProxyMcpDeclarationConfig,
  ProxyMcpDeclarationOptions,
  ProxyMcpHandle,
  ProxyUserHandle,
  LocalCompletionHandler,
  LocalCompletionReference,
  LocalPromptHandler,
  LocalPromptMetadata,
  LocalResourceHandler,
  LocalResourceMetadata,
  LocalResourceTemplateMetadata,
  LocalToolHandler,
  LocalToolMetadata,
  ProxyMiddleware,
  ProxyNext,
  ProxyOperation,
  ProxyOperationHandler,
  ProxyOperationResult,
  ProxyPolicyContext,
  ProxyCompletionContext,
  ProxyPromptContext,
  ProxyResourceContext,
  ProxyServerContext,
  ProxyToolHandler,
  ProxyToolPattern,
  ProxyToolContext,
  ProxyTransportContext,
  RateLimitStore,
  RateLimiter,
  ReadResourceParams,
  ReadResourceResponse,
  Registry,
  ResolvedSubject,
  SubjectMetadata,
  ToolCallHook,
  ToolCallHookFilter,
  ToolCallRequest,
  ToolPermission,
  UserContext,
} from "./types/index.js";
/**
 * Tool name mapping helpers.
 * @pk
 */
export { fromProxyToolName, toProxyToolName } from "./naming/index.js";
/**
 * Identity strategy helpers.
 * @pk
 */
export { bearerTokenIdentityStrategy, headerIdentityStrategy } from "./identity/index.js";
/**
 * First-class governance declaration APIs.
 * @pk
 */
export {
  Group,
  Policy,
  PolicyMcpBuilder,
  User,
  allow,
  allowCapability,
  allowAll,
  approval,
  buildSubjectIndex,
  deny,
  denyCapability,
  group,
  limit,
  policy,
  sensitive,
  user,
} from "./governance/index.js";
export type { CapabilityPermissionOptions, GroupOptions, ManualApprovalOptions, SubjectIndex, ToolPermissionOptions, UserOptions } from "./governance/index.js";
/**
 * Credential declaration helpers.
 * @pk
 */
export { credential, credentialEnv, credentialJson } from "./credentials/index.js";
export type {
  CredentialEnvSource,
  CredentialJsonOptions,
  CredentialJsonSource,
  CredentialReference,
  CredentialSource,
  CredentialSourceMap,
} from "./credentials/index.js";
/**
 * Local auth and API-key identity APIs.
 * @pk
 */
export { FentarisAuth, apiKeyIdentityStrategy } from "./auth/index.js";
export type { CredentialResolution, LocalAuthOptions, LocalCredentials, UpstreamAuthBinding, UpstreamAuthBindings } from "./auth/index.js";
/**
 * Secrets backend and manifest APIs.
 * @pk
 */
export {
  LocalSecretsBackend,
  credentialsToRefs,
  decodeSecretScope,
  diffManifest,
  encodeSecretScope,
  manifestEntryKey,
  manifestFromSecretRefs,
  manifestsEqual,
  parseManifest,
  secretRefKey,
  serializeManifest,
} from "./secrets/index.js";
export type {
  LocalSecretsBackendOptions,
  SecretRef,
  SecretScope,
  SecretsBackend,
  SecretsManifest,
  SecretsManifestDiff,
  SecretsManifestEntry,
  SecretsProvider,
} from "./secrets/index.js";
/**
 * Isolation runtime implementations.
 * @pk
 */
export { InProcessIsolation } from "./isolation/index.js";
/**
 * Policy engine and evaluation.
 * @pk
 */
export {
  SimplePolicy,
  filterToolsByPolicy,
  getCapabilityPermission,
  getToolPermission,
  isCapabilityAllowedByPermissions,
  isToolAllowedByPermissions,
  toCapabilityPermissions,
  toCapabilityRequest,
} from "./policy/index.js";
/**
 * Registry implementations.
 * @pk
 */
export { MemoryRegistry, RedisRegistry } from "./registry/index.js";
export type { RedisRegistryClient, RedisRegistryOptions } from "./registry/index.js";
/**
 * Edge execution targets, runtime inputs, setup fields, launch recipes, and errors.
 * @pk
 */
export {
  DeviceSelectorBuilder,
  EDGE_ERROR_CODES,
  LAUNCH_RECIPE_VERSION,
  cloud,
  collectRecipeRuntimeRefs,
  compileLaunchRecipe,
  computeRecipeDigest,
  createSetupSchema,
  describeRuntimeValueToken,
  edge,
  edgeError,
  isCloudTarget,
  isEdgeTarget,
  isEdgeError,
  isRuntimeValueToken,
  parseLaunchRecipe,
  validateLaunchRecipe,
  PlacementResolver,
  detectStaticPlacementOverlaps,
  EdgeSessionPinner,
  EdgeChildBindingManager,
  EdgeSessionSelectionService,
  EDGE_CONTROL_NAMESPACE,
  EDGE_CONTROL_TOOL_NAMES,
  EDGE_CONTROL_TOOL_SCHEMAS,
  registerEdgeControlProvider,
  EdgeTransport,
  EdgeWebSocketGateway,
  EdgeCapabilityCache,
  EdgeTelemetry,
  EDGE_MCP_ENVELOPE_VERSION,
  EDGE_PROTOCOL_VERSION,
  EDGE_PROTOCOL_MIN_VERSION,
  EDGE_SUPPORTED_PROTOCOL_VERSIONS,
  EDGE_INVENTORY_SCHEMA_VERSION,
  IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS,
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeChannelBroker,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSessionSelectionStore,
  InMemoryEdgeChildBindingStore,
  InMemoryEdgeSetupStatusStore,
  InMemoryEdgeCapabilityCacheStore,
  InMemorySessionBindingStore,
  DefaultEdgeControlPlaneService,
  EdgeInventoryService,
  normalizeEdgeDeviceName,
  runtime,
  runtimeValueRef,
  resolveDeviceSelector,
  requireDevice,
  serializeLaunchRecipe,
  validateDeviceSelector,
  validateSetupSchema,
  isEdgeMcpInboundEnvelope,
  parseEdgeProtocolMessage,
  selectHighestMutualEdgeProtocolVersion,
  validateEdgePresenceReport,
  edgeHealth,
  redactEdgeProtocolValue,
} from "./edge/index.js";
export type {
  AuthenticatedEdgeIdentity,
  BooleanSetupField,
  CloudExecutionTarget,
  DeviceSelector,
  DeviceSelectorType,
  EdgeError,
  EdgeErrorCode,
  EdgeExecutionTarget,
  EdgeTargetOptions,
  ExecutionTarget,
  FileSystemFieldOptions,
  FileSetupField,
  FolderSetupField,
  LaunchRecipe,
  NumberFieldOptions,
  NumberSetupField,
  DeviceResolver,
  DeviceResolverContext,
  DeviceResolution,
  PlacementBindingModel,
  PlacementOverlapDiagnostic,
  PlacementRequest,
  PlacementResolution,
  PlacementResolverInputs,
  PlacementScope,
  PlacementSource,
  ConnectionGeneration,
  EdgeSessionPinnerInputs,
  EdgeChildBindingAllocation,
  EdgeChildBindingCleanup,
  EdgeChildBindingManagerOptions,
  EdgeChildBindingTerminalReason,
  EdgeSessionSelectionRequest,
  EdgeSessionSelectionServiceOptions,
  EdgeControlDeviceSummary,
  EdgeControlGetResult,
  EdgeControlInvocationRequest,
  EdgeControlInvoker,
  EdgeControlListResult,
  EdgeControlProviderOptions,
  EdgeControlSelectResult,
  EdgeTransportChannel,
  EdgeTransportOptions,
  EdgeMcpCancelEnvelope,
  EdgeMcpErrorEnvelope,
  EdgeMcpInboundEnvelope,
  EdgeMcpOperation,
  EdgeMcpOutboundEnvelope,
  EdgeMcpRequestEnvelope,
  EdgeMcpResultEnvelope,
  EdgeMcpRoute,
  EdgeAgentMessage,
  EdgeCapabilityManifestMessage,
  EdgeCapabilityCacheStore,
  EdgeCapabilityChangeListener,
  EdgeCapabilityManifest,
  EdgeCapabilityManifestStore,
  EdgeChannelBroker,
  EdgeConnectionRecord,
  EdgeConnectionStore,
  EdgeControlPlaneMessage,
  EdgeDesiredDeployment,
  EdgeDesiredStateAckMessage,
  EdgeDesiredStateMessage,
  EdgeDesiredStateStore,
  EdgeDiscoveryState,
  EdgeHealthOptions,
  EdgeHealthProbeResult,
  EdgeRuntimeEvent,
  EdgeRuntimeEventName,
  EdgeTelemetrySink,
  EdgeDeviceRecord,
  EdgeDeviceRegistry,
  EdgeInventoryListItem,
  EdgeInventoryListOptions,
  EdgeInventoryListPage,
  EdgeInventoryRecord,
  EdgeInventoryUpdate,
  EdgeDispatchDeviceResolution,
  EdgeInventoryAuthorizer,
  EdgeInventoryContext,
  EdgeInventoryQuery,
  EdgeInventoryServiceOptions,
  EdgePublicDeviceView,
  EdgePublicInventoryPage,
  EdgePublicReadinessSummary,
  EdgeSelectionExplanation,
  EdgeSelectionPreference,
  EdgeSelectionRequest,
  EdgeSelectionRequirements,
  EdgeSelectionResult,
  EdgeSelectionStrategy,
  AttributedEdgeValue,
  EdgeAdapterDiagnostics,
  EdgeCapacitySnapshot,
  EdgeChildBinding,
  EdgeChildBindingStore,
  EdgeControlPlaneService,
  EdgeDeploymentReadiness,
  EdgeDeploymentReadinessStatus,
  EdgeDeviceAlias,
  EdgeHeartbeatFreshness,
  EdgeJoinRequest,
  EdgeLoadSnapshot,
  EdgeManagedDeviceView,
  EdgeManagedMetadata,
  EdgeManagementContext,
  EdgeManagementPage,
  EdgeManagementResult,
  EdgeMetadataAuthority,
  EdgeObservedFacts,
  EdgePresence,
  EdgePresenceStatus,
  EdgePresenceStore,
  EdgePublicDeviceRef,
  EdgeReadinessStore,
  EdgeSessionSelection,
  EdgeSessionSelectionStore,
  EdgeUserMetadata,
  EdgeGatewayAuthenticator,
  EdgeGatewayAuthorization,
  EdgeGatewayAuthorizer,
  EdgeGatewaySocket,
  EdgeHeartbeatMessage,
  EdgeHelloAckMessage,
  EdgeHelloMessage,
  EdgeLifecycleMessage,
  EdgeProtocolClaims,
  EdgeProtocolMessage,
  EdgePresenceReportMessage,
  EdgeProtocolVersion,
  EdgeReadinessReport,
  EdgeSetupStatusMessage,
  EdgeSetupStatusStore,
  EdgeWebSocketGatewayOptions,
  SessionBindingExpiryOptions,
  SessionBindingListener,
  SessionBindingRemovalReason,
  SessionBindingStore,
  SessionBindingKey,
  SessionPinRequest,
  SessionPinResult,
  SessionTargetBinding,
  RuntimeValueToken,
  RuntimeValueTokenKind,
  ScalarFieldOptions,
  SecretSetupField,
  SelectFieldOptions,
  SelectOption,
  SelectSetupField,
  SetupDiagnostic,
  SetupField,
  SetupFieldAccess,
  SetupFieldDescriptor,
  SetupFieldKind,
  SetupSchema,
  StringSetupField,
  TargetKind,
  TargetSelectionStrategy,
} from "./edge/index.js";
/**
 * Rate limit store implementations.
 * @pk
 */
export { MemoryRateLimitStore, SlidingWindowRateLimiter, rateLimitKey, rateLimitMiddleware } from "./rate-limit/index.js";
