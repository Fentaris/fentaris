import type { LaunchRecipe } from "./recipe.js";
import type {
  EdgeMcpCancelEnvelope,
  EdgeMcpErrorEnvelope,
  EdgeMcpRequestEnvelope,
  EdgeMcpResultEnvelope,
} from "./protocol.js";

/** Current edge control-plane protocol version. @pk */
export const EDGE_PROTOCOL_VERSION = 1;

/** Common trusted routing claims carried by edge control messages. @pk */
export interface EdgeProtocolClaims {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
}

export interface EdgeHelloMessage {
  readonly version: typeof EDGE_PROTOCOL_VERSION;
  readonly kind: "edge.hello";
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly supportedVersions: readonly number[];
  readonly nonce: string;
  readonly proof: string;
}

export interface EdgeHelloAckMessage extends EdgeProtocolClaims {
  readonly version: typeof EDGE_PROTOCOL_VERSION;
  readonly kind: "edge.hello.ack";
  readonly protocolVersion: typeof EDGE_PROTOCOL_VERSION;
  readonly serverTime: number;
}

export interface EdgeHeartbeatMessage extends EdgeProtocolClaims {
  readonly version: typeof EDGE_PROTOCOL_VERSION;
  readonly kind: "edge.heartbeat";
  readonly sentAt: number;
  readonly load?: number;
}

export interface EdgeDesiredDeployment {
  readonly deploymentId: string;
  readonly serverName: string;
  readonly recipe: LaunchRecipe;
  readonly setupSchemaVersion?: number;
  readonly subjectIds?: readonly string[];
}

export interface EdgeDesiredStateMessage extends EdgeProtocolClaims {
  readonly version: typeof EDGE_PROTOCOL_VERSION;
  readonly kind: "edge.desired-state";
  readonly desiredVersion: number;
  readonly deployments: readonly EdgeDesiredDeployment[];
}

export interface EdgeDesiredStateAckMessage extends EdgeProtocolClaims {
  readonly version: typeof EDGE_PROTOCOL_VERSION;
  readonly kind: "edge.desired-state.ack";
  readonly desiredVersion: number;
  readonly status: "applied" | "blocked";
  readonly blockedDeploymentIds?: readonly string[];
}

export interface EdgeSetupStatusMessage extends EdgeProtocolClaims {
  readonly version: typeof EDGE_PROTOCOL_VERSION;
  readonly kind: "edge.setup-status";
  readonly deploymentId: string;
  readonly recipeDigest: string;
  readonly setupSchemaVersion: number;
  readonly status: "pending" | "ready" | "denied" | "revoked";
  readonly grantRefs?: Readonly<Record<string, string>>;
}

export interface EdgeCapabilityManifestMessage extends EdgeProtocolClaims {
  readonly version: typeof EDGE_PROTOCOL_VERSION;
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
  readonly version: typeof EDGE_PROTOCOL_VERSION;
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
  if (candidate.version !== EDGE_PROTOCOL_VERSION || typeof candidate.kind !== "string") {
    throw new TypeError("Unsupported or malformed edge protocol frame");
  }
  return value as EdgeProtocolMessage;
}

