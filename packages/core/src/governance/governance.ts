import { getCapabilityPermission, normalizeApprovalResult, toCapabilityPermissions, toCapabilityRequest } from "../policy/index.js";
import type { CredentialSource, CredentialSourceMap } from "../credentials/index.js";
import type { McpServer } from "../server/McpServer.js";
import type { CapabilityOperationRequest, ToolApprovalRequest, ToolCallRequest } from "../types/mcp-operation.js";
import type { MiddlewareContext } from "../types/middleware.js";
import type { CapabilityPermission, Policy as PolicyContract, PolicyDecision, ToolPermission } from "../types/policy.js";
import type { ApprovalHandler, ApprovalMetadata, ApprovalResult, ResolvedSubject, SubjectMetadata, UserContext } from "../types/shared.js";

/**
 * First-class non-sensitive subject declaration.
 * @pk
 */
export class User {
  readonly id: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly tenantId?: string;
  readonly tenant?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly apiKeys: CredentialSource[];
  readonly credentials: CredentialSourceMap;

  constructor(id: string, metadata: UserOptions = {}) {
    if (!id.trim()) {
      throw new Error("User id cannot be empty");
    }

    this.id = id;
    this.displayName = metadata.displayName;
    this.email = metadata.email;
    this.tenantId = metadata.tenantId;
    this.tenant = metadata.tenant;
    this.metadata = metadata.metadata;
    this.apiKeys = [...(metadata.apiKeys ?? [])];
    this.credentials = { ...(metadata.credentials ?? {}) };
  }
}

/**
 * First-class group declaration that owns users and policy.
 * @pk
 */
export class Group {
  readonly id: string;
  readonly name?: string;
  readonly users: User[];
  readonly policy: PolicyContract;
  readonly credentials: CredentialSourceMap;
  readonly servers: McpServer[];
  readonly metadata?: Record<string, unknown>;

  constructor(options: GroupOptions) {
    if (!options.id.trim()) {
      throw new Error("Group id cannot be empty");
    }
    if (options.users.length === 0) {
      throw new Error(`Group "${options.id}" must include at least one user`);
    }

    this.id = options.id;
    this.name = options.name;
    this.users = [...options.users];
    this.policy = options.policy;
    this.credentials = { ...(options.credentials ?? {}) };
    this.servers = [...(options.servers ?? [])];
    this.metadata = options.metadata;
  }
}

/**
 * Group declaration options.
 * @pk
 */
export type GroupOptions = {
  id: string;
  name?: string;
  users: User[];
  policy: PolicyContract;
  credentials?: CredentialSourceMap;
  servers?: McpServer[];
  metadata?: Record<string, unknown>;
};

/**
 * User declaration options.
 * @pk
 */
export type UserOptions = SubjectMetadata & {
  apiKeys?: CredentialSource[];
  credentials?: CredentialSourceMap;
};

/**
 * Fluent policy declaration.
 * @pk
 */
export class Policy implements PolicyContract {
  readonly name: string;
  readonly description?: string;
  readonly metadata?: PolicyContract["metadata"];
  private readonly permissionsByServer = new Map<string, ToolPermission[]>();
  private readonly capabilityPermissionsByServer = new Map<string, CapabilityPermission[]>();

  constructor(options: { name: string; description?: string; metadata?: PolicyContract["metadata"] }) {
    if (!options.name.trim()) {
      throw new Error("Policy name cannot be empty");
    }

    this.name = options.name;
    this.description = options.description;
    this.metadata = options.metadata;
  }

  /**
   * Create an allow-all policy.
   * @pk
   */
  static allowAll(name = "allow-all"): Policy {
    return new Policy({ name }).mcp("*").allow("*");
  }

  /**
   * Select an upstream MCP server for fluent permission declarations.
   * @pk
   */
  mcp(serverName: string): PolicyMcpBuilder {
    return new PolicyMcpBuilder(this, serverName);
  }

  /**
   * Add an allow permission.
   * @pk
   */
  allow(serverName: string, toolName: string, options: ToolPermissionOptions = {}): this {
    return this.addPermission(serverName, { ...toToolPermission(toolName, options), effect: "allow" });
  }

