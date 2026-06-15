import { FentarisConfigError } from "./error.js";
import { diagnostic, toValidationResult, type FentarisDiagnostic, type FentarisConfigValidationResult } from "./diagnostics.js";
import { resolveFentarisConfig } from "./resolve.js";
import { isCredentialReference, type CredentialReference, type CredentialSourceMap } from "../credentials/index.js";
import type { Group } from "../governance/index.js";
import type { McpServer, ServerCredentialBinding } from "../server/index.js";
import type { FentarisTransport } from "../types/index.js";
import type { CapabilityPermission, Policy, ToolPermission } from "../types/index.js";
import type { McpProxyOptions } from "../proxy/McpProxy.js";

type PolicyWithDeclarations = {
  getDeclaredServerNames?: () => string[];
  getDeclaredPermissions?: () => Array<{ serverName: string; permissions: ToolPermission[]; capabilityPermissions: CapabilityPermission[] }>;
};

/**
 * Preserve TypeScript inference for Fentaris configuration objects.
 * @pk
 */
export function defineFentarisConfig<const TConfig extends McpProxyOptions>(config: TConfig): TConfig {
  return config;
}

/**
 * Validate Fentaris configuration and return structured diagnostics.
 * @pk
 */
export function validateFentarisConfig(config: McpProxyOptions): FentarisConfigValidationResult {
  const diagnostics: FentarisDiagnostic[] = [];

  if (!config || typeof config !== "object") {
    diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_INVALID_SHAPE", "Config must be an object", "Pass an object to fentaris(config)."));
    return toValidationResult(diagnostics);
  }

  const resolved = safeResolve(config, diagnostics);
  const servers = config.servers ?? [];
  const groups = config.groups ?? [];

  validateServers(servers, ["servers"], diagnostics);
  validateGroups(groups, diagnostics);
  validateScopedServerAmbiguity(servers, groups, diagnostics);
  validatePolicyVisibility(config.policy, availableGlobalServers(servers), ["policy"], diagnostics);
  for (const [index, group] of groups.entries()) {
    validatePolicyVisibility(group.policy, visibleServersForGroup(group, servers), ["groups", index, "policy"], diagnostics);
  }
  validateIdentity(config, groups, diagnostics);
  validateCredentialReferences(config, groups, diagnostics);
  validateTransportContracts(servers, ["servers"], diagnostics);
  for (const [groupIndex, group] of groups.entries()) {
    validateTransportContracts(group.servers, ["groups", groupIndex, "servers"], diagnostics);
  }

  if (resolved) {
    void resolved;
  }

  return toValidationResult(diagnostics);
}

/**
 * Validate Fentaris configuration and throw on error-severity diagnostics.
 * @pk
 */
export function assertValidFentarisConfig(config: McpProxyOptions): FentarisConfigValidationResult {
  const result = validateFentarisConfig(config);
  if (!result.valid) {
    throw new FentarisConfigError(result.errors);
  }
  return result;
}

function safeResolve(config: McpProxyOptions, diagnostics: FentarisDiagnostic[]) {
  try {
    return resolveFentarisConfig(config);
  } catch (error) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_CONFIG_RESOLUTION_FAILED",
      "Config could not be normalized",
      error instanceof Error ? error.message : "Config normalization failed.",
    ));
    return undefined;
  }
}

function validateServers(servers: McpServer[], path: Array<string | number>, diagnostics: FentarisDiagnostic[]): void {
  const seen = new Map<string, number>();
  for (const [index, server] of servers.entries()) {
    const serverPath = [...path, index];
    if (!server || typeof server !== "object") {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_SERVER_INVALID", "Server must be an MCP server object", "Use mcp(name, options).", { path: serverPath }));
      continue;
    }

    if (!server.name?.trim()) {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_SERVER_EMPTY_NAME", "Server name cannot be empty", "Give each MCP server a non-empty name.", { path: [...serverPath, "name"] }));
      continue;
    }

    const existing = seen.get(server.name);
    if (existing !== undefined) {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_DUPLICATE_SERVER", "Duplicate MCP server name", `Server "${server.name}" is declared more than once in the same scope.`, {
        path: [...serverPath, "name"],
        related: [{ path: [...path, existing, "name"], message: "First declaration with this server name." }],
        suggestions: [{ title: "Rename one server", message: "Server names must be unique inside each scope." }],
      }));
    } else {
      seen.set(server.name, index);
    }
  }
}

