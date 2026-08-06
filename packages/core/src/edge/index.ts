/**
 * Edge execution public contracts: execution targets, device selectors,
 * runtime-value tokens, setup fields/schema, launch recipes, and error codes.
 * @pk
 */

export {
  cloud,
  edge,
  DeviceSelectorBuilder,
  isCloudTarget,
  isEdgeTarget,
  isValidTargetName,
  validateDeviceSelector,
} from "./target.js";
export type {
  DeviceSelector,
  DeviceSelectorType,
  EdgeExecutionTarget,
  EdgeTargetOptions,
  ExecutionTarget,
  CloudExecutionTarget,
  TargetKind,
  TargetSelectionStrategy,
} from "./target.js";

export {
  runtime,
  isRuntimeValueToken,
  describeRuntimeValueToken,
  runtimeValueRef,
  RUNTIME_VALUE_TOKEN_BRAND,
} from "./runtimeInput.js";
export type { RuntimeValueToken, RuntimeValueTokenKind } from "./runtimeInput.js";

export {
  createSetupSchema,
  validateSetupSchema,
  folder,
  file,
  secret,
  string,
  boolean,
  number,
  select,
} from "./setup.js";
export type {
  BooleanSetupField,
  FileSetupField,
  FolderSetupField,
  NumberFieldOptions,
  NumberSetupField,
  ScalarFieldOptions,
  SelectFieldOptions,
  SelectOption,
  SelectSetupField,
  SecretSetupField,
  SetupDiagnostic,
  SetupField,
  SetupFieldAccess,
  SetupFieldDescriptor,
  SetupFieldKind,
  SetupSchema,
  StringSetupField,
  FileSystemFieldOptions,
} from "./setup.js";

export {
  compileLaunchRecipe,
  computeRecipeDigest,
  collectRecipeRuntimeRefs,
  LAUNCH_RECIPE_VERSION,
  parseLaunchRecipe,
  serializeLaunchRecipe,
  validateLaunchRecipe,
} from "./recipe.js";
export type { LaunchRecipe } from "./recipe.js";

export {
  INSTALLATION_RECIPE_VERSION,
  IN_MEMORY_INSTALLATION_ADAPTER_WARNING,
  InMemoryInstallationApprovalStore,
  InMemoryInstallationArtifactStore,
  InMemoryInstallationAttemptStore,
  InMemoryInstallationLifecycleStore,
  InMemoryInstallationMutationLock,
  canonicalizeInstallationValue,
  compileInstallationRecipe,
  computeInstallationDigest,
  install,
  installationApprovalDigest,
  installedArtifact,
  isInstalledArtifactReference,
  normalizeInstallationReadiness,
  parseInstallationRecipe,
  serializeInstallationRecipe,
  validateInstallationRecipe,
} from "./installation.js";
export type {
  ArchiveInstallationSource,
  BinaryInstallationProvider,
  ContainerInstallationProvider,
  CustomInstallationProvider,
  EnterpriseInstallationSource,
  GitInstallationSource,
  InlineInstallationSource,
  InstallationApprovalRecord,
  InstallationApprovalStore,
  InstallationArtifactRecord,
  InstallationArtifactStore,
  InstallationAttemptStore,
  InstallationAttemptSummary,
  InstallationBuilderDefaults,
  InstallationCleanup,
  InstallationDigest,
  InstallationFilesystemPermission,
  InstallationLifecycleState,
  InstallationLifecycleStore,
  InstallationLifecycleSummary,
  InstallationLimits,
  InstallationMutationLock,
  InstallationNetworkMode,
  InstallationOutput,
  InstallationOutputKind,
  InstallationPermissions,
  InstallationPlatformConstraint,
  InstallationProvider,
  InstallationProviderAdapter,
  InstallationProviderContext,
  InstallationProviderKind,
  InstallationReasonCode,
  InstallationRecipe,
  InstallationRecipeInput,
  InstallationResolvedSource,
  InstallationRetention,
  InstallationSource,
  InstallationSourceResolver,
  InstallationVerification,
  InstalledArtifactReference,
  LocalInstallationSource,
  ManualInstallationProvider,
  NodePackageInstallationProvider,
  PythonInstallationProvider,
} from "./installation.js";

