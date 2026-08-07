import type { LaunchRecipe } from "./recipe.js";
import type {
  InstallationDigest,
  InstallationLifecycleState,
  InstallationReasonCode,
  InstallationRecipe,
} from "./installation.js";
import { isInstalledArtifactReference } from "./installation.js";
import type { SetupSchema } from "./setup.js";
import type {
  EdgeMcpCancelEnvelope,
  EdgeMcpErrorEnvelope,
  EdgeMcpRequestEnvelope,
  EdgeMcpResultEnvelope,
} from "./protocol.js";
import type {
  EdgeCapacitySnapshot,
  EdgeDeploymentReadinessStatus,
  EdgeLoadSnapshot,
  EdgeObservedFacts,
} from "./inventory.js";

/** Current edge control-plane protocol version. @pk */
export const EDGE_PROTOCOL_VERSION = 3 as const;
/** Oldest protocol retained for transparent Edge compatibility. @pk */
export const EDGE_PROTOCOL_MIN_VERSION = 1 as const;
/** Protocols implemented by this release, newest first. @pk */
export const EDGE_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([3, 2, 1] as const);
/** A negotiated Edge control protocol version. @pk */
export type EdgeProtocolVersion = 1 | 2 | 3;

/** Common trusted routing claims carried by edge control messages. @pk */
export interface EdgeProtocolClaims {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
}

export interface EdgeHelloMessage {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.hello";
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly supportedVersions: readonly number[];
  readonly nonce: string;
  readonly proof: string;
  /** Enrolled opaque device credential carried inside the protected WebSocket channel. @pk */
  readonly deviceCredential?: string;
}

export interface EdgeHelloAckMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.hello.ack";
  readonly protocolVersion: EdgeProtocolVersion;
  readonly serverTime: number;
}

export interface EdgeHeartbeatMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.heartbeat";
  readonly sentAt: number;
  /** Legacy v1 scalar load. */
  readonly load?: number | EdgeLoadSnapshot;
  readonly capacity?: EdgeCapacitySnapshot;
}

/** Public readiness report carried only by protocol v2. @pk */
export interface EdgeReadinessReport {
  readonly deploymentId: string;
  readonly status: EdgeDeploymentReadinessStatus;
  readonly recipeVersion?: number;
  readonly desiredVersion?: number;
  readonly installationDigest?: InstallationDigest;
  readonly launchDigest?: string;
  readonly installationState?: InstallationLifecycleState;
  readonly reasonCode?: InstallationReasonCode;
  readonly retryable?: boolean;
  readonly attemptId?: string;
  readonly observedAt: number;
  readonly expiresAt?: number;
  readonly reasonCategory?: string;
}

/** Authenticated protocol-v2 observed facts and dynamic state. @pk */
export interface EdgePresenceReportMessage extends EdgeProtocolClaims {
  readonly version: 2 | 3;
  readonly kind: "edge.presence";
  readonly observed: EdgeObservedFacts;
  readonly capacity?: EdgeCapacitySnapshot;
  readonly load?: EdgeLoadSnapshot;
  readonly readiness: readonly EdgeReadinessReport[];
  readonly reportedAt: number;
}

export interface EdgeDesiredDeployment {
  readonly deploymentId: string;
  readonly serverName: string;
  readonly recipe: LaunchRecipe;
  /** Correlation identity for the launch recipe. Required for protocol v3 managed installations. */
  readonly launchDigest?: string;
  /** Optional managed installation recipe, carried only by protocol v3. */
  readonly installationRecipe?: InstallationRecipe;
  readonly installationDigest?: InstallationDigest;
  /** Compatibility marker sent instead of a recipe to older agents. */
  readonly requiresAgentUpgrade?: boolean;
  /** Complete unresolved setup schema collected locally by the edge agent. */
  readonly setupSchema: SetupSchema;
  readonly setupSchemaVersion?: number;
  readonly subjectIds?: readonly string[];
}

export interface EdgeDesiredStateMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.desired-state";
  readonly desiredVersion: number;
  readonly deployments: readonly EdgeDesiredDeployment[];
}

export interface EdgeDesiredStateAckMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.desired-state.ack";
  readonly desiredVersion: number;
  readonly status: "applied" | "blocked";
  readonly blockedDeploymentIds?: readonly string[];
  readonly deploymentDigests?: Readonly<Record<string, { readonly launchDigest: string; readonly installationDigest?: InstallationDigest }>>;
}

