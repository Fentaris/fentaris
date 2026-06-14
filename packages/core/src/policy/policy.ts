import type { CapabilityOperationRequest, ToolApprovalRequest, ToolCallRequest } from "../types/mcp-operation.js";
import type { MiddlewareContext } from "../types/middleware.js";
import type { CapabilityPermission, Policy as PolicyContract, PolicyDecision, ToolPermission } from "../types/policy.js";
import type { ApprovalMetadata, ApprovalResult, UserContext } from "../types/shared.js";

/**
 * Default policy implementation with RBAC-style permissions.
 * @pk
 */
export class SimplePolicy implements PolicyContract {
  readonly name: string;
  readonly description?: string;
  private readonly permissionsByServer: Map<string, ToolPermission[]>;
  private readonly capabilityPermissionsByServer: Map<string, CapabilityPermission[]>;
  readonly metadata?: PolicyContract["metadata"];

  /**
   * Create a new policy.
   * @pk
   */
  constructor(options: {
    name: string;
    description?: string;
    permissions: Record<string, ToolPermission[]>;
    capabilityPermissions?: Record<string, CapabilityPermission[]>;
     metadata?: PolicyContract["metadata"];
  }) {
    this.name = options.name;
    this.description = options.description;
    this.metadata = options.metadata;
    this.permissionsByServer = new Map(Object.entries(options.permissions));
    this.capabilityPermissionsByServer = new Map(Object.entries(options.capabilityPermissions ?? {}));
  }

  /**
   * Get permissions for a server.
   * @pk
   */
  getPermissions(serverName: string): ToolPermission[] {
    return this.permissionsByServer.get(serverName) ?? [];
  }

  /**
   * Get operation-based permissions for a server, including adapted tool permissions.
   * @pk
   */
  getCapabilityPermissions(serverName: string): CapabilityPermission[] {
    return [
      ...toCapabilityPermissions(serverName, this.getPermissions(serverName)),
      ...(this.capabilityPermissionsByServer.get(serverName) ?? []),
    ];
  }

  /**
   * Evaluate if a tool call is allowed.
   * @pk
   */
  async evaluate(
    request: ToolCallRequest | CapabilityOperationRequest,
    user: UserContext,
    context?: MiddlewareContext,
  ): Promise<PolicyDecision> {
    const capabilityRequest = toCapabilityRequest(request);
    const permission = findMatchingCapabilityPermission(
      this.getCapabilityPermissions(capabilityRequest.serverName),
      capabilityRequest,
    );

    if (!permission) {
      return this.decision(false, capabilityRequest, user, undefined, {
        reason: notPermittedReason(capabilityRequest),
      });
    }

    if (permission.effect === "deny") {
      return this.decision(false, capabilityRequest, user, permission, {
        reason: deniedReason(capabilityRequest, this.name),
      });
    }

    if (permission.approval) {
      if (!context) {
        return this.decision(false, capabilityRequest, user, permission, {
          reason: "Approval requires middleware context",
        });
      }

      const approval = normalizeApprovalResult(await permission.approval(capabilityRequest, context));
      if (approval.status !== "approved") {
        return this.decision(false, capabilityRequest, user, permission, {
          reason: approval.reason ?? (approval.status === "pending" ? "Approval is pending" : "Approval required but not granted"),
          approval,
        });
      }
    }

    return this.decision(true, capabilityRequest, user, permission);
  }

  private decision(
    allowed: boolean,
    request: CapabilityOperationRequest,
    user: UserContext,
    permission?: CapabilityPermission,
    options: { reason?: string; approval?: ApprovalMetadata } = {},
  ): PolicyDecision {
    return {
      allowed,
      reason: options.reason,
      metadata: {
        policyName: this.name,
        serverName: request.serverName,
        operation: request.operation,
        target: request.target,
        targetKind: request.targetKind,
        toolName: request.targetKind === "tool" ? request.target : undefined,
        userId: user.id,
        permission: permission?.metadata,
        limiter: permission?.limiter,
        effect: permission?.effect ?? (allowed ? "allow" : "deny"),
        approval: options.approval,
      },
    };
  }
}

/**
 * Filter tools by policy.
 * @pk
 */
export function filterToolsByPolicy<TTool extends { name: string }>(
  tools: TTool[],
  serverName: string,
  policy: PolicyContract,
): TTool[] {
  const permissions = policy.getPermissions(serverName);
  return tools.filter((tool) => isToolAllowedByPermissions(permissions, unproxyToolName(tool.name, serverName)));
}

/**
 * Return the effective permission for a tool, preferring exact matches over wildcard permissions.
 * @pk
 */
export function getToolPermission(permissions: ToolPermission[], toolName: string): ToolPermission | undefined {
  return (
    permissions.find((permission) => permission.tool === toolName) ??
    permissions.find((permission) => permission.tool === "*")
  );
}

/**
 * Check whether a tool is allowed by a permission set.
 * @pk
 */
