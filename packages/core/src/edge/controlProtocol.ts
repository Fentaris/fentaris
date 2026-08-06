import type { LaunchRecipe } from "./recipe.js";
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
export const EDGE_PROTOCOL_VERSION = 2 as const;
/** Oldest protocol retained for transparent Edge compatibility. @pk */
export const EDGE_PROTOCOL_MIN_VERSION = 1 as const;
/** Protocols implemented by this release, newest first. @pk */
export const EDGE_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([2, 1] as const);
/** A negotiated Edge control protocol version. @pk */
export type EdgeProtocolVersion = 1 | 2;

/** Every public deployment readiness status, in stable order. @pk */
export const EDGE_DEPLOYMENT_READINESS_STATUSES: readonly EdgeDeploymentReadinessStatus[] = Object.freeze([
  "ready",
  "setup-required",
  "install-required",
  "blocked",
  "stale",
  "unavailable",
]);

/** Bounded managed-install reason categories reported by an edge. @pk */
export const EDGE_INSTALL_REASON_CATEGORIES: readonly string[] = Object.freeze([
  "install-pending",
  "install-failed",
  "install-denied",
  "install-verification-failed",
]);

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
  readonly observedAt: number;
  readonly expiresAt?: number;
  readonly reasonCategory?: string;
}

/** Authenticated protocol-v2 observed facts and dynamic state. @pk */
export interface EdgePresenceReportMessage extends EdgeProtocolClaims {
  readonly version: 2;
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
}

/** Managed-install lifecycle state reported by an edge. @pk */
export type EdgeInstallReportStatus = "installing" | "installed" | "failed" | "denied";

/**
 * Non-sensitive managed-install progress for one deployment. Carries package
 * identity and a bounded reason category only; local directories, caches, and
 * package-manager output never leave the device.
 * @pk
 */
export interface EdgeInstallStatusReport {
  readonly status: EdgeInstallReportStatus;
  readonly packageId: string;
  readonly installDigest: string;
  readonly resolvedVersion?: string;
  readonly reasonCategory?: string;
}

export interface EdgeSetupStatusMessage extends EdgeProtocolClaims {
  readonly version: EdgeProtocolVersion;
  readonly kind: "edge.setup-status";
  readonly deploymentId: string;
  readonly recipeDigest: string;
  readonly setupSchemaVersion: number;
  readonly status: "pending" | "ready" | "denied" | "revoked";
  readonly grantRefs?: Readonly<Record<string, string>>;
  /** Managed-install progress when the deployment declares an install plan. @pk */
  readonly install?: EdgeInstallStatusReport;
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
  | EdgeMcpResultEnvelope
  | EdgeMcpErrorEnvelope;

/** Messages sent by the control plane after hello. @pk */
export type EdgeControlPlaneMessage =
  | EdgeHelloAckMessage
  | EdgeDesiredStateMessage
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
    if (!EDGE_DEPLOYMENT_READINESS_STATUSES.includes(readiness.status)) {
      throw new TypeError("readiness.status is invalid");
    }
    validateTimestamp(readiness.observedAt, "readiness.observedAt");
  }
}

/** Validate a bounded, non-sensitive managed-install status report. @pk */
export function validateEdgeInstallStatusReport(value: unknown): void {
  if (!value || typeof value !== "object") throw new TypeError("install report must be an object");
  const report = value as Record<string, unknown>;
  if (!["installing", "installed", "failed", "denied"].includes(report.status as string)) {
    throw new TypeError("install.status is invalid");
  }
  validateBoundedString(report.packageId, "install.packageId", 280);
  validateBoundedString(report.installDigest, "install.installDigest", 128);
  if (report.resolvedVersion !== undefined) {
    validateBoundedString(report.resolvedVersion, "install.resolvedVersion", 64);
  }
  if (report.reasonCategory !== undefined && !EDGE_INSTALL_REASON_CATEGORIES.includes(report.reasonCategory as string)) {
    throw new TypeError("install.reasonCategory is invalid");
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
    return;
  }
  validateBoundedString(candidate.tenantId, "tenantId", 160);
  validateBoundedString(candidate.edgeNodeId, "edgeNodeId", 160);
  validateNonNegativeInteger(candidate.connectionGeneration, "connectionGeneration", Number.MAX_SAFE_INTEGER);
  if (candidate.kind === "edge.presence") {
    if (candidate.version !== 2) throw new TypeError("edge.presence requires protocol version 2");
    validateEdgePresenceReport(candidate as unknown as EdgePresenceReportMessage);
  } else if (candidate.kind === "edge.setup-status") {
    if (candidate.install !== undefined) validateEdgeInstallStatusReport(candidate.install);
  } else if (candidate.kind === "edge.heartbeat") {
    validateTimestamp(candidate.sentAt, "sentAt");
    if (candidate.capacity !== undefined && candidate.version !== 2) throw new TypeError("capacity requires protocol version 2");
    if (candidate.load !== undefined && typeof candidate.load === "object" && candidate.version !== 2) {
      throw new TypeError("structured load requires protocol version 2");
    }
  }
}

function isEdgeProtocolVersion(value: unknown): value is EdgeProtocolVersion {
  return value === 1 || value === 2;
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