/** Bounded installation lifecycle report carried by protocol v3. @pk */
export interface EdgeInstallationStatusMessage extends EdgeProtocolClaims {
  readonly version: 3;
  readonly kind: "edge.installation-status";
  readonly deploymentId: string;
  readonly desiredVersion: number;
  readonly installationDigest: InstallationDigest;
  readonly launchDigest: string;
  readonly state: InstallationLifecycleState;
  readonly reasonCode?: InstallationReasonCode;
  readonly retryable: boolean;
  readonly attemptId?: string;
  readonly attemptStartedAt?: number;
  readonly observedAt: number;
  readonly approvalRequired?: {
    readonly approvalDigest: InstallationDigest;
    readonly sourceKind: string;
    readonly cleanup: boolean;
  };
  readonly nextAction?: string;
}

/** Explicit authorized retry/removal command; never arbitrary script execution. @pk */
export interface EdgeInstallationControlMessage extends EdgeProtocolClaims {
  readonly version: 3;
  readonly kind: "edge.installation-control";
  readonly deploymentId: string;
  readonly desiredVersion: number;
  readonly installationDigest: InstallationDigest;
  readonly action: "retry" | "remove";
  readonly requestId: string;
}

/** Local approval decision reported without review material or credentials. @pk */
export interface EdgeInstallationApprovalMessage extends EdgeProtocolClaims {
  readonly version: 3;
  readonly kind: "edge.installation-approval";
  readonly deploymentId: string;
  readonly desiredVersion: number;
  readonly installationDigest: InstallationDigest;
  readonly approvalDigest: InstallationDigest;
  readonly decision: "approved" | "denied" | "revoked";
  readonly cleanup: boolean;
  readonly decidedAt: number;
}

export interface EdgeSetupStatusMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.setup-status";
  readonly deploymentId: string;
  readonly recipeDigest: string;
  readonly setupSchemaVersion: number;
  readonly status: "pending" | "ready" | "denied" | "revoked";
  readonly grantRefs?: Readonly<Record<string, string>>;
}

export interface EdgeCapabilityManifestMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.capability-manifest";
  readonly deploymentId: string;
  readonly recipeDigest: string;
  readonly tools: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly resourceTemplates: readonly unknown[];
  readonly prompts: readonly unknown[];
  readonly supportsCompletion: boolean;
}

export interface EdgeLifecycleMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.lifecycle";
  readonly event:
    | "connected"
    | "disconnected"
    | "setup-pending"
    | "setup-ready"
    | "workload-started"
    | "workload-stopped"
    | "workload-failed";
  readonly deploymentId?: string;
  readonly downstreamSessionId?: string;
  readonly occurredAt: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Messages accepted from an edge after hello. @pk */
export type EdgeAgentMessage =
  | EdgeHeartbeatMessage
  | EdgePresenceReportMessage
  | EdgeDesiredStateAckMessage
  | EdgeSetupStatusMessage
  | EdgeCapabilityManifestMessage
  | EdgeLifecycleMessage
  | EdgeInstallationStatusMessage
  | EdgeInstallationApprovalMessage
  | EdgeMcpResultEnvelope
  | EdgeMcpErrorEnvelope;

/** Messages sent by the control plane after hello. @pk */
export type EdgeControlPlaneMessage =
  | EdgeHelloAckMessage
  | EdgeDesiredStateMessage
  | EdgeInstallationControlMessage
  | EdgeMcpRequestEnvelope
  | EdgeMcpCancelEnvelope;

/** All versioned edge protocol messages. @pk */
export type EdgeProtocolMessage = EdgeHelloMessage | EdgeAgentMessage | EdgeControlPlaneMessage;

/** Parse a JSON edge frame and reject unsupported/malformed protocol shells. @pk */
export function parseEdgeProtocolMessage(frame: string): EdgeProtocolMessage {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new TypeError("Malformed edge protocol JSON frame");
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Edge protocol frame must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string") {
    throw new TypeError("Unsupported or malformed edge protocol frame");
  }
  if (candidate.kind.startsWith("mcp.")) {
    if (candidate.version !== 1) throw new TypeError("Unsupported MCP edge envelope version");
    return value as EdgeProtocolMessage;
  }
  if (!isEdgeProtocolVersion(candidate.version)) {
    throw new TypeError("Unsupported or malformed edge protocol frame");
  }
  validateProtocolShell(candidate);
  return value as EdgeProtocolMessage;
}

/** Select the highest version supported by both peers. @pk */
export function selectHighestMutualEdgeProtocolVersion(
  peerVersions: readonly number[],
  supportedVersions: readonly EdgeProtocolVersion[] = EDGE_SUPPORTED_PROTOCOL_VERSIONS,
): EdgeProtocolVersion | undefined {
  const peer = new Set(peerVersions);
  return [...supportedVersions].sort((left, right) => right - left).find((version) => peer.has(version));
}

