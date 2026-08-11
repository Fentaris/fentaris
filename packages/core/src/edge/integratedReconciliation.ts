import { createHash } from "node:crypto";
import type { McpServer } from "../server/McpServer.js";
import { StdioTransport } from "../transports/client/StdioTransport.js";
import type {
  EdgeDesiredStateStore,
  EdgeDeviceRecord,
  EdgeDeviceRegistry,
  EdgeInventoryListItem,
} from "./controlPlane.js";
import {
  EDGE_PROTOCOL_VERSION,
  type EdgeDesiredDeployment,
  type EdgeDesiredStateMessage,
} from "./controlProtocol.js";
import type { EdgeAssignmentResolver } from "./integratedConfig.js";
import type {
  EdgeDesiredAssignmentSnapshot,
  EdgeDesiredAssignmentStore,
  EdgeReconciliationTrigger,
  EdgeReconciliationTriggerService,
} from "./integratedServices.js";
import type { EdgeTelemetry } from "./observability.js";
import type { PlacementBindingModel } from "./placement.js";
import type { SetupSchema } from "./setup.js";
import type { DeviceSelector, EdgeExecutionTarget, ExecutionTarget } from "./target.js";
import type { InstallationRecipe } from "./installation.js";
import { edgeError } from "./errors.js";
import type { DeviceResolution, DeviceResolver, DeviceResolverContext } from "./placement.js";
import type { EdgePresenceStore, EdgeReadinessStore } from "./inventory.js";

export type EdgeDeploymentWithheldReason =
  | "cloud-placement"
  | "unsupported-transport"
  | "missing-setup-schema"
  | "subject-not-authorized"
  | "device-not-selected"
  | "ambiguous-placement"
  | "managed-assignment-unavailable";

export type EdgeDeploymentCatalogDiagnostic = {
  readonly serverName: string;
  readonly reason: EdgeDeploymentWithheldReason;
};

export type EdgeDeploymentCatalogEntry = {
  readonly deployment: EdgeDesiredDeployment;
  readonly targetName: string;
  readonly selector: DeviceSelector;
  readonly scope: PlacementBindingModel["scope"];
  readonly userId?: string;
  readonly groupId?: string;
};

export type EdgeDeploymentCatalog = {
  readonly digest: string;
  readonly entries: readonly EdgeDeploymentCatalogEntry[];
  readonly diagnostics: readonly EdgeDeploymentCatalogDiagnostic[];
};

export type CompileEdgeDeploymentCatalogOptions = {
  readonly servers: readonly McpServer[];
  readonly targets: ReadonlyMap<string, ExecutionTarget>;
  readonly bindings: readonly PlacementBindingModel[];
  readonly setupSchemas: ReadonlyMap<string, SetupSchema>;
  readonly installationRecipes?: ReadonlyMap<string, InstallationRecipe>;
};

/** Compile application declarations once into a deterministic immutable Edge catalog. @pk */
export function compileEdgeDeploymentCatalog(
  options: CompileEdgeDeploymentCatalogOptions,
): EdgeDeploymentCatalog {
  const servers = new Map(options.servers.map((server) => [server.name, server]));
  const entries: EdgeDeploymentCatalogEntry[] = [];
  const diagnostics: EdgeDeploymentCatalogDiagnostic[] = [];

  for (const binding of [...options.bindings].sort(compareBindings)) {
    const target = options.targets.get(binding.targetName);
    if (!target || target.kind !== "edge") {
      diagnostics.push({ serverName: binding.serverName, reason: "cloud-placement" });
      continue;
    }
    const server = servers.get(binding.serverName);
    if (!server || !(server.transport instanceof StdioTransport)) {
      diagnostics.push({ serverName: binding.serverName, reason: "unsupported-transport" });
      continue;
    }
    const setupSchema = options.setupSchemas.get(server.name);
    if (!setupSchema) {
      diagnostics.push({ serverName: binding.serverName, reason: "missing-setup-schema" });
      continue;
    }
    const recipe = server.transport.toLaunchRecipe(setupSchema);
    const installationRecipe = options.installationRecipes?.get(server.name);
    const deployment: EdgeDesiredDeployment = Object.freeze({
      deploymentId: server.name,
      serverName: server.name,
      recipe,
      launchDigest: recipe.digest,
      ...(installationRecipe
        ? { installationRecipe, installationDigest: installationRecipe.digest }
        : {}),
      setupSchema,
      setupSchemaVersion: setupSchema.version,
      ...(binding.userId ? { subjectIds: Object.freeze([binding.userId]) } : {}),
    });
    entries.push(Object.freeze({
      deployment,
      targetName: binding.targetName,
      selector: cloneSelector(target.device),
      scope: binding.scope,
      ...(binding.userId ? { userId: binding.userId } : {}),
      ...(binding.groupId ? { groupId: binding.groupId } : {}),
    }));
  }

  const canonicalEntries = entries.sort((left, right) =>
    left.deployment.deploymentId.localeCompare(right.deployment.deploymentId)
      || left.targetName.localeCompare(right.targetName)
      || left.scope.localeCompare(right.scope)
      || (left.userId ?? left.groupId ?? "").localeCompare(right.userId ?? right.groupId ?? ""));
  const digest = stableDigest(canonicalEntries.map((entry) => ({
    deployment: entry.deployment,
    targetName: entry.targetName,
    selector: entry.selector,
    scope: entry.scope,
    userId: entry.userId,
    groupId: entry.groupId,
  })));
  return Object.freeze({
    digest,
    entries: Object.freeze(canonicalEntries),
    diagnostics: Object.freeze(diagnostics.sort((left, right) =>
      left.serverName.localeCompare(right.serverName) || left.reason.localeCompare(right.reason))),
  });
}

