/**
 * Execution placement resolution.
 *
 * Placement is *where* a configured MCP workload runs for a given downstream
 * subject and session. It is strictly orthogonal to capability access: a
 * placement binding only selects a target after the server catalog has made
 * the server visible and effective policy has authorized the operation. The
 * resolver here never exposes, lists, or grants MCP capabilities; it returns a
 * logical target name and kind, and the caller is responsible for having
 * already established visibility and authorization.
 *
 * Resolution precedence (most specific first):
 *
 * 1. an explicit session-selected target, when it is among the subject's
 *    resolved eligible bindings;
 * 2. a user-scoped binding;
 * 3. matching group-scoped bindings, deduplicated when they converge on one
 *    target and rejected as ambiguous when they do not;
 * 4. a global binding;
 * 5. the implicit built-in `cloud` target when no placement is declared.
 *
 * Declaration order never decides placement.
 * @pk
 */

import { edgeError, type EdgeError } from "./errors.js";
import type {
  DeviceSelector,
  ExecutionTarget,
  TargetKind,
  TargetSelectionStrategy,
} from "./target.js";
import type {
  EdgeSelectionExplanation,
  EdgeSelectionRequest,
} from "./inventoryService.js";

/** Placement scope of a binding. @pk */
export type PlacementScope = "global" | "group" | "user";

/** Where a resolved placement came from. @pk */
export type PlacementSource = "explicit" | "user" | "group" | "global" | "implicit-cloud";

/** A normalized placement binding, independent of declaration style. @pk */
export interface PlacementBindingModel {
  /** Server name the binding applies to. @pk */
  readonly serverName: string;
  /** Scope of the binding. @pk */
  readonly scope: PlacementScope;
  /** Group id for group-scoped bindings. @pk */
  readonly groupId?: string;
  /** User id for user-scoped bindings. @pk */
  readonly userId?: string;
  /** Registered or built-in target name. @pk */
  readonly targetName: string;
}

/** Inputs for resolving placement for a subject and server. @pk */
export interface PlacementRequest {
  /** Server the operation targets. @pk */
  readonly serverName: string;
  /** Authenticated subject id, if known. @pk */
  readonly subjectId?: string;
  /** Group ids the subject is a member of at resolution time. @pk */
  readonly groupIds: readonly string[];
  /** Explicit target requested by the downstream session, if any. @pk */
  readonly requestedTarget?: string;
}

/** A resolved placement. Carries no capability information. @pk */
export interface PlacementResolution {
  /** Resolved target name (registered or the built-in `cloud`). @pk */
  readonly targetName: string;
  /** Target kind, copied from the registered declaration. @pk */
  readonly kind: TargetKind;
  /** Which precedence layer selected this placement. @pk */
  readonly source: PlacementSource;
}

/** A normalized startup diagnostic for static placement ambiguity. @pk */
export interface PlacementOverlapDiagnostic {
  /** Server with overlapping group bindings. @pk */
  readonly serverName: string;
  /** Subject whose groups overlap. @pk */
  readonly subjectId: string;
  /** Distinct targets the overlapping groups bind. @pk */
  readonly targets: readonly string[];
  /** Group ids that produced the overlap. @pk */
  readonly groupIds: readonly string[];
}

/** Inputs for {@link PlacementResolver}. @pk */
export interface PlacementResolverInputs {
  /** Registered execution targets, keyed by name. @pk */
  readonly targets: ReadonlyMap<string, ExecutionTarget>;
  /** Normalized placement bindings. @pk */
  readonly bindings: readonly PlacementBindingModel[];
}

const CLOUD_TARGET_NAME = "cloud";

/** A resolver that turns bindings and targets into a placement decision. @pk */
export class PlacementResolver {
  private readonly targets: ReadonlyMap<string, ExecutionTarget>;
  private readonly bindings: readonly PlacementBindingModel[];