  /**
   * Add a deny permission.
   * @pk
   */
  deny(serverName: string, toolName: string, options: ToolPermissionOptions = {}): this {
    return this.addPermission(serverName, { ...toToolPermission(toolName, options), effect: "deny" });
  }

  /**
   * Add an allow permission for any governed MCP operation.
   * @pk
   */
  allowCapability(serverName: string, permission: CapabilityPermissionOptions): this {
    return this.addCapabilityPermission(serverName, toCapabilityPermission(serverName, permission, "allow"));
  }

  /**
   * Add a deny permission for any governed MCP operation.
   * @pk
   */
  denyCapability(serverName: string, permission: CapabilityPermissionOptions): this {
    return this.addCapabilityPermission(serverName, toCapabilityPermission(serverName, permission, "deny"));
  }

  getPermissions(serverName: string): ToolPermission[] {
    return [
      ...(this.permissionsByServer.get(serverName) ?? []),
      ...(serverName === "*" ? [] : this.permissionsByServer.get("*") ?? []),
    ];
  }

  getCapabilityPermissions(serverName: string): CapabilityPermission[] {
    return [
      ...toCapabilityPermissions(serverName, this.getPermissions(serverName)),
      ...(this.capabilityPermissionsByServer.get(serverName) ?? []),
      ...(serverName === "*" ? [] : this.capabilityPermissionsByServer.get("*") ?? []),
    ];
  }

  /**
   * Return the server names explicitly declared by this policy.
   * @pk
   */
  getDeclaredServerNames(): string[] {
    return [...new Set([...this.permissionsByServer.keys(), ...this.capabilityPermissionsByServer.keys()])];
  }

  /**
   * Return policy declarations for static configuration validation.
   * @pk
   */
  getDeclaredPermissions(): Array<{ serverName: string; permissions: ToolPermission[]; capabilityPermissions: CapabilityPermission[] }> {
    return this.getDeclaredServerNames().map((serverName) => ({
      serverName,
      permissions: this.permissionsByServer.get(serverName) ?? [],
      capabilityPermissions: this.capabilityPermissionsByServer.get(serverName) ?? [],
    }));
  }

  async evaluate(
    request: ToolCallRequest | CapabilityOperationRequest,
    user: UserContext,
    context?: MiddlewareContext,
  ): Promise<PolicyDecision> {
    const capabilityRequest = toCapabilityRequest(request);
    const permission = getCapabilityPermission(this.getCapabilityPermissions(capabilityRequest.serverName), capabilityRequest);
    if (!permission) {
      return this.decision(false, capabilityRequest, user, undefined, "not-permitted");
    }

    if (permission.effect === "deny") {
      return this.decision(false, capabilityRequest, user, permission, deniedReason(capabilityRequest, this.name));
    }

    if (permission.approval) {
      if (!context) {
        return this.decision(false, capabilityRequest, user, permission, "Approval requires middleware context");
      }

      const approval = normalizeApprovalResult(await permission.approval(capabilityRequest, context));
      if (approval.status !== "approved") {
        return this.decision(
          false,
          capabilityRequest,
          user,
          permission,
          approval.reason ?? (approval.status === "pending" ? "Approval is pending" : "Approval required but not granted"),
          approval,
        );
      }
    }

    return this.decision(true, capabilityRequest, user, permission);
  }

  private addPermission(serverName: string, permission: ToolPermission): this {
    const existing = this.permissionsByServer.get(serverName) ?? [];
    this.permissionsByServer.set(serverName, [...existing, permission]);
    return this;
  }

  private addCapabilityPermission(serverName: string, permission: CapabilityPermission): this {
    const existing = this.capabilityPermissionsByServer.get(serverName) ?? [];
    this.capabilityPermissionsByServer.set(serverName, [...existing, permission]);
    return this;
  }