export type EdgeEligibilityContext = {
  readonly device: EdgeDeviceRecord;
  readonly catalog: EdgeDeploymentCatalog;
  readonly groupIds: readonly string[];
  readonly tenantDevices: readonly EdgeInventoryListItem[];
  readonly assignmentResolver?: EdgeAssignmentResolver;
};

export type EdgeEligibilityResult = {
  readonly deployments: readonly EdgeDesiredDeployment[];
  readonly withheld: readonly EdgeDeploymentCatalogDiagnostic[];
};

/** Derive only assignments proven for both the subject and selected device. @pk */
export async function deriveEligibleEdgeDeployments(
  context: EdgeEligibilityContext,
): Promise<EdgeEligibilityResult> {
  const deployments = new Map<string, EdgeDesiredDeployment>();
  const withheld: EdgeDeploymentCatalogDiagnostic[] = [];
  for (const entry of context.catalog.entries) {
    if (!subjectMatches(entry, context.device.subjectId, context.groupIds)) {
      withheld.push({ serverName: entry.deployment.serverName, reason: "subject-not-authorized" });
      continue;
    }
    let selected = selectorMatches(entry.selector, context.device, context.tenantDevices);
    if (!selected && context.assignmentResolver && context.device.subjectId) {
      try {
        const eligible = await context.assignmentResolver.resolveEligibleDevices({
          tenantId: context.device.tenantId,
          subjectId: context.device.subjectId,
          serverName: entry.deployment.serverName,
          deploymentId: entry.deployment.deploymentId,
        });
        selected = eligible.includes(context.device.edgeNodeId);
      } catch {
        withheld.push({ serverName: entry.deployment.serverName, reason: "managed-assignment-unavailable" });
        continue;
      }
    }
    if (!selected) {
      withheld.push({ serverName: entry.deployment.serverName, reason: "device-not-selected" });
      continue;
    }
    deployments.set(entry.deployment.deploymentId, entry.deployment);
  }
  return Object.freeze({
    deployments: Object.freeze([...deployments.values()].sort((left, right) => left.deploymentId.localeCompare(right.deploymentId))),
    withheld: Object.freeze(withheld.slice(0, 100)),
  });
}

export type IntegratedEdgeReconcilerOptions = {
  readonly catalog: EdgeDeploymentCatalog;
  readonly deviceRegistry: EdgeDeviceRegistry;
  readonly desiredStateStore: EdgeDesiredStateStore;
  readonly assignmentStore: EdgeDesiredAssignmentStore;
  readonly publish: (state: EdgeDesiredStateMessage) => Promise<"published" | "unchanged">;
  readonly groupsForSubject?: (subjectId: string) => readonly string[];
  readonly assignmentResolver?: EdgeAssignmentResolver;
  readonly telemetry?: EdgeTelemetry;
  readonly now?: () => number;
};

/** Per-device serialized desired-state reconciliation with durable CAS. @pk */
export class IntegratedEdgeReconciler implements EdgeReconciliationTriggerService {
  private readonly queues = new Map<string, Promise<EdgeDesiredAssignmentSnapshot | undefined>>();
  private readonly diagnostics = new Map<string, readonly EdgeDeploymentCatalogDiagnostic[]>();
  private readonly now: () => number;
  private accepting = true;