  constructor(inputs: PlacementResolverInputs) {
    this.targets = inputs.targets;
    this.bindings = inputs.bindings;
  }

  /**
   * Resolve the placement for a server and subject.
   *
   * @throws {EdgeError} `EDGE_UNAUTHORIZED_TARGET` when an explicit session
   *   target is not among the subject's eligible bindings.
   * @throws {EdgeError} `EDGE_PLACEMENT_AMBIGUOUS` when matching group bindings
   *   select different equally specific targets.
   * @pk
   */
  resolve(request: PlacementRequest): PlacementResolution {
    const eligible = this.eligibleTargets(request);

    if (request.requestedTarget !== undefined) {
      if (!eligible.has(request.requestedTarget)) {
        // Reject without revealing inaccessible target or device details. @pk
        throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Requested execution target is not eligible for this subject.", {
          details: { serverName: request.serverName },
        });
      }
      return this.toResolution(request.requestedTarget, "explicit");
    }

    const userTarget = this.matchingUserTarget(request);
    if (userTarget !== undefined) {
      return this.toResolution(userTarget, "user");
    }

    const groupTarget = this.matchingGroupTarget(request);
    if (groupTarget !== undefined) {
      return this.toResolution(groupTarget, "group");
    }

    const globalTarget = this.matchingGlobalTarget(request.serverName);
    if (globalTarget !== undefined) {
      return this.toResolution(globalTarget, "global");
    }

    return this.toResolution(CLOUD_TARGET_NAME, "implicit-cloud");
  }

  /**
   * Target names a subject is eligible to select from explicitly (user, group
   * when unambiguous, and global). The implicit `cloud` target is always
   * eligible because it never requires a binding. @pk
   */
  eligibleTargets(request: PlacementRequest): Set<string> {
    const eligible = new Set<string>();
    eligible.add(CLOUD_TARGET_NAME);

    const userTarget = this.matchingUserTarget(request);
    if (userTarget !== undefined) {
      eligible.add(userTarget);
    }

    const groupBindings = this.matchingGroupBindings(request);
    const distinct = new Set(groupBindings.map((binding) => binding.targetName));
    for (const target of distinct) {
      eligible.add(target);
    }

    const globalTarget = this.matchingGlobalTarget(request.serverName);
    if (globalTarget !== undefined) {
      eligible.add(globalTarget);
    }

    return eligible;
  }

  private matchingUserTarget(request: PlacementRequest): string | undefined {
    if (request.subjectId === undefined) {
      return undefined;
    }
    const binding = this.bindings.find(
      (entry) =>
        entry.scope === "user" &&
        entry.serverName === request.serverName &&
        entry.userId === request.subjectId,
    );
    return binding?.targetName;
  }

  private matchingGroupBindings(request: PlacementRequest): readonly PlacementBindingModel[] {
    if (request.groupIds.length === 0) {
      return [];
    }
    const membership = new Set(request.groupIds);
    return this.bindings.filter(
      (entry) => entry.scope === "group" && entry.serverName === request.serverName && entry.groupId !== undefined && membership.has(entry.groupId),
    );
  }

  private matchingGroupTarget(request: PlacementRequest): string | undefined {
    const matching = this.matchingGroupBindings(request);
    if (matching.length === 0) {
      return undefined;
    }
    const distinct = new Set(matching.map((binding) => binding.targetName));
    if (distinct.size === 1) {
      // Converging group bindings deduplicate to one target. @pk
      return matching[0].targetName;
    }
    if (distinct.size > 1) {
      throw edgeError("EDGE_PLACEMENT_AMBIGUOUS", "Conflicting group placement bindings for the same subject and server.", {
        details: {
          serverName: request.serverName,
          targets: [...distinct],
          groupIds: matching.map((binding) => binding.groupId),
        },
      });
    }
    return undefined;
  }

  private matchingGlobalTarget(serverName: string): string | undefined {
    const binding = this.bindings.find(
      (entry) => entry.scope === "global" && entry.serverName === serverName,
    );
    return binding?.targetName;
  }

  private toResolution(targetName: string, source: PlacementSource): PlacementResolution {
    const target = this.targets.get(targetName);
    const kind: TargetKind = target ? target.kind : targetName === CLOUD_TARGET_NAME ? "cloud" : "cloud";
    return { targetName, kind, source };
  }
}

