import type { CapabilityTargetKind, McpOperationName } from "./mcp-operation.js";
import type { MiddlewareContext } from "./middleware.js";

/**
 * Maybe a promise for async compatibility.
 * @pk
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * User context passed through requests.
 * @pk
 */
export type UserContext = {
  id?: string;
  secrets?: Record<string, string>;
  tokens?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * Non-sensitive subject metadata declared in application code.
 * @pk
 */
export type SubjectMetadata = {
  displayName?: string;
  email?: string;
  tenantId?: string;
  tenant?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

/**
 * Configured group membership metadata for a resolved subject.
 * @pk
 */
export type GroupMembership = {
  id: string;
  name?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Credential source metadata safe to expose in middleware and logs.
 * @pk
 */
export type CredentialSourceMetadata = {
  reference: string;
  source: "user" | "group" | "default";
  userId?: string;
  groupId?: string;
};

/**
 * Safe approval metadata exposed through policy decisions and logs.
 * @pk
 */
export type ApprovalMetadata = {
  status: "approved" | "denied" | "pending";
  reason?: string;
  url?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Effective policy metadata safe to expose in middleware and logs.
 * @pk
 */
export type PolicyMetadata = {
  policyName?: string;
  matchedGroups?: string[];
  matchedPermissions?: Array<{
    policyName: string;
    groupId?: string;
    serverName: string;
    operation: McpOperationName;
    target?: string;
    targetKind?: CapabilityTargetKind;
    toolName?: string;
    effect: "allow" | "deny";
    metadata?: Record<string, unknown>;
  }>;
  denialReason?: string;
  approval?: ApprovalMetadata;
};

/**
 * Authenticated subject resolved from user and group declarations.
 * @pk
 */
export type ResolvedSubject = {
  id: string;
  displayName?: string;
  email?: string;
  metadata?: Record<string, unknown>;
  tenant?: Record<string, unknown>;
  groups: GroupMembership[];
  hasGroup(groupId: string): boolean;
};

/**
 * Structured subject metadata exposed through the unified context.
 * @pk
 */
export type ProxySubjectContext = ResolvedSubject;

/**
 * Identity metadata resolved at the proxy edge.
 * @pk
 */
export type IdentityMetadata = {
  strategy?: string;
  authenticated?: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Structured result for permission approval callbacks.
 * @pk
 */
export type ApprovalResult =
  | boolean
  | {
      approved: boolean;
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "approved" | "denied" | "pending";
      reason?: string;
      url?: string;
      requestId?: string;
      metadata?: Record<string, unknown>;
    };

/**
 * Ergonomic helpers for approval callbacks.
 * @pk
 */
export type ApprovalDecisionController = {
  approve(metadata?: Record<string, unknown>): ApprovalResult;
  deny(reason?: string, metadata?: Record<string, unknown>): ApprovalResult;
  pending(reason?: string, metadata?: Record<string, unknown>): ApprovalResult;
};

/**
 * Shared approval decision helpers exposed on middleware context.
 * @pk
 */
export const approvalDecision: ApprovalDecisionController = {
  approve(metadata?: Record<string, unknown>): ApprovalResult {
    return { status: "approved", metadata };
  },
  deny(reason = "Approval required but not granted", metadata?: Record<string, unknown>): ApprovalResult {
    return { status: "denied", reason, metadata };
  },
  pending(reason = "Approval is pending", metadata?: Record<string, unknown>): ApprovalResult {
    return { status: "pending", reason, metadata };
  },
};

/**
 * Permission approval callback.
 * @pk
 */
export type ApprovalHandler<TRequest> = (request: TRequest, context: MiddlewareContext) => MaybePromise<ApprovalResult>;
