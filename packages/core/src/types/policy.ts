import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CapabilityOperationRequest,
  McpOperationName,
  ToolApprovalRequest,
  ToolCallRequest,
  CapabilityTargetKind,
} from "./mcp-operation.js";
import type { MiddlewareContext } from "./middleware.js";
import type {
  ApprovalHandler,
  IdentityMetadata,
  MaybePromise,
  PolicyMetadata,
  UserContext,
} from "./shared.js";

/**
 * Tool permission model for policy enforcement.
 * @pk
 */
export type ToolPermission = {
  tool: string;
  effect?: "allow" | "deny";
  limiter?: RateLimiter;
  approval?: ApprovalHandler<ToolApprovalRequest>;
  metadata?: Record<string, unknown>;
};

/**
 * Operation-based permission model for governed MCP capabilities.
 * @pk
 */
export type CapabilityPermission = {
  server?: string;
  operation: McpOperationName | "*";
  target?: string;
  targetKind?: CapabilityTargetKind;
  effect?: "allow" | "deny";
  limiter?: RateLimiter;
  approval?: ApprovalHandler<CapabilityOperationRequest>;
  metadata?: Record<string, unknown>;
};

/**
 * Policy evaluation result.
 * @pk
 */
export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  metadata?: PolicyMetadata & Record<string, unknown>;
};

/**
 * Policy for RBAC-style permission enforcement.
 * @pk
 */
export interface Policy {
  name: string;
  description?: string;
  getPermissions(serverName: string): ToolPermission[];
  getCapabilityPermissions?(serverName: string): CapabilityPermission[];
  evaluate(
    request: ToolCallRequest | CapabilityOperationRequest,
    user: UserContext,
    context?: MiddlewareContext,
  ): MaybePromise<PolicyDecision>;
  metadata?: {
    maxDailyCalls?: number;
    requiresApproval?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Registry for resolving user data and secrets.
 * @pk
 */
export interface Registry {
  getUser(userId: string): MaybePromise<UserContext | null>;
  getSecrets(userId: string): MaybePromise<Record<string, string> | null>;
  getTokens(userId: string): MaybePromise<Record<string, string> | null>;
}

/**
 * Rate limit store for distributed tracking.
 * @pk
 */
export interface RateLimitStore {
  increment(key: string, window: number): MaybePromise<number>;
  get(key: string): MaybePromise<number>;
  reset(key: string): MaybePromise<void>;
}

/**
 * Rate limiter with sliding window and quota support.
 * @pk
 */
export interface RateLimiter {
  checkLimit(key: string): MaybePromise<boolean>;
  recordCall(key: string): MaybePromise<void>;
  getRemainingCalls(key: string): MaybePromise<number>;
  metadata?: {
    maxPerWindow?: number;
    windowMs?: number;
    maxDailyCalls?: number;
  };
}

/**
 * Identity resolution strategy.
 * @pk
 */
export type IdentityStrategy = {
  name: string;
  resolve(request: { headers?: Record<string, string>; [key: string]: unknown }): MaybePromise<UserContext | null>;
};

/**
 * Isolation runtime for per-user execution.
 * @pk
 */
export interface Isolation {
  queue(
    userId: string,
    fn: () => MaybePromise<CallToolResult>,
    timeout?: number,
  ): MaybePromise<CallToolResult>;
  close(): MaybePromise<void>;
}

/**
 * Error mapper for standardized MCP error responses.
 * @pk
 */
export type ErrorMapper = {
  mapError(error: unknown, context: { serverName?: string; toolName?: string }): {
    code: number;
    message: string;
  };
};

/**
 * Extended middleware context with governance.
 * @pk
 */
export type GovernanceContext = MiddlewareContext & {
  policy?: Policy;
  policyDecision?: PolicyDecision;
  identity?: IdentityMetadata;
  registry?: Registry;
  rateLimiter?: RateLimiter;
};
