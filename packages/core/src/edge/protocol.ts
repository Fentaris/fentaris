import type { EdgeErrorCode } from "./errors.js";

/** Current normalized edge MCP envelope version. @pk */
export const EDGE_MCP_ENVELOPE_VERSION = 1;

/** MCP operations supported across the edge execution boundary. @pk */
export type EdgeMcpOperation =
  | "tools/list"
  | "tools/call"
  | "resources/list"
  | "resources/read"
  | "resources/templates/list"
  | "prompts/list"
  | "prompts/get"
  | "completion/complete"
  | "ping";

/** Trusted routing fields attached by the Fentaris control plane. @pk */
export interface EdgeMcpRoute {
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
  readonly deploymentId: string;
  readonly downstreamSessionId: string;
  readonly subjectId?: string;
  readonly targetName: string;
}

/** A normalized edge MCP request. @pk */
export interface EdgeMcpRequestEnvelope {
  readonly version: typeof EDGE_MCP_ENVELOPE_VERSION;
  readonly kind: "mcp.request";
  readonly requestId: string;
  readonly operation: EdgeMcpOperation;
  readonly route: EdgeMcpRoute;
  readonly deadline: number;
  readonly params?: unknown;
  readonly trace?: Readonly<Record<string, string>>;
}

/** A normalized successful edge MCP result. @pk */
export interface EdgeMcpResultEnvelope {
  readonly version: typeof EDGE_MCP_ENVELOPE_VERSION;
  readonly kind: "mcp.result";
  readonly requestId: string;
  readonly operation: EdgeMcpOperation;
  readonly route: EdgeMcpRoute;
  readonly result: unknown;
}

/** A normalized failed edge MCP result. @pk */
export interface EdgeMcpErrorEnvelope {
  readonly version: typeof EDGE_MCP_ENVELOPE_VERSION;
  readonly kind: "mcp.error";
  readonly requestId: string;
  readonly operation: EdgeMcpOperation;
  readonly route: EdgeMcpRoute;
  readonly error: {
    readonly code: EdgeErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/** A normalized edge MCP cancellation request. @pk */
export interface EdgeMcpCancelEnvelope {
  readonly version: typeof EDGE_MCP_ENVELOPE_VERSION;
  readonly kind: "mcp.cancel";
  readonly requestId: string;
  readonly route: EdgeMcpRoute;
  readonly reason: "aborted" | "deadline" | "shutdown";
}

/** Messages sent from the control plane to an edge connection. @pk */
export type EdgeMcpOutboundEnvelope = EdgeMcpRequestEnvelope | EdgeMcpCancelEnvelope;

/** Terminal messages returned by an edge connection. @pk */
export type EdgeMcpInboundEnvelope = EdgeMcpResultEnvelope | EdgeMcpErrorEnvelope;

/** Return true when an unknown value is a structurally valid terminal envelope. @pk */
export function isEdgeMcpInboundEnvelope(value: unknown): value is EdgeMcpInboundEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== EDGE_MCP_ENVELOPE_VERSION) return false;
  if (candidate.kind !== "mcp.result" && candidate.kind !== "mcp.error") return false;
  if (typeof candidate.requestId !== "string" || typeof candidate.operation !== "string") return false;
  if (!candidate.route || typeof candidate.route !== "object") return false;
  if (candidate.kind === "mcp.result") return "result" in candidate;
  const error = candidate.error as Record<string, unknown> | undefined;
  return Boolean(error && typeof error.code === "string" && typeof error.message === "string");
}