  private decision(
    allowed: boolean,
    request: CapabilityOperationRequest,
    user: UserContext,
    permission?: CapabilityPermission,
    reason?: string,
    approvalMetadata?: ApprovalMetadata,
  ): PolicyDecision {
    return {
      allowed,
      reason,
      metadata: {
        policyName: this.name,
        matchedPermissions: permission
          ? [
              {
                policyName: this.name,
                serverName: request.serverName,
                operation: request.operation,
                target: request.target,
                targetKind: request.targetKind,
                toolName: request.targetKind === "tool" ? request.target : undefined,
                effect: permission.effect ?? "allow",
                metadata: permission.metadata,
              },
            ]
          : [],
        denialReason: allowed ? undefined : reason,
        serverName: request.serverName,
        operation: request.operation,
        target: request.target,
        targetKind: request.targetKind,
        toolName: request.targetKind === "tool" ? request.target : undefined,
        userId: user.id,
        permission: permission?.metadata,
        limiter: permission?.limiter,
        effect: permission?.effect ?? (allowed ? "allow" : "deny"),
        approval: approvalMetadata,
      },
    };
  }
}

/**
 * Builder returned by `policy.mcp(name)`.
 * @pk
 */
export class PolicyMcpBuilder {
  constructor(
    private readonly policy: Policy,
    private readonly serverName: string,
  ) {}

  allow(toolName: string, options: ToolPermissionOptions = {}): Policy {
    return this.policy.allow(this.serverName, toolName, options);
  }

  deny(toolName: string, options: ToolPermissionOptions = {}): Policy {
    return this.policy.deny(this.serverName, toolName, options);
  }

  allowCapability(permission: CapabilityPermissionOptions): Policy {
    return this.policy.allowCapability(this.serverName, permission);
  }

  denyCapability(permission: CapabilityPermissionOptions): Policy {
    return this.policy.denyCapability(this.serverName, permission);
  }
}

/**
 * Permission helper options.
 * @pk
 */
export type ToolPermissionOptions = {
  limiter?: ToolPermission["limiter"];
  approval?: ToolPermission["approval"];
  metadata?: Record<string, unknown>;
  sensitive?: boolean | Record<string, unknown>;
};

/**
 * Operation-based permission helper options.
 * @pk
 */
export type CapabilityPermissionOptions = Omit<CapabilityPermission, "effect"> & {
  metadata?: Record<string, unknown>;
  sensitive?: boolean | Record<string, unknown>;
};

/**
 * Helper to declare a user.
 * @pk
 */
export function user(id: string, metadata: UserOptions = {}): User {
  return new User(id, metadata);
}

/**
 * Helper to declare a group.
 * @pk
 */
export function group(options: ConstructorParameters<typeof Group>[0]): Group {
  return new Group(options);
}

/**
 * Helper to declare a policy.
 * @pk
 */
export function policy(name: string, options: { description?: string; metadata?: PolicyContract["metadata"] } = {}): Policy {
  return new Policy({ name, ...options });
}

/**
 * Helper to declare an allow permission.
 * @pk
 */
export function allow(toolName: string, options: ToolPermissionOptions = {}): ToolPermission {
  return { ...toToolPermission(toolName, options), effect: "allow" };
}

/**
 * Helper to declare a deny permission.
 * @pk
 */
export function deny(toolName: string, options: ToolPermissionOptions = {}): ToolPermission {
  return { ...toToolPermission(toolName, options), effect: "deny" };
}

/**
 * Helper to declare an allow capability permission.
 * @pk
 */
export function allowCapability(permission: CapabilityPermissionOptions): CapabilityPermission {
  return toCapabilityPermission(permission.server ?? "*", permission, "allow");
}

/**
 * Helper to declare a deny capability permission.
 * @pk
 */
export function denyCapability(permission: CapabilityPermissionOptions): CapabilityPermission {
  return toCapabilityPermission(permission.server ?? "*", permission, "deny");
}

/**
 * Helper to declare an allow-all policy.
 * @pk
 */
export function allowAll(name?: string): Policy {
  return Policy.allowAll(name);
}

/**
 * Permission helper for limiters.
 * @pk
 */
export function limit(limiter: ToolPermission["limiter"]): Pick<ToolPermissionOptions, "limiter"> {
  return { limiter };
}

type ApprovalHelper = {
  (handler: ToolPermission["approval"]): Pick<ToolPermissionOptions, "approval">;
  allow(metadata?: Record<string, unknown>): Pick<ToolPermissionOptions, "approval">;
  deny(reason?: string, metadata?: Record<string, unknown>): Pick<ToolPermissionOptions, "approval">;
  manual(options: ManualApprovalOptions): Pick<ToolPermissionOptions, "approval">;
};

/**
 * Options for an external approval workflow.
 * @pk
 */
export type ManualApprovalOptions = {
  requestId?: string | ((request: ToolApprovalRequest, context: MiddlewareContext) => string);
  url?: string | ((request: ToolApprovalRequest, context: MiddlewareContext) => string | undefined);
  reason?: string | ((request: ToolApprovalRequest, context: MiddlewareContext) => string | undefined);
  metadata?: Record<string, unknown> | ((request: ToolApprovalRequest, context: MiddlewareContext) => Record<string, unknown> | undefined);
  resolve?: ApprovalHandler<ToolApprovalRequest>;
};

/**
 * Permission helper for approval callbacks.
 * @pk
 */
export const approval: ApprovalHelper = Object.assign(
  (handler: ToolPermission["approval"]): Pick<ToolPermissionOptions, "approval"> => ({ approval: handler }),
  {
    allow(metadata?: Record<string, unknown>): Pick<ToolPermissionOptions, "approval"> {
      return { approval: () => ({ status: "approved", metadata }) };
    },
    deny(reason = "Approval required but not granted", metadata?: Record<string, unknown>): Pick<ToolPermissionOptions, "approval"> {
      return { approval: () => ({ status: "denied", reason, metadata }) };
    },
    manual(options: ManualApprovalOptions): Pick<ToolPermissionOptions, "approval"> {
      return {
        approval: async (request, context): Promise<ApprovalResult> => {
          const resolved = options.resolve ? normalizeApprovalResult(await options.resolve(request, context)) : undefined;
          if (resolved?.status === "approved" || resolved?.status === "denied") {
            return resolved;
          }

          return {
            status: "pending",
            requestId: typeof options.requestId === "function" ? options.requestId(request, context) : options.requestId,
            url: typeof options.url === "function" ? options.url(request, context) : options.url,
            reason: typeof options.reason === "function" ? options.reason(request, context) : options.reason,
            metadata: typeof options.metadata === "function" ? options.metadata(request, context) : options.metadata,
          };
        },
      };
    },
  },
);

/**
 * Permission helper for sensitive-operation metadata.
 * @pk
 */
export function sensitive(metadata: Record<string, unknown> = {}): Pick<ToolPermissionOptions, "sensitive"> {
  return { sensitive: metadata };
}

export type SubjectIndex = {
  resolve(userId: string): ResolvedSubject | null;
  groupsFor(userId: string): Group[];
};

export function buildSubjectIndex(groups: Group[]): SubjectIndex {
  const usersById = new Map<string, User>();
  const groupsByUserId = new Map<string, Group[]>();

  for (const group of groups) {
    if (group.users.length === 0) {
      throw new Error(`Group "${group.id}" must include at least one user`);
    }

    for (const user of group.users) {
      const existing = usersById.get(user.id);
      if (existing && !sameUser(existing, user)) {
        throw new Error(`User "${user.id}" has conflicting metadata across groups`);
      }

      usersById.set(user.id, user);
      groupsByUserId.set(user.id, [...(groupsByUserId.get(user.id) ?? []), group]);
    }
  }

  return {
    resolve(userId) {
      const subject = usersById.get(userId);
      const memberships = groupsByUserId.get(userId) ?? [];
      if (!subject || memberships.length === 0) {
        return null;
      }

      const tenant = subject.tenant ?? (subject.tenantId ? { id: subject.tenantId } : undefined);
      return {
        id: subject.id,
        displayName: subject.displayName,
        email: subject.email,
        metadata: subject.metadata,
        tenant,
        groups: memberships.map((membership) => ({
          id: membership.id,
          name: membership.name,
          metadata: membership.metadata,
        })),
        hasGroup(groupId: string): boolean {
          return memberships.some((membership) => membership.id === groupId);
        },
      };
    },
    groupsFor(userId) {
      return groupsByUserId.get(userId) ?? [];
    },
  };
}

export async function evaluateGroupPolicies(
  groups: Group[],
  request: ToolCallRequest | CapabilityOperationRequest,
  user: UserContext,
  context: MiddlewareContext,
): Promise<PolicyDecision> {
  const capabilityRequest = toCapabilityRequest(request);
  const decisions = await Promise.all(groups.map((group) => group.policy.evaluate(request, user, context)));
  const denied = decisions.find((decision) => !decision.allowed && decision.metadata?.matchedPermissions?.some((permission) => permission.effect === "deny"));
  if (denied) {
    return mergeGroupDecisions(false, groups, decisions, denied.reason ?? `${capabilityRequest.operation} denied by group policy`);
  }

  const allowed = decisions.some((decision) => decision.allowed);
  if (!allowed) {
    const firstReason = decisions.find((decision) => decision.reason)?.reason;
    return mergeGroupDecisions(
      false,
      groups,
      decisions,
      firstReason ?? (capabilityRequest.operation === "tool:call"
        ? `Tool "${capabilityRequest.target ?? "*"}" not permitted by effective group policies`
        : `Operation "${capabilityRequest.operation}" not permitted by effective group policies`),
    );
  }

  return mergeGroupDecisions(true, groups, decisions);
}

export function filterToolsByGroupPolicies<TTool extends { name: string }>(
  tools: TTool[],
  serverName: string,
  groups: Group[],
): TTool[] {
  return tools.filter((tool) => {
    const toolName = unproxyToolName(tool.name, serverName);
    const permissions = groups.flatMap((group) =>
      group.policy.getPermissions(serverName).map((permission) => ({ group, permission })),
    );
    const matches = permissions
      .map(({ group, permission }) => ({ group, permission: permission.tool === toolName || permission.tool === "*" ? permission : undefined }))
      .filter((entry): entry is { group: Group; permission: ToolPermission } => Boolean(entry.permission));

    if (matches.some(({ permission }) => permission.effect === "deny")) {
      return false;
    }

    return matches.some(({ permission }) => permission.effect !== "deny");
  });
}

function mergeGroupDecisions(
  allowed: boolean,
  groups: Group[],
  decisions: PolicyDecision[],
  reason?: string,
): PolicyDecision {
  return {
    allowed,
    reason,
    metadata: {
      policyName: "effective-group-policy",
      matchedGroups: groups.map((group) => group.id),
      matchedPermissions: decisions.flatMap((decision, index) =>
        (decision.metadata?.matchedPermissions ?? []).map((permission) => ({
          ...permission,
          groupId: groups[index]?.id,
        })),
      ),
      denialReason: allowed ? undefined : reason,
      approval: decisions.find((decision) => decision.metadata?.approval)?.metadata?.approval,
    },
  };
}

function toToolPermission(toolName: string, options: ToolPermissionOptions): ToolPermission {
  return {
    tool: toolName,
    limiter: options.limiter,
    approval: options.approval,
    metadata: {
      ...options.metadata,
      ...(options.sensitive
        ? {
            sensitive: options.sensitive === true ? true : options.sensitive,
          }
        : {}),
    },
  };
}

function toCapabilityPermission(
  serverName: string,
  options: CapabilityPermissionOptions,
  effect: "allow" | "deny",
): CapabilityPermission {
  return {
    server: serverName,
    operation: options.operation,
    target: options.target,
    targetKind: options.targetKind,
    limiter: options.limiter,
    approval: options.approval,
    effect,
    metadata: {
      ...options.metadata,
      ...(options.sensitive
        ? {
            sensitive: options.sensitive === true ? true : options.sensitive,
          }
        : {}),
    },
  };
}

function deniedReason(request: CapabilityOperationRequest, policyName: string): string {
  if (request.operation === "tool:call") {
    return `Tool "${request.target ?? "*"}" denied by policy "${policyName}"`;
  }

  return `Operation "${request.operation}" denied by policy "${policyName}"`;
}

function sameUser(left: User, right: User): boolean {
  return JSON.stringify(sortUser(left)) === JSON.stringify(sortUser(right));
}

function sortUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    tenantId: user.tenantId,
    tenant: sortRecord(user.tenant),
    metadata: sortRecord(user.metadata),
  };
}

function sortRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function unproxyToolName(toolName: string, serverName: string): string {
  const prefix = `${serverName}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}