  constructor(private readonly options: IntegratedEdgeReconcilerOptions) {
    this.now = options.now ?? Date.now;
  }

  async enqueue(input: {
    readonly tenantId: string;
    readonly edgeNodeId: string;
    readonly trigger: EdgeReconciliationTrigger;
  }): Promise<void> {
    await this.serialize(input);
  }

  async reconcileNow(input: {
    readonly tenantId: string;
    readonly edgeNodeId: string;
    readonly trigger: EdgeReconciliationTrigger;
  }): Promise<EdgeDesiredAssignmentSnapshot | undefined> {
    return this.serialize(input);
  }

  async reconcileAll(
    trigger: EdgeReconciliationTrigger = "application-start",
    tenantId = "default",
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.options.deviceRegistry.list(tenantId, { limit: 100, ...(cursor ? { cursor } : {}) });
      await Promise.all(page.items.map((device) => this.enqueue({
        tenantId: device.tenantId,
        edgeNodeId: device.edgeNodeId,
        trigger,
      })));
      cursor = page.nextCursor;
    } while (cursor);
  }

  withheld(tenantId: string, edgeNodeId: string): readonly EdgeDeploymentCatalogDiagnostic[] {
    return this.diagnostics.get(key(tenantId, edgeNodeId)) ?? [];
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }

  private serialize(input: {
    readonly tenantId: string;
    readonly edgeNodeId: string;
    readonly trigger: EdgeReconciliationTrigger;
  }): Promise<EdgeDesiredAssignmentSnapshot | undefined> {
    if (!this.accepting && input.trigger !== "revocation") {
      return Promise.reject(edgeError("EDGE_UNAVAILABLE", "Edge reconciliation is shutting down."));
    }
    const storageKey = key(input.tenantId, input.edgeNodeId);
    const previous = this.queues.get(storageKey) ?? Promise.resolve(undefined);
    const current = previous.catch(() => undefined).then(() => this.reconcile(input));
    this.queues.set(storageKey, current);
    void current.finally(() => {
      if (this.queues.get(storageKey) === current) this.queues.delete(storageKey);
    });
    return current;
  }

  private async reconcile(input: {
    readonly tenantId: string;
    readonly edgeNodeId: string;
    readonly trigger: EdgeReconciliationTrigger;
  }): Promise<EdgeDesiredAssignmentSnapshot | undefined> {
    const device = await this.options.deviceRegistry.get(input.tenantId, input.edgeNodeId);
    if (!device || device.revoked) {
      await this.options.assignmentStore.remove(input.tenantId, input.edgeNodeId);
      this.diagnostics.delete(key(input.tenantId, input.edgeNodeId));
      return undefined;
    }
    const tenantDevices = (await this.options.deviceRegistry.list(input.tenantId, { limit: 100 })).items;
    const eligibility = await deriveEligibleEdgeDeployments({
      device,
      catalog: this.options.catalog,
      groupIds: device.subjectId ? this.options.groupsForSubject?.(device.subjectId) ?? [] : [],
      tenantDevices,
      assignmentResolver: this.options.assignmentResolver,
    });
    this.diagnostics.set(key(input.tenantId, input.edgeNodeId), eligibility.withheld);
    const digest = stableDigest(eligibility.deployments);
    const publishPersistedAssignment = async (snapshot: EdgeDesiredAssignmentSnapshot) => {
      const desired = await this.options.desiredStateStore.get(input.tenantId, input.edgeNodeId);
      if (
        !desired
        || desired.connectionGeneration !== device.connectionGeneration
        || desired.desiredVersion !== snapshot.version
        || stableDigest(desired.deployments) !== digest
      ) {
        await this.options.publish(desiredState(input, device, snapshot.version, eligibility.deployments));
      }
    };
    let current = await this.options.assignmentStore.get(input.tenantId, input.edgeNodeId);
    if (current?.digest === digest) {
      await publishPersistedAssignment(current);
      return current;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const version = (current?.version ?? 0) + 1;
      const snapshot: EdgeDesiredAssignmentSnapshot = Object.freeze({
        tenantId: input.tenantId,
        edgeNodeId: input.edgeNodeId,
        version,
        digest,
        deploymentIds: Object.freeze(eligibility.deployments.map((deployment) => deployment.deploymentId)),
        updatedAt: this.now(),
      });
      const result = await this.options.assignmentStore.compareAndSwap(snapshot, current?.version);
      if (result === "conflict") {
        current = await this.options.assignmentStore.get(input.tenantId, input.edgeNodeId);
        if (current?.digest === digest) {
          await publishPersistedAssignment(current);
          return current;
        }
        continue;
      }
      const state = desiredState(input, device, version, eligibility.deployments);
      await this.options.publish(state);
      await this.options.telemetry?.emit({
        name: "edge.desired.reconciled",
        tenantId: input.tenantId,
        edgeNodeId: input.edgeNodeId,
        connectionGeneration: device.connectionGeneration,
        outcome: result,
        metadata: {
          trigger: input.trigger,
          desiredVersion: version,
          deploymentCount: eligibility.deployments.length,
          withheldCount: eligibility.withheld.length,
        },
      });
      return snapshot;
    }
    throw edgeError("EDGE_CAPACITY", "Desired-state reconciliation conflicted repeatedly.");
  }
}