/** Inputs for static overlap detection. @pk */
export interface StaticOverlapInputs {
  /** Static subject -> group ids membership known at startup. @pk */
  readonly subjectGroups: ReadonlyMap<string, readonly string[]>;
  /** Normalized placement bindings. @pk */
  readonly bindings: readonly PlacementBindingModel[];
  /** User-scoped bindings known at startup, used to suppress overlap warnings. @pk */
  readonly userBindings?: ReadonlySet<string>;
}

/**
 * Detect statically overlapping group bindings that bind the same server to
 * different targets for the same subject and have no user binding to resolve
 * the conflict. Dynamic membership that cannot be known at startup is not
 * reported here; it surfaces as a runtime `EDGE_PLACEMENT_AMBIGUOUS` error.
 * @pk
 */
export function detectStaticPlacementOverlaps(inputs: StaticOverlapInputs): PlacementOverlapDiagnostic[] {
  const diagnostics: PlacementOverlapDiagnostic[] = [];
  // Index group bindings by server -> groupId -> target. @pk
  const byServer = new Map<string, Map<string, string>>();
  for (const binding of inputs.bindings) {
    if (binding.scope !== "group" || binding.groupId === undefined) {
      continue;
    }
    let perGroup = byServer.get(binding.serverName);
    if (!perGroup) {
      perGroup = new Map();
      byServer.set(binding.serverName, perGroup);
    }
    perGroup.set(binding.groupId, binding.targetName);
  }

  const userBindingKey = (serverName: string, subjectId: string) => `${serverName}|${subjectId}`;

  for (const [subjectId, groupIds] of inputs.subjectGroups) {
    if (groupIds.length < 2) {
      continue;
    }
    for (const [serverName, perGroup] of byServer) {
      const matching = new Map<string, string>();
      for (const groupId of groupIds) {
        const target = perGroup.get(groupId);
        if (target !== undefined) {
          matching.set(groupId, target);
        }
      }
      if (matching.size < 2) {
        continue;
      }
      const distinct = new Set(matching.values());
      if (distinct.size === 1) {
        continue; // Converging groups are valid. @pk
      }
      if (inputs.userBindings?.has(userBindingKey(serverName, subjectId))) {
        continue; // A user binding resolves the conflict. @pk
      }
      diagnostics.push({
        serverName,
        subjectId,
        targets: [...distinct],
        groupIds: [...matching.keys()],
      });
    }
  }

  return diagnostics;
}

/**
 * Context passed to a {@link DeviceResolver} when resolving a selector.
 *
 * Carries only non-sensitive routing metadata. Physical device identities are
 * never embedded in application code; the control plane maps the logical
 * selector onto an enrolled device.
 * @pk
 */
export interface DeviceResolverContext {
  /** Authenticated subject id, if known. @pk */
  readonly subjectId?: string;
  /** Tenant id, if known. @pk */
  readonly tenantId?: string;
  /** Target name being resolved. @pk */
  readonly targetName: string;
  /** Device id requested during downstream session establishment, if any. @pk */
  readonly requestedDeviceId?: string;
  /** Pool selection strategy declared on the target, if any. @pk */
  readonly strategy?: TargetSelectionStrategy;
  /** Optional typed declarative selection supplied for this first pin. @pk */
  readonly declarativeSelection?: EdgeSelectionRequest;
}

/** A resolved eligible enrolled device. @pk */
export interface DeviceResolution {
  /** Stable opaque edge node id backing the device key. @pk */
  readonly edgeNodeId: string;
  /** Control-plane alias, when known. @pk */
  readonly alias?: string;
  /** Redacted explanation when declarative selection chose the device. @pk */
  readonly selection?: EdgeSelectionExplanation;
}