export { EdgeInstallationTelemetry, edgeInstallationHealth } from "./installationObservability.js";
export type {
  EdgeInstallationHealthOptions,
  EdgeInstallationRuntimeEvent,
  EdgeInstallationRuntimeEventName,
  EdgeInstallationTelemetrySink,
} from "./installationObservability.js";

export { EDGE_ERROR_CODES, edgeError, isEdgeError } from "./errors.js";
export type { EdgeError, EdgeErrorCode, EdgeErrorOptions } from "./errors.js";

export {
  PlacementResolver,
  detectStaticPlacementOverlaps,
  requireDevice,
  resolveDeviceSelector,
} from "./placement.js";
export type {
  DeviceResolution,
  DeviceResolver,
  DeviceResolverContext,
  PlacementBindingModel,
  PlacementOverlapDiagnostic,
  PlacementRequest,
  PlacementResolution,
  PlacementResolverInputs,
  PlacementScope,
  PlacementSource,
  StaticOverlapInputs,
} from "./placement.js";

export {
  InMemorySessionBindingStore,
} from "./sessionBinding.js";
export type {
  ConnectionGeneration,
  SessionBindingExpiryOptions,
  SessionBindingInput,
  SessionBindingKey,
  SessionBindingListener,
  SessionBindingRemovalReason,
  SessionBindingStore,
  SessionTargetBinding,
} from "./sessionBinding.js";

export {
  EdgeSessionPinner,
} from "./sessionPinning.js";

export {
  EdgeChildBindingManager,
  EdgeSessionSelectionService,
} from "./sessionSelection.js";

export {
  EDGE_CONTROL_NAMESPACE,
  EDGE_CONTROL_TOOL_NAMES,
  EDGE_CONTROL_TOOL_SCHEMAS,
  registerEdgeControlProvider,
} from "./controlProvider.js";

export { EdgeSingleCallCoordinator } from "./controlInvocation.js";
export type {
  EdgeSingleCallCoordinatorOptions,
  EdgeSingleCallStructuredResult,
  EdgeTrustedChildRoute,
} from "./controlInvocation.js";

export {
  DEFAULT_EDGE_ORCHESTRATION_LIMITS,
  EdgeFanoutCoordinator,
} from "./fanout.js";

export {
  EDGE_DISTRIBUTED_CONSISTENCY_REQUIREMENTS,
  InMemoryEdgePoolSelectionStore,
  InMemoryEdgeResultCorrelationStore,
  diagnoseEdgeProductionAdapters,
} from "./distributed.js";
export type {
  EdgeCoordinatedPoolStrategy,
  EdgePoolCandidate,
  EdgePoolSelectionStore,
  EdgeProductionAdapterDiagnostic,
  EdgeResultCorrelation,
  EdgeResultCorrelationStore,
} from "./distributed.js";
export type {
  EdgeFanoutCoordinatorOptions,
  EdgeAggregateApprovalContext,
  EdgeFanoutEntry,
  EdgeFanoutResult,
  EdgeFanoutStatus,
  EdgeOrchestrationLimits,
} from "./fanout.js";
export type {
  EdgeControlDeviceSummary,
  EdgeControlGetResult,
  EdgeControlInvocationRequest,
  EdgeControlInvoker,
  EdgeControlListResult,
  EdgeControlProviderOptions,
  EdgeControlSelectResult,
} from "./controlProvider.js";
export type {
  EdgeChildBindingAllocation,
  EdgeChildBindingCleanup,
  EdgeChildBindingManagerOptions,
  EdgeChildBindingTerminalReason,
  EdgeSessionSelectionRequest,
  EdgeSessionSelectionServiceOptions,
} from "./sessionSelection.js";
export type {
  EdgeSessionPinnerInputs,
  SessionPinRequest,
  SessionPinResult,
} from "./sessionPinning.js";

export { EdgeTransport } from "./EdgeTransport.js";
export type { EdgeTransportChannel, EdgeTransportOptions } from "./EdgeTransport.js";

export {
  EDGE_MCP_ENVELOPE_VERSION,
  isEdgeMcpInboundEnvelope,
} from "./protocol.js";

export {
  EDGE_PROTOCOL_MIN_VERSION,
  EDGE_PROTOCOL_VERSION,
  EDGE_SUPPORTED_PROTOCOL_VERSIONS,
  adaptDesiredStateForEdgeProtocol,
  parseEdgeProtocolMessage,
  selectHighestMutualEdgeProtocolVersion,
  validateEdgePresenceReport,
} from "./controlProtocol.js";
export type {
  EdgeAgentMessage,
  EdgeCapabilityManifestMessage,
  EdgeControlPlaneMessage,
  EdgeDesiredDeployment,
  EdgeDesiredStateAckMessage,
  EdgeDesiredStateMessage,
  EdgeHeartbeatMessage,
  EdgeHelloAckMessage,
  EdgeHelloMessage,
  EdgeLifecycleMessage,
  EdgeInstallationApprovalMessage,
  EdgeInstallationControlMessage,
  EdgeInstallationStatusMessage,
  EdgePresenceReportMessage,
  EdgeProtocolVersion,
  EdgeReadinessReport,
  EdgeProtocolClaims,
  EdgeProtocolMessage,
  EdgeSetupStatusMessage,
} from "./controlProtocol.js";

export {
  InMemoryEdgeCapabilityManifestStore,
  InMemoryEdgeChannelBroker,
  InMemoryEdgeConnectionStore,
  InMemoryEdgeDesiredStateStore,
  InMemoryEdgeDeviceRegistry,
  InMemoryEdgeInstallationStatusStore,
  InMemoryEdgeSetupStatusStore,
} from "./controlPlane.js";
export type {
  EdgeCapabilityManifestStore,
  EdgeChannelBroker,
  EdgeConnectionRecord,
  EdgeConnectionStore,
  EdgeConnectionTerminator,
  EdgeDesiredStateStore,
  EdgeDeviceRecord,
  EdgeDeviceRegistry,
  EdgeInventoryListItem,
  EdgeInventoryListOptions,
  EdgeInventoryListPage,
  EdgeInventoryRecord,
  EdgeInventoryUpdate,
  EdgeInstallationStatusStore,
  EdgeSetupStatusStore,
} from "./controlPlane.js";

export { normalizeEdgeDeviceName } from "./controlPlane.js";

export {
  EDGE_INVENTORY_SCHEMA_VERSION,
  IN_MEMORY_EDGE_ADAPTER_DIAGNOSTICS,
  InMemoryEdgeChildBindingStore,
  InMemoryEdgePresenceStore,
  InMemoryEdgeReadinessStore,
  InMemoryEdgeSessionSelectionStore,
} from "./inventory.js";
export type {
  AttributedEdgeValue,
  EdgeAdapterDiagnostics,
  EdgeCapacitySnapshot,
  EdgeChildBinding,
  EdgeChildBindingStore,
  EdgeDeploymentReadiness,
  EdgeDeploymentReadinessStatus,
  EdgeDeviceAlias,
  EdgeHeartbeatFreshness,
  EdgeLoadSnapshot,
  EdgeManagedMetadata,
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
} from "./inventory.js";

export { DefaultEdgeControlPlaneService } from "./management.js";
export type {
  EdgeControlPlaneService,
  EdgeJoinRequest,
  EdgeManagedDeviceView,
  EdgeManagementContext,
  EdgeManagementPage,
  EdgeManagementResult,
} from "./management.js";

export { EdgeInventoryService } from "./inventoryService.js";
export type {
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
  EdgeSelectionSetResult,
  EdgeSelectionStrategy,
} from "./inventoryService.js";

export { EdgeWebSocketGateway } from "./gateway.js";
export type {
  AuthenticatedEdgeIdentity,
  EdgeGatewayAuthenticator,
  EdgeGatewayAuthorization,
  EdgeGatewayAuthorizer,
  EdgeGatewaySocket,
  EdgeWebSocketGatewayOptions,
} from "./gateway.js";

export {
  EDGE_CONTROL_PLANE_DEFAULT_BASE_PATH,
  EDGE_CONTROL_PLANE_DEFAULT_STATE_DIR,
  EDGE_CONTROL_PLANE_DEFAULTS,
  SERIALIZABLE_EDGE_CONTROL_PLANE_KEYS,
  buildEdgeControlPlaneUrls,
  mergeEdgeControlPlaneConfig,
  normalizeEdgeControlPlaneConfig,
  parseSerializableEdgeControlPlaneConfig,
  validateEdgeControlPlaneConfig,
} from "./integratedConfig.js";
export type {
  EdgeAssignmentResolver,
  EdgeControlPlaneConfig,
  EdgeControlPlaneManagedAdapters,
  EdgeControlPlaneMode,
  EdgeDeviceApprovalAdapter,
  EdgeDeviceApprovalDecision,
  NormalizedEdgeControlPlaneConfig,
  SerializableEdgeControlPlaneConfig,
} from "./integratedConfig.js";

export {
  EDGE_CONTROL_PLANE_ERROR_CODES,
  edgeControlPlaneError,
  isEdgeControlPlaneErrorBody,
} from "./integratedProtocol.js";
export type {
  EdgeAuthenticatedHelloProof,
  EdgeAuthenticatedHelloResult,
  EdgeControlPlaneErrorBody,
  EdgeControlPlaneErrorCode,
  EdgeControlPlaneTokenResponse,
  EdgeDeviceAuthorizeRequest,
  EdgeDeviceAuthorizeResponse,
  EdgeDeviceTokenRequest,
  EdgeEnrollRequest,
  EdgeEnrollResponse,
  EdgeRevokeRequest,
  EdgeTokenRefreshRequest,
} from "./integratedProtocol.js";

export type {
  EdgeApprovalService,
  EdgeAuthorizationSession,
  EdgeDesiredAssignmentSnapshot,
  EdgeDesiredAssignmentStore,
  EdgeDeviceAuthorizationService,
  EdgeEnrolledDeviceAuthority,
  EdgeEnrolledDeviceStore,
  EdgeEnrollmentService,
  EdgeLocalOperatorChannel,
  EdgeReconciliationTrigger,
  EdgeReconciliationTriggerService,
  EdgeTokenIssuanceService,
} from "./integratedServices.js";

export {
  EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
  LOCAL_EDGE_AUTHORITY_ADAPTER_DIAGNOSTICS,
  EdgeLocalAuthorityStore,
  compareSecretHash,
  hashSecret,
  normalizeUserCode,
  redactEdgeAuthorityValue,
} from "./integratedLocalStore.js";
export type {
  EdgeEncryptedBlob,
  EdgeLocalAuthorityDocument,
  EdgeLocalAuthorityStoreOptions,
  EdgeLocalRefreshCredential,
  EdgeLocalServerIdentity,
} from "./integratedLocalStore.js";

export {
  EdgeLocalOperatorClient,
  EdgeLocalOperatorServer,
  createEdgeLocalOperatorEndpoint,
} from "./integratedOperatorChannel.js";
export type {
  EdgeLocalOperatorCommand,
  EdgeLocalOperatorEndpoint,
  EdgeLocalOperatorRequest,
  EdgeLocalOperatorResponse,
  EdgeLocalOperatorServerOptions,
} from "./integratedOperatorChannel.js";

export {
  EdgeCapabilityCache,
  InMemoryEdgeCapabilityCacheStore,
} from "./capabilityCache.js";

export {
  EdgeTelemetry,
  edgeHealth,
  redactEdgeProtocolValue,
  serializeEdgePublicValue,
} from "./observability.js";
export type {
  EdgeHealthOptions,
  EdgeHealthProbeResult,
  EdgeSerializationLimits,
  EdgeRuntimeEvent,
  EdgeRuntimeEventName,
  EdgeTelemetrySink,
} from "./observability.js";
export type {
  EdgeCapabilityCacheStore,
  EdgeCapabilityChangeListener,
  EdgeCapabilityManifest,
  EdgeDiscoveryState,
} from "./capabilityCache.js";
export type {
  EdgeMcpCancelEnvelope,
  EdgeMcpErrorEnvelope,
  EdgeMcpInboundEnvelope,
  EdgeMcpOperation,
  EdgeMcpOutboundEnvelope,
  EdgeMcpRequestEnvelope,
  EdgeMcpResultEnvelope,
  EdgeMcpRoute,
} from "./protocol.js";