function desiredState(
  input: { readonly tenantId: string; readonly edgeNodeId: string },
  device: EdgeDeviceRecord,
  desiredVersion: number,
  deployments: readonly EdgeDesiredDeployment[],
): EdgeDesiredStateMessage {
  return Object.freeze({
    version: EDGE_PROTOCOL_VERSION,
    kind: "edge.desired-state",
    tenantId: input.tenantId,
    edgeNodeId: input.edgeNodeId,
    connectionGeneration: device.connectionGeneration,
    desiredVersion,
    deployments,
  });
}

export class LocalEdgeDesiredAssignmentStore implements EdgeDesiredAssignmentStore {
  constructor(private readonly store: {
    snapshot(): { readonly desiredAssignments: readonly EdgeDesiredAssignmentSnapshot[] };
    putDesiredAssignment(snapshot: EdgeDesiredAssignmentSnapshot, expectedVersion: number | undefined): Promise<"updated" | "unchanged" | "conflict">;
    removeDesiredAssignment(tenantId: string, edgeNodeId: string): Promise<void>;
  }) {}

  async get(tenantId: string, edgeNodeId: string): Promise<EdgeDesiredAssignmentSnapshot | undefined> {
    return this.store.snapshot().desiredAssignments.find((entry) => entry.tenantId === tenantId && entry.edgeNodeId === edgeNodeId);
  }

  compareAndSwap(snapshot: EdgeDesiredAssignmentSnapshot, expectedVersion: number | undefined) {
    return this.store.putDesiredAssignment(snapshot, expectedVersion);
  }

  remove(tenantId: string, edgeNodeId: string): Promise<void> {
    return this.store.removeDesiredAssignment(tenantId, edgeNodeId);
  }
}

/** Device resolver backed by authenticated inventory, presence and desired state. @pk */
export class IntegratedEdgeDeviceResolver implements DeviceResolver {
  constructor(private readonly options: {
    readonly devices: EdgeDeviceRegistry;
    readonly presence: EdgePresenceStore;
    readonly readiness: EdgeReadinessStore;
    readonly desired: EdgeDesiredStateStore;
  }) {}

  resolveSessionDevice(context: DeviceResolverContext): Promise<DeviceResolution | null> {
    return context.requestedDeviceId
      ? this.resolveNamedAlias(context.requestedDeviceId, context)
      : this.resolveUserDefaultDevice(context);
  }

  async resolveUserDefaultDevice(context: DeviceResolverContext): Promise<DeviceResolution | null> {
    const candidates = await this.candidates(context);
    return candidates.length === 1 ? candidates[0] : null;
  }

  async resolveNamedAlias(alias: string, context: DeviceResolverContext): Promise<DeviceResolution | null> {
    const device = await this.options.devices.getByName(context.tenantId ?? "default", alias);
    if (!device || !this.subjectAllowed(device, context) || !await this.dispatchable(device, context)) return null;
    return this.resolution(device);
  }

  async resolvePool(pool: string, strategy: EdgeExecutionTarget["strategy"], context: DeviceResolverContext): Promise<DeviceResolution | null> {
    const page = await this.options.devices.list(context.tenantId ?? "default", { pool, limit: 100 });
    const eligible: Array<{ device: EdgeInventoryListItem; load: number }> = [];
    for (const device of page.items) {
      if (!this.subjectAllowed(device, context) || !await this.dispatchable(device, context)) continue;
      const presence = await this.options.presence.get(device.tenantId, device.edgeNodeId);
      eligible.push({ device, load: presence?.load?.utilization ?? presence?.load?.active ?? 0 });
    }
    if (eligible.length === 0) return null;
    eligible.sort((left, right) => strategy === "least-loaded"
      ? left.load - right.load || left.device.edgeNodeId.localeCompare(right.device.edgeNodeId)
      : left.device.edgeNodeId.localeCompare(right.device.edgeNodeId));
    return this.resolution(eligible[0].device);
  }

  private async candidates(context: DeviceResolverContext): Promise<DeviceResolution[]> {
    const page = await this.options.devices.list(context.tenantId ?? "default", { limit: 100 });
    const result: DeviceResolution[] = [];
    for (const device of page.items) {
      if (this.subjectAllowed(device, context) && await this.dispatchable(device, context)) result.push(this.resolution(device));
    }
    return result;
  }

  private subjectAllowed(device: EdgeDeviceRecord | EdgeInventoryListItem, context: DeviceResolverContext): boolean {
    return !device.revoked && (!context.subjectId || device.subjectId === context.subjectId);
  }

  private async dispatchable(device: EdgeDeviceRecord | EdgeInventoryListItem, context: DeviceResolverContext): Promise<boolean> {
    const presence = await this.options.presence.get(device.tenantId, device.edgeNodeId);
    if (!presence || presence.status !== "online" || !presence.heartbeat.fresh) return false;
    const desired = await this.options.desired.get(device.tenantId, device.edgeNodeId);
    if (!desired || desired.deployments.length === 0) return false;
    const deploymentId = context.declarativeSelection?.requires?.deploymentId;
    if (deploymentId) {
      const deployment = desired.deployments.find((candidate) => candidate.deploymentId === deploymentId);
      if (!deployment) return false;
      const readiness = await this.options.readiness.get(device.tenantId, device.edgeNodeId, deploymentId);
      return readiness?.status === "ready" && readiness.connectionGeneration === presence.connectionGeneration;
    }
    // Without a required deploymentId, still require at least one ready deployment.
    for (const deployment of desired.deployments) {
      const readiness = await this.options.readiness.get(device.tenantId, device.edgeNodeId, deployment.deploymentId);
      if (readiness?.status === "ready" && readiness.connectionGeneration === presence.connectionGeneration) {
        return true;
      }
    }
    return false;
  }

  private resolution(device: EdgeDeviceRecord | EdgeInventoryListItem): DeviceResolution {
    return {
      edgeNodeId: device.edgeNodeId,
      alias: device.user?.name,
      connectionGeneration: device.connectionGeneration,
    };
  }
}

function subjectMatches(entry: EdgeDeploymentCatalogEntry, subjectId: string | undefined, groupIds: readonly string[]): boolean {
  if (entry.scope === "global") return Boolean(subjectId);
  if (entry.scope === "user") return Boolean(subjectId && entry.userId === subjectId);
  return Boolean(entry.groupId && groupIds.includes(entry.groupId));
}

function selectorMatches(selector: DeviceSelector, device: EdgeDeviceRecord, tenantDevices: readonly EdgeInventoryListItem[]): boolean {
  switch (selector.type) {
    case "named":
      return Boolean(selector.alias && (device.user?.name === selector.alias
        || device.managed?.aliases.some((alias) => alias.name === selector.alias)));
    case "pool":
      return Boolean(selector.pool && device.managed?.pools.includes(selector.pool));
    case "user-default":
    case "session": {
      const owned = tenantDevices.filter((candidate) => !candidate.revoked && candidate.subjectId === device.subjectId);
      return owned.length === 1 && owned[0].edgeNodeId === device.edgeNodeId;
    }
    case "fallback":
      return selector.selectors?.some((child) => selectorMatches(child, device, tenantDevices)) ?? false;
    default:
      return false;
  }
}

function compareBindings(left: PlacementBindingModel, right: PlacementBindingModel): number {
  return left.serverName.localeCompare(right.serverName)
    || left.scope.localeCompare(right.scope)
    || (left.userId ?? left.groupId ?? "").localeCompare(right.userId ?? right.groupId ?? "")
    || left.targetName.localeCompare(right.targetName);
}

function cloneSelector(selector: DeviceSelector): DeviceSelector {
  return Object.freeze({
    ...selector,
    ...(selector.selectors ? { selectors: Object.freeze(selector.selectors.map(cloneSelector)) } : {}),
  });
}

function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, nested]) => `${JSON.stringify(name)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function key(tenantId: string, edgeNodeId: string): string {
  return `${tenantId}\u0000${edgeNodeId}`;
}