function validateGroups(groups: Group[], diagnostics: FentarisDiagnostic[]): void {
  const seen = new Map<string, number>();
  for (const [index, group] of groups.entries()) {
    const path = ["groups", index];
    if (!group || typeof group !== "object") {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_GROUP_INVALID", "Group must be a group declaration", "Use group({ id, users, policy }).", { path }));
      continue;
    }
    if (!group.id?.trim()) {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_GROUP_EMPTY_ID", "Group id cannot be empty", "Give each group a non-empty id.", { path: [...path, "id"] }));
    }
    const existing = seen.get(group.id);
    if (existing !== undefined) {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_DUPLICATE_GROUP", "Duplicate group id", `Group "${group.id}" is declared more than once.`, {
        path: [...path, "id"],
        related: [{ path: ["groups", existing, "id"], message: "First declaration with this group id." }],
      }));
    } else {
      seen.set(group.id, index);
    }
    validateServers(group.servers, [...path, "servers"], diagnostics);
  }
}

function validateScopedServerAmbiguity(globalServers: McpServer[], groups: Group[], diagnostics: FentarisDiagnostic[]): void {
  const globalByName = new Map(globalServers.map((server, index) => [server.name, { server, index }]));

  for (const [groupIndex, group] of groups.entries()) {
    for (const [serverIndex, server] of group.servers.entries()) {
      const global = globalByName.get(server.name);
      if (global && global.server !== server) {
        diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_SERVER_SCOPE_AMBIGUOUS", "Server name is declared globally and in a group", `Server "${server.name}" uses different instances across global and group scopes.`, {
          path: ["groups", groupIndex, "servers", serverIndex, "name"],
          hint: "Share the same server instance or use distinct server names.",
          related: [{ path: ["servers", global.index, "name"], message: "Global declaration with the same name." }],
        }));
      }
    }
  }

  for (const [leftIndex, left] of groups.entries()) {
    for (const [rightIndex, right] of groups.entries()) {
      if (rightIndex <= leftIndex || !groupsOverlap(left, right)) {
        continue;
      }
      for (const [leftServerIndex, leftServer] of left.servers.entries()) {
        const rightServerIndex = right.servers.findIndex((candidate) => candidate.name === leftServer.name);
        const rightServer = rightServerIndex >= 0 ? right.servers[rightServerIndex] : undefined;
        if (rightServer && rightServer !== leftServer) {
          diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_OVERLAPPING_GROUP_SERVER_AMBIGUOUS", "Overlapping groups declare ambiguous servers", `Groups "${left.id}" and "${right.id}" overlap and declare different "${leftServer.name}" servers.`, {
            path: ["groups", leftIndex, "servers", leftServerIndex, "name"],
            related: [{ path: ["groups", rightIndex, "servers", rightServerIndex, "name"], message: "Conflicting declaration in overlapping group." }],
          }));
        }
      }
    }
  }
}

function validatePolicyVisibility(
  policy: Policy | undefined,
  visibleServers: Set<string>,
  path: Array<string | number>,
  diagnostics: FentarisDiagnostic[],
): void {
  const declared = (policy as PolicyWithDeclarations | undefined)?.getDeclaredPermissions?.() ?? [];
  for (const entry of declared) {
    if (entry.serverName !== "*" && !visibleServers.has(entry.serverName)) {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_POLICY_SERVER_NOT_VISIBLE", "Policy references an invisible server", `Policy references server "${entry.serverName}", but that server is not visible in this scope.`, {
        path,
        hint: "Declare the server globally or in the same group as the policy.",
      }));
    }

    const allPermissions = [...entry.permissions, ...entry.capabilityPermissions];
    for (const permission of allPermissions) {
      const target = "tool" in permission ? permission.tool : permission.target;
      if (entry.serverName === "*" && target === "*") {
        diagnostics.push(diagnostic("warning", "FENTARIS_CONFIG_POLICY_WILDCARD_BROAD", "Policy grants broad wildcard access", "A policy grants access to every target on every server.", {
          path,
          hint: "Use specific server and tool names for production policies.",
        }));
      }
    }
  }
}