/** Adapt desired state without exposing recipes unsupported by older agents. @pk */
export function adaptDesiredStateForEdgeProtocol(
  state: EdgeDesiredStateMessage,
  version: EdgeProtocolVersion,
): EdgeDesiredStateMessage {
  const deployments = state.deployments.map((deployment) => {
    if (version >= 3 || !deployment.installationRecipe) return deployment;
    const launchOnly = { ...deployment };
    delete (launchOnly as { installationRecipe?: InstallationRecipe }).installationRecipe;
    delete (launchOnly as { installationDigest?: InstallationDigest }).installationDigest;
    return { ...launchOnly, launchDigest: deployment.recipe.digest, requiresAgentUpgrade: true };
  });
  return Object.freeze({ ...state, version, deployments: Object.freeze(deployments) });
}

/** Validate bounded protocol-v2 observed facts and dynamic report fields. @pk */
export function validateEdgePresenceReport(message: EdgePresenceReportMessage): void {
  validateBoundedString(message.observed.platform, "platform", 64);
  validateBoundedString(message.observed.architecture, "architecture", 64);
  validateBoundedString(message.observed.agentVersion, "agentVersion", 64);
  validateStringList(message.observed.executionFeatures, "executionFeatures", 64, 80);
  validateTimestamp(message.observed.reportedAt, "observed.reportedAt");
  validateTimestamp(message.reportedAt, "reportedAt");
  if (message.capacity) {
    validateNonNegativeInteger(message.capacity.maxConcurrent, "capacity.maxConcurrent", 10_000);
    validateNonNegativeInteger(message.capacity.available, "capacity.available", message.capacity.maxConcurrent);
    validateTimestamp(message.capacity.reportedAt, "capacity.reportedAt");
  }
  if (message.load) validateLoad(message.load);
  if (!Array.isArray(message.readiness) || message.readiness.length > 256) {
    throw new TypeError("readiness must contain at most 256 entries");
  }
  for (const readiness of message.readiness) {
    validateBoundedString(readiness.deploymentId, "readiness.deploymentId", 160);
    if (!["ready", "setup-required", "blocked", "stale", "unavailable"].includes(readiness.status)) {
      throw new TypeError("readiness.status is invalid");
    }
    validateTimestamp(readiness.observedAt, "readiness.observedAt");
    if (readiness.installationDigest !== undefined) validateDigest(readiness.installationDigest, "readiness.installationDigest");
    if (readiness.launchDigest !== undefined) validateDigest(readiness.launchDigest, "readiness.launchDigest");
    if (readiness.desiredVersion !== undefined) validateNonNegativeInteger(readiness.desiredVersion, "readiness.desiredVersion", Number.MAX_SAFE_INTEGER);
  }
}

function validateProtocolShell(candidate: Record<string, unknown>): void {
  if (candidate.kind === "edge.hello") {
    if (!Array.isArray(candidate.supportedVersions)
      || candidate.supportedVersions.length === 0
      || candidate.supportedVersions.length > 8
      || candidate.supportedVersions.some((version) => !isEdgeProtocolVersion(version))) {
      throw new TypeError("Edge hello supportedVersions is malformed");
    }
    validateBoundedString(candidate.tenantId, "tenantId", 160);
    validateBoundedString(candidate.edgeNodeId, "edgeNodeId", 160);
    validateBoundedString(candidate.nonce, "nonce", 512);
    validateBoundedString(candidate.proof, "proof", 4096);
    if (candidate.deviceCredential !== undefined) {
      validateBoundedString(candidate.deviceCredential, "deviceCredential", 4096);
    }
    return;
  }
  validateBoundedString(candidate.tenantId, "tenantId", 160);
  validateBoundedString(candidate.edgeNodeId, "edgeNodeId", 160);
  validateNonNegativeInteger(candidate.connectionGeneration, "connectionGeneration", Number.MAX_SAFE_INTEGER);
  if (candidate.kind === "edge.presence") {
    if (candidate.version !== 2 && candidate.version !== 3) throw new TypeError("edge.presence requires protocol version 2 or 3");
    validateEdgePresenceReport(candidate as unknown as EdgePresenceReportMessage);
  } else if (candidate.kind === "edge.desired-state") {
    validateDesiredState(candidate as unknown as EdgeDesiredStateMessage);
  } else if (candidate.kind === "edge.installation-status") {
    if (candidate.version !== 3) throw new TypeError("installation status requires protocol version 3");
    validateInstallationStatus(candidate);
  } else if (candidate.kind === "edge.installation-control") {
    if (candidate.version !== 3) throw new TypeError("installation control requires protocol version 3");
    validateInstallationControl(candidate);
  } else if (candidate.kind === "edge.installation-approval") {
    if (candidate.version !== 3) throw new TypeError("installation approval requires protocol version 3");
    validateInstallationApproval(candidate);
  } else if (candidate.kind === "edge.heartbeat") {
    validateTimestamp(candidate.sentAt, "sentAt");
    if (candidate.capacity !== undefined && candidate.version !== 2 && candidate.version !== 3) throw new TypeError("capacity requires protocol version 2 or 3");
    if (candidate.load !== undefined && typeof candidate.load === "object" && candidate.version !== 2 && candidate.version !== 3) {
      throw new TypeError("structured load requires protocol version 2 or 3");
    }
  }
}