export function isToolAllowedByPermissions(permissions: ToolPermission[], toolName: string): boolean {
  const permission = getToolPermission(permissions, toolName);
  return permission?.effect !== "deny" && Boolean(permission);
}

/**
 * Return operation-based permissions adapted from tool permissions.
 * @pk
 */
export function toCapabilityPermissions(serverName: string, permissions: ToolPermission[]): CapabilityPermission[] {
  return permissions.map((permission) => ({
    server: serverName,
    operation: "tool:call",
    target: permission.tool,
    targetKind: "tool",
    effect: permission.effect,
    limiter: permission.limiter,
    approval: permission.approval
      ? async (request, context) =>
          permission.approval?.(
            toolApprovalRequest(request),
            context,
          ) ?? false
      : undefined,
    metadata: permission.metadata,
  }));
}

/**
 * Normalize a legacy tool-call request into a capability request.
 * @pk
 */
export function toCapabilityRequest(request: ToolCallRequest | CapabilityOperationRequest): CapabilityOperationRequest {
  if ("operation" in request) {
    return request;
  }

  const approvalRequest: ToolApprovalRequest = {
    serverName: request.serverName,
    operation: "tool:call",
    target: request.toolName,
    targetKind: "tool",
    raw: request.raw,
    toolName: request.toolName,
    proxyToolName: request.proxyToolName,
    arguments: request.arguments,
  };
  return approvalRequest;
}

function toolApprovalRequest(request: CapabilityOperationRequest): ToolApprovalRequest {
  if (isToolApprovalRequest(request)) {
    return request;
  }

  const toolName = request.target ?? "*";
  const proxyToolName = `${request.serverName}__${toolName}`;
  return {
    serverName: request.serverName,
    operation: "tool:call",
    target: toolName,
    targetKind: "tool",
    toolName,
    proxyToolName,
    arguments: {},
    raw: { name: proxyToolName },
  };
}

function isToolApprovalRequest(request: CapabilityOperationRequest): request is ToolApprovalRequest {
  return (
    request.operation === "tool:call" &&
    request.targetKind === "tool" &&
    "toolName" in request &&
    "proxyToolName" in request &&
    "arguments" in request &&
    "raw" in request
  );
}

/**
 * Return the effective capability permission, preferring exact matches over wildcards.
 * @pk
 */
export function getCapabilityPermission(
  permissions: CapabilityPermission[],
  request: CapabilityOperationRequest,
): CapabilityPermission | undefined {
  return findMatchingCapabilityPermission(permissions, request);
}

/**
 * Check whether a capability is allowed by a permission set.
 * @pk
 */
export function isCapabilityAllowedByPermissions(
  permissions: CapabilityPermission[],
  request: CapabilityOperationRequest,
): boolean {
  const permission = getCapabilityPermission(permissions, request);
  return permission?.effect !== "deny" && Boolean(permission);
}

/**
 * Normalize approval callback output into safe policy metadata.
 * @pk
 */
export function normalizeApprovalResult(result: ApprovalResult): ApprovalMetadata {
  if (typeof result === "boolean") {
    return { status: result ? "approved" : "denied" };
  }

  if ("approved" in result) {
    return {
      status: result.approved ? "approved" : "denied",
      reason: result.reason,
      metadata: result.metadata,
    };
  }

  return {
    status: result.status,
    reason: result.reason,
    url: result.url,
    requestId: result.requestId,
    metadata: result.metadata,
  };
}

function findMatchingCapabilityPermission(
  permissions: CapabilityPermission[],
  request: CapabilityOperationRequest,
): CapabilityPermission | undefined {
  return (
    permissions.find((permission) => matchesCapabilityPermission(permission, request, true)) ??
    permissions.find((permission) => matchesCapabilityPermission(permission, request, false))
  );
}

function matchesCapabilityPermission(
  permission: CapabilityPermission,
  request: CapabilityOperationRequest,
  exactTarget: boolean,
): boolean {
  const serverMatches = !permission.server || permission.server === request.serverName || permission.server === "*";
  const operationMatches = permission.operation === request.operation || permission.operation === "*";
  const targetKindMatches = !permission.targetKind || permission.targetKind === request.targetKind;
  const targetMatches = exactTarget
    ? permission.target !== "*" && permission.target === request.target
    : permission.target === "*" || permission.target === undefined;

  return serverMatches && operationMatches && targetKindMatches && targetMatches;
}

function notPermittedReason(request: CapabilityOperationRequest): string {
  if (request.operation === "tool:call") {
    return `Tool "${request.target ?? "*"}" not permitted on server "${request.serverName}"`;
  }

  return `Operation "${request.operation}" not permitted for "${request.target ?? "*"}" on server "${request.serverName}"`;
}

function deniedReason(request: CapabilityOperationRequest, policyName: string): string {
  if (request.operation === "tool:call") {
    return `Tool "${request.target ?? "*"}" denied by policy "${policyName}"`;
  }

  return `Operation "${request.operation}" denied by policy "${policyName}"`;
}

function unproxyToolName(toolName: string, serverName: string): string {
  const prefix = `${serverName}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}