/**
 * Control-plane interface that maps logical selectors onto enrolled devices.
 *
 * Implementations own device aliases, pool membership, subject grants, health,
 * capacity, and default-device preferences. Each method resolves only devices
 * eligible for the authenticated subject, tenant, target, deployment, and
 * current connection state, returning `null` for "no eligible device" so
 * fallback selectors can proceed.
 * @pk
 */
export interface DeviceResolver {
  /** Revalidate and resolve a durable pre-pin selection by opaque node id. @pk */
  resolveSelectedDevice?(
    edgeNodeId: string,
    inventoryVersion: number,
    context: DeviceResolverContext,
  ): Promise<DeviceResolution | null>;
  /** Resolve typed requirements/preferences against the current authorized inventory. @pk */
  resolveDeclarativeDevice?(
    selection: EdgeSelectionRequest,
    context: DeviceResolverContext,
  ): Promise<DeviceResolution | null>;
  /** Resolve the device requested during downstream session establishment. @pk */
  resolveSessionDevice?(context: DeviceResolverContext): Promise<DeviceResolution | null>;
  /** Resolve the subject's configured default device. @pk */
  resolveUserDefaultDevice?(context: DeviceResolverContext): Promise<DeviceResolution | null>;
  /** Resolve a control-plane named alias to a device. @pk */
  resolveNamedAlias(alias: string, context: DeviceResolverContext): Promise<DeviceResolution | null>;
  /** Resolve one eligible device from a shared pool using `strategy`. @pk */
  resolvePool(pool: string, strategy: TargetSelectionStrategy | undefined, context: DeviceResolverContext): Promise<DeviceResolution | null>;
}

/**
 * Resolve a {@link DeviceSelector} against a {@link DeviceResolver}.
 *
 * A `fallback` selector resolves its children in order and returns the first
 * eligible device. `null` from a child means "no eligible device for this
 * selector", so fallback proceeds; only when every child is ineligible does
 * this function return `null`.
 * @pk
 */
export async function resolveDeviceSelector(
  selector: DeviceSelector,
  context: DeviceResolverContext,
  resolver: DeviceResolver,
): Promise<DeviceResolution | null> {
  switch (selector.type) {
    case "session":
      return resolver.resolveSessionDevice ? resolver.resolveSessionDevice(context) : null;
    case "user-default":
      return resolver.resolveUserDefaultDevice ? resolver.resolveUserDefaultDevice(context) : null;
    case "named": {
      if (!selector.alias) {
        return null;
      }
      return resolver.resolveNamedAlias(selector.alias, context);
    }
    case "pool": {
      if (!selector.pool) {
        return null;
      }
      return resolver.resolvePool(selector.pool, selector.strategy, context);
    }
    case "fallback": {
      if (!selector.selectors) {
        return null;
      }
      // Apply the target-level strategy to the fallback context if declared. @pk
      const childContext: DeviceResolverContext = context.strategy
        ? { ...context, strategy: context.strategy }
        : context;
      for (const child of selector.selectors) {
        const resolved = await resolveDeviceSelector(child, childContext, resolver);
        if (resolved !== null) {
          return resolved;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Resolve a device selector and return a structured `EDGE_UNAVAILABLE` error
 * when no eligible device is found. Never leaks private device inventory.
 * @pk
 */
export async function requireDevice(
  selector: DeviceSelector,
  context: DeviceResolverContext,
  resolver: DeviceResolver,
): Promise<DeviceResolution> {
  const resolved = await resolveDeviceSelector(selector, context, resolver);
  if (resolved === null) {
    throw edgeError("EDGE_UNAVAILABLE", "No eligible edge device for execution target.", {
      details: { targetName: context.targetName },
    });
  }
  return resolved;
}

export type { EdgeError };