/**
 * Edge execution public contracts: execution targets, device selectors,
 * runtime-value tokens, setup fields/schema, launch recipes, and error codes.
 * @pk
 */

import { edge } from "./target.js";
import * as setup from "./setup.js";

// Attach setup field builders to the `edge` namespace so applications can call
// `edge.folder()`, `edge.secret()`, etc. directly, matching the design where
// `edge` is both a target builder and the setup/selector namespace. @pk
(edge as unknown as {
  folder: typeof setup.folder;
  file: typeof setup.file;
  secret: typeof setup.secret;
  string: typeof setup.string;
  boolean: typeof setup.boolean;
  number: typeof setup.number;
  select: typeof setup.select;
}).folder = setup.folder;
(edge as unknown as { file: typeof setup.file }).file = setup.file;
(edge as unknown as { secret: typeof setup.secret }).secret = setup.secret;
(edge as unknown as { string: typeof setup.string }).string = setup.string;
(edge as unknown as { boolean: typeof setup.boolean }).boolean = setup.boolean;
(edge as unknown as { number: typeof setup.number }).number = setup.number;
(edge as unknown as { select: typeof setup.select }).select = setup.select;

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
} from "./recipe.js";
export type { LaunchRecipe } from "./recipe.js";

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
  EDGE_PROTOCOL_VERSION,
  parseEdgeProtocolMessage,
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
  InMemoryEdgeSetupStatusStore,
} from "./controlPlane.js";
export type {
  EdgeCapabilityManifestStore,
  EdgeChannelBroker,
  EdgeConnectionRecord,
  EdgeConnectionStore,
  EdgeDesiredStateStore,
  EdgeDeviceRecord,
  EdgeDeviceRegistry,
  EdgeSetupStatusStore,
} from "./controlPlane.js";

export { EdgeWebSocketGateway } from "./gateway.js";
export type {
  AuthenticatedEdgeIdentity,
  EdgeGatewayAuthenticator,
  EdgeGatewayAuthorization,
  EdgeGatewayAuthorizer,
  EdgeGatewaySocket,
  EdgeWebSocketGatewayOptions,
} from "./gateway.js";
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
