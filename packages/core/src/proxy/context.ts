import { ResponseController } from "../types/middleware.js";
import type { CapabilityOperationRequest, ToolCallRequest } from "../types/mcp-operation.js";
import { approvalDecision } from "../types/shared.js";
import type { IdentityMetadata, ResolvedSubject, UserContext } from "../types/shared.js";
import type { MiddlewareContext } from "../types/middleware.js";
import type { Policy, Registry } from "../types/policy.js";
import type { ProxyContext } from "../types/proxy.js";
import { getToolPermission, getCapabilityPermission } from "../policy.js";
import { type Group, type SubjectIndex } from "../governance.js";
import { capabilityPermissionsForPolicy } from "./capabilities.js";
import type { Logger } from "../logger.js";
import type { McpServer } from "../server/McpServer.js";

// Utility function we'll use internally
function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!metadata || typeof metadata[key] !== "string") {
    return undefined;
  }
  return metadata[key];
}

export type ContextDependencies = {
  logger?: Logger; // We might need this for child logger creation
  registry?: Registry;
  serverByName: Map<string, McpServer>;
  groups: Group[];
  subjectIndex?: SubjectIndex;
  policy?: Policy;
};

export function createContextualLogger(
  deps: { logger: Logger },
  options: {
    operation: ProxyContext["operation"];
    user: UserContext;
    subject?: ResolvedSubject;
    identity?: IdentityMetadata;
    serverName?: string;
    toolName?: string;
    proxyToolName?: string;
    target?: string;
    targetKind?: string;
    sessionId?: string;
  }
): Logger {
  return deps.logger.child({
    operation: options.operation,
    userId: options.user.id,
    subjectId: options.subject?.id ?? options.user.id,
    serverName: options.serverName,
    toolName: options.toolName,
    proxyToolName: options.proxyToolName,
    target: options.target,
    targetKind: options.targetKind,
    transportType: "unknown",
    sessionId: options.sessionId,
    identityStrategy: options.identity?.strategy,
    authenticated: options.identity?.authenticated,
  });
}

export function createPolicyCan(
  deps: Pick<ContextDependencies, "groups" | "subjectIndex" | "policy">,
  subject: ResolvedSubject | undefined
): ProxyContext["policy"]["can"] {
  return (serverName: string, toolName: string): boolean => {
    if (deps.groups.length > 0) {
      const groups = subject ? deps.subjectIndex?.groupsFor(subject.id) ?? [] : [];
      let allowed = false;

      for (const group of groups) {
        const permission = getToolPermission(group.policy.getPermissions(serverName), toolName);
        if (!permission) {
          continue;
        }

        if (permission.effect === "deny") {
          return false;
        }

        allowed = true;
      }

      return allowed;
    }

    if (deps.policy) {
      const permission = getToolPermission(deps.policy.getPermissions(serverName), toolName);
      if (!permission) {
        return false;
      }

      return permission.effect !== "deny";
    }

    return true;
  };
}

export function createProxyContext(
  deps: Pick<ContextDependencies, "registry" | "serverByName" | "groups" | "subjectIndex" | "policy">,
  options: {
    operation: ProxyContext["operation"];
    user: UserContext;
    subject?: ResolvedSubject;
    identity?: IdentityMetadata;
    log: Logger;
    request?: ToolCallRequest;
    capability?: CapabilityOperationRequest & {
      proxyTarget?: string;
      completionRefType?: "ref/prompt" | "ref/resource";
      argumentName?: string;
    };
    raw?: ProxyContext["raw"];
    transport?: ProxyContext["transport"];
    policy?: Policy;
  }
): ProxyContext {
  const response = new ResponseController();
  const state: Record<string, unknown> = {};
  const policyDecision = undefined as ProxyContext["policyDecision"];
  const legacyContext: MiddlewareContext = {
    user: options.user,
    subject: options.subject,
    identity: options.identity,
    approval: approvalDecision,
    log: options.log,
    res: response,
    policy: options.policy,
    registry: deps.registry,
    policyDecision,
  };
  const context = legacyContext as ProxyContext;
  context.operation = options.operation;
  context.transport = options.transport ?? {
    type: "unknown",
    sessionId: stringMetadata(options.identity?.metadata, "sessionId"),
    requestId: stringMetadata(options.identity?.metadata, "requestId"),
  };
  context.auth = {
    strategy: options.identity?.strategy,
    authenticated: options.identity?.authenticated ?? Boolean(options.user.id),
    userId: options.identity?.userId ?? options.user.id,
    metadata: options.identity?.metadata,
  };
  context.policy = {
    matchedGroups: [],
    matchedPermissions: [],
    policy: options.policy,
    can: createPolicyCan(deps, options.subject),
  };
  context.credentials = { sources: [] };
  context.response = response;
  context.res = response;
  context.state = state;
  context.raw = options.raw;
  if (options.request) {
    const server = deps.serverByName.get(options.request.serverName);
    context.server = {
      name: options.request.serverName,
      displayName: server?.displayName,
    };
    context.tool = {
      name: options.request.toolName,
      proxyName: options.request.proxyToolName,
    };
    context.args = options.request.arguments;
  }
  if (options.capability) {
    const server = deps.serverByName.get(options.capability.serverName);
    context.server = {
      name: options.capability.serverName,
      displayName: server?.displayName,
    };
    if (options.capability.targetKind === "resource") {
      context.resource = {
        uri: options.capability.target,
        proxyUri: options.capability.proxyTarget,
      };
    } else if (options.capability.targetKind === "resourceTemplate") {
      context.resource = {
        uriTemplate: options.capability.target,
        proxyUriTemplate: options.capability.proxyTarget,
      };
    } else if (options.capability.targetKind === "prompt" && options.capability.target) {
      context.prompt = {
        name: options.capability.target,
        proxyName: options.capability.proxyTarget ?? options.capability.target,
      };
    } else if (options.capability.targetKind === "completion" && options.capability.target) {
      context.completion = {
        refType: options.capability.completionRefType ?? "ref/prompt",
        target: options.capability.target,
        proxyTarget: options.capability.proxyTarget,
        argumentName: options.capability.argumentName ?? "",
      };
    }
  }
  context.deny = response.deny.bind(response);
  context.fail = response.fail.bind(response);
  context.continue = response.continue.bind(response);
  context.inject = response.injectToAgent.bind(response);
  context.error = response.fail.bind(response);
  return context;
}

export function createCapabilityContext(
  deps: ContextDependencies & { logger: Logger },
  request: CapabilityOperationRequest & {
    proxyTarget?: string;
    completionRefType?: "ref/prompt" | "ref/resource";
    argumentName?: string;
  } & {
    user: UserContext;
    subject?: ResolvedSubject;
    identity?: IdentityMetadata;
  }
): ProxyContext {
  const log = createContextualLogger(deps, {
    operation: request.operation,
    user: request.user,
    subject: request.subject,
    identity: request.identity,
    serverName: request.serverName,
    target: request.target,
    targetKind: request.targetKind,
  });
  return createProxyContext(deps, {
    operation: request.operation,
    user: request.user,
    subject: request.subject,
    identity: request.identity,
    log,
    capability: request,
    raw: request.raw as ProxyContext["raw"],
    policy: deps.policy,
  });
}