function isEdgeProtocolVersion(value: unknown): value is EdgeProtocolVersion {
  return value === 1 || value === 2 || value === 3;
}

function validateDesiredState(message: EdgeDesiredStateMessage): void {
  validateNonNegativeInteger(message.desiredVersion, "desiredVersion", Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(message.deployments) || message.deployments.length > 256) throw new TypeError("deployments must contain at most 256 entries");
  for (const deployment of message.deployments) {
    validateBoundedString(deployment.deploymentId, "deploymentId", 160);
    if (deployment.installationRecipe) {
      if (message.version !== 3) throw new TypeError("installation recipes require protocol version 3");
      if (deployment.installationDigest !== deployment.installationRecipe.digest) throw new TypeError("installation digest correlation mismatch");
      if (deployment.launchDigest !== deployment.recipe.digest) throw new TypeError("launch digest correlation mismatch");
      if (isInstalledArtifactReference(deployment.recipe.command)) {
        if (deployment.installationRecipe.provider.kind === "manual") throw new TypeError("manual prerequisites cannot provide managed launch artifacts");
        if (deployment.recipe.command.installationDigest !== deployment.installationRecipe.digest
          || !deployment.installationRecipe.outputs.some((output: InstallationRecipe["outputs"][number]) => output.name === deployment.recipe.command.output && output.kind === deployment.recipe.command.kind)) {
          throw new TypeError("installed launch artifact is not declared by the installation recipe");
        }
      }
    } else if (isInstalledArtifactReference(deployment.recipe.command)) {
      throw new TypeError("installed launch artifact requires an installation recipe");
    }
  }
}

function validateInstallationStatus(candidate: Record<string, unknown>): void {
  validateBoundedString(candidate.deploymentId, "deploymentId", 160);
  validateNonNegativeInteger(candidate.desiredVersion, "desiredVersion", Number.MAX_SAFE_INTEGER);
  validateDigest(candidate.installationDigest, "installationDigest");
  validateDigest(candidate.launchDigest, "launchDigest");
  if (!["assigned", "checking", "approval-required", "installing", "installed", "configuring", "starting", "ready", "degraded", "failed", "blocked", "removing", "removed"].includes(String(candidate.state))) throw new TypeError("installation state is invalid");
  if (typeof candidate.retryable !== "boolean") throw new TypeError("installation retryable must be boolean");
  validateTimestamp(candidate.observedAt, "observedAt");
}

function validateInstallationControl(candidate: Record<string, unknown>): void {
  validateBoundedString(candidate.deploymentId, "deploymentId", 160);
  validateNonNegativeInteger(candidate.desiredVersion, "desiredVersion", Number.MAX_SAFE_INTEGER);
  validateDigest(candidate.installationDigest, "installationDigest");
  validateBoundedString(candidate.requestId, "requestId", 160);
  if (candidate.action !== "retry" && candidate.action !== "remove") throw new TypeError("installation control action is invalid");
}

function validateInstallationApproval(candidate: Record<string, unknown>): void {
  validateBoundedString(candidate.deploymentId, "deploymentId", 160);
  validateNonNegativeInteger(candidate.desiredVersion, "desiredVersion", Number.MAX_SAFE_INTEGER);
  validateDigest(candidate.installationDigest, "installationDigest");
  validateDigest(candidate.approvalDigest, "approvalDigest");
  if (!["approved", "denied", "revoked"].includes(String(candidate.decision)) || typeof candidate.cleanup !== "boolean") throw new TypeError("installation approval is invalid");
  validateTimestamp(candidate.decidedAt, "decidedAt");
}

function validateDigest(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value)) throw new TypeError(`${field} must be a sha256 digest`);
}

function validateBoundedString(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function validateStringList(value: unknown, field: string, maxItems: number, maxLength: number): void {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${field} contains too many entries`);
  for (const item of value) validateBoundedString(item, field, maxLength);
}

function validateTimestamp(value: unknown, field: string): void {
  validateNonNegativeInteger(value, field, Number.MAX_SAFE_INTEGER);
}

function validateNonNegativeInteger(value: unknown, field: string, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function validateLoad(load: EdgeLoadSnapshot): void {
  validateNonNegativeInteger(load.active, "load.active", 10_000);
  validateNonNegativeInteger(load.queued, "load.queued", 1_000_000);
  validateTimestamp(load.reportedAt, "load.reportedAt");
  if (load.utilization !== undefined && (!Number.isFinite(load.utilization) || load.utilization < 0 || load.utilization > 1)) {
    throw new TypeError("load.utilization must be between 0 and 1");
  }
}