function validateIdentity(config: McpProxyOptions, groups: Group[], diagnostics: FentarisDiagnostic[]): void {
  const identityConfig = config.identity;
  const required = Boolean(identityConfig && typeof identityConfig === "object" && "required" in identityConfig && identityConfig.required === true);
  const hasStrategy = typeof identityConfig === "function"
    || Boolean(identityConfig && typeof identityConfig === "object" && "strategy" in identityConfig && identityConfig.strategy)
    || Boolean(config.auth);
  if (required && !hasStrategy && !hasDeclaredApiKeys(groups)) {
    diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_IDENTITY_REQUIRED_WITHOUT_STRATEGY", "Identity is required without a strategy", "Configure identity.strategy, auth, or declared API keys before requiring identity.", {
      path: ["identity"],
    }));
  }
}

function validateCredentialReferences(config: McpProxyOptions, groups: Group[], diagnostics: FentarisDiagnostic[]): void {
  const defaultCredentials = config.defaults?.credentials ?? {};
  const authBacked = Boolean(config.auth);
  for (const [index, server] of (config.servers ?? []).entries()) {
    validateServerCredentials(server, defaultCredentials, ["servers", index], diagnostics, authBacked);
  }
  for (const [groupIndex, group] of groups.entries()) {
    const available = { ...defaultCredentials, ...group.credentials };
    for (const [serverIndex, server] of group.servers.entries()) {
      validateServerCredentials(server, available, ["groups", groupIndex, "servers", serverIndex], diagnostics, authBacked);
    }
    for (const user of group.users) {
      for (const source of user.apiKeys) {
        if (!source) {
          diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_API_KEY_INVALID", "API-key declaration is invalid", "API-key sources must be credential source declarations.", { path: ["groups", groupIndex, "users"] }));
        }
      }
    }
  }
}

function validateTransportContracts(servers: McpServer[], path: Array<string | number>, diagnostics: FentarisDiagnostic[]): void {
  for (const [index, server] of servers.entries()) {
    const transport = getPrivateTransport(server);
    if (!transport) {
      diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_SERVER_TRANSPORT_MISSING", "Server is missing a transport", "Configure a transport with listTools, callTool, and close operations.", { path: [...path, index, "transport"] }));
      continue;
    }
    for (const operation of ["listTools", "callTool", "close"] as const) {
      if (typeof transport[operation] !== "function") {
        diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_TRANSPORT_CONTRACT_INVALID", "Transport is missing a required operation", `Transport for server "${server.name}" must implement ${operation}().`, { path: [...path, index, "transport", operation] }));
      }
    }
  }
}

function validateServerCredentials(
  server: McpServer,
  available: CredentialSourceMap,
  path: Array<string | number>,
  diagnostics: FentarisDiagnostic[],
  authBacked: boolean,
): void {
  const bindings = typeof server.getCredentialBindings === "function" ? server.getCredentialBindings() : [];
  for (const binding of bindings) {
    const reference = bindingReference(binding);
    if (!reference || available[reference.reference] || authBacked) {
      continue;
    }
    diagnostics.push(diagnostic("error", "FENTARIS_CONFIG_CREDENTIAL_MISSING", "Credential reference cannot be resolved", `Server "${server.name}" references credential "${reference.reference}", but no source is visible in this scope.`, {
      path,
      hint: "Declare the credential in defaults.credentials, group credentials, or auth-backed storage.",
    }));
  }
}

function bindingReference(binding: ServerCredentialBinding): CredentialReference | undefined {
  return isCredentialReference(binding.credential) ? binding.credential : undefined;
}

function getPrivateTransport(server: McpServer): FentarisTransport | undefined {
  return (server as unknown as { transport?: FentarisTransport }).transport;
}

function availableGlobalServers(servers: McpServer[]): Set<string> {
  return new Set(servers.map((server) => server.name));
}

function visibleServersForGroup(group: Group, globalServers: McpServer[]): Set<string> {
  return new Set([...globalServers.map((server) => server.name), ...group.servers.map((server) => server.name)]);
}

function groupsOverlap(left: Group, right: Group): boolean {
  const rightUserIds = new Set(right.users.map((user) => user.id));
  return left.users.some((user) => rightUserIds.has(user.id));
}

function hasDeclaredApiKeys(groups: Group[]): boolean {
  return groups.some((group) => group.users.some((user) => user.apiKeys.length > 0));
}
