import type { CapabilityOperationRequest } from "../types/mcp-operation.js";
import type { CapabilityPermission, Policy } from "../types/policy.js";
import type { ResolvedSubject } from "../types/shared.js";
import { type Group, type SubjectIndex } from "../governance.js";
import { toCapabilityPermissions, getCapabilityPermission } from "../policy.js";

export function capabilityPermissionsForPolicy(policy: Policy, serverName: string): CapabilityPermission[] {
  return policy.getCapabilityPermissions?.(serverName) ?? toCapabilityPermissions(serverName, policy.getPermissions(serverName));
}

export function isCapabilityAllowed(
  deps: { groups: Group[]; policy?: Policy; subjectIndex?: SubjectIndex },
  request: CapabilityOperationRequest,
  subject: ResolvedSubject | undefined,
  userGroups: Group[] = subject ? deps.subjectIndex?.groupsFor(subject.id) ?? [] : [],
): boolean {
  if (deps.groups.length > 0) {
    let allowed = false;

    for (const group of userGroups) {
      const permission = getCapabilityPermission(capabilityPermissionsForPolicy(group.policy, request.serverName), request);
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
    const permission = getCapabilityPermission(capabilityPermissionsForPolicy(deps.policy, request.serverName), request);
    if (!permission) {
      return false;
    }

    return permission.effect !== "deny";
  }

  return true;
}
