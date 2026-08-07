/** Policy-filtered Edge inventory discovery and declarative selection. @pk */

import type { EdgeCapabilityManifestStore, EdgeDeviceRegistry, EdgeInventoryListItem } from "./controlPlane.js";
import { edgeError } from "./errors.js";
import type {
  EdgeCapacitySnapshot,
  EdgeDeploymentReadinessStatus,
  EdgeLoadSnapshot,
  EdgePresenceStatus,
  EdgePublicDeviceRef,
  EdgeReadinessStore,
  EdgePresenceStore,
} from "./inventory.js";
import type { InstallationDigest, InstallationLifecycleState, InstallationReasonCode } from "./installation.js";

/** Authenticated inventory-query context. @pk */
export interface EdgeInventoryContext {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly groups?: readonly string[];
}

/** Policy/grant seam evaluated before any device enters the visible set. @pk */
export interface EdgeInventoryAuthorizer {
  canAccessDevice(context: EdgeInventoryContext, device: EdgeInventoryListItem): boolean | Promise<boolean>;
  canAccessDeployment(
    context: EdgeInventoryContext,
    device: EdgeInventoryListItem,
    deploymentId: string,
  ): boolean | Promise<boolean>;
}

/** Policy-filtered readiness summary without local grant or path values. @pk */
export interface EdgePublicReadinessSummary {
  readonly deploymentId: string;
  readonly status: EdgeDeploymentReadinessStatus;
  readonly recipeVersion?: number;
  readonly observedAt: number;
  readonly fresh: boolean;
  readonly toolCount?: number;
  readonly resourceCount?: number;
  readonly reasonCategory?: string;
  readonly nextActions?: readonly string[];
  readonly desiredVersion?: number;
  readonly launchDigest?: string;
  readonly installation?: {
    readonly state: InstallationLifecycleState;
    readonly digest?: InstallationDigest;
    readonly retryable: boolean;
    readonly attemptId?: string;
    readonly reasonCode?: InstallationReasonCode;
  };
  readonly setup: { readonly state: "pending" | "ready" | "blocked" | "not-started" };
  readonly workload: { readonly state: "not-started" | "starting" | "ready" | "degraded" | "stopped" };
}

/** Agent-visible Edge inventory view. @pk */
export interface EdgePublicDeviceView {
  readonly device: EdgePublicDeviceRef;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly platform?: string;
  readonly architecture?: string;
  readonly agentVersion?: string;
  readonly executionFeatures: readonly string[];
  readonly pools: readonly string[];
  readonly status: EdgePresenceStatus;
  readonly heartbeatFresh: boolean;
  readonly lastHeartbeatAt?: number;
  readonly capacity?: EdgeCapacitySnapshot;
  readonly load?: EdgeLoadSnapshot;
  readonly readiness: readonly EdgePublicReadinessSummary[];
  readonly warnings: readonly string[];
}

/** Bounded filters applied only after device authorization. @pk */
export interface EdgeInventoryQuery {
  readonly name?: string;
  readonly tags?: readonly string[];
  readonly features?: readonly string[];
  readonly platforms?: readonly string[];
  readonly pool?: string;
  readonly statuses?: readonly EdgePresenceStatus[];
  readonly deploymentId?: string;
  readonly readiness?: readonly EdgeDeploymentReadinessStatus[];
  readonly limit?: number;
  readonly cursor?: string;
}

/** Cursor-paginated policy-filtered inventory response. @pk */
export interface EdgePublicInventoryPage {
  readonly devices: readonly EdgePublicDeviceView[];
  readonly nextCursor?: string;
  readonly warnings: readonly string[];
}

/** Hard constraints for declarative device selection. @pk */
export interface EdgeSelectionRequirements {
  readonly tags?: readonly string[];
  readonly features?: readonly string[];
  readonly platforms?: readonly string[];
  readonly pool?: string;
  readonly deploymentId?: string;
  readonly installationDigest?: InstallationDigest;
  readonly launchDigest?: string;
}

/** Ranked preference understood by the reference selector. @pk */
export type EdgeSelectionPreference = "lowest-load" | "highest-capacity" | "user-default" | "name";

/** Deterministic tie-breaking strategy. @pk */
export type EdgeSelectionStrategy = "least-loaded" | "highest-capacity" | "name";

/** Declarative selector evaluated against one bounded visible snapshot. @pk */
export interface EdgeSelectionRequest {
  readonly requires?: EdgeSelectionRequirements;
  readonly prefer?: readonly EdgeSelectionPreference[];
  readonly strategy?: EdgeSelectionStrategy;
  readonly userDefaultDeviceName?: string;
  readonly maxCandidates?: number;
}

/** Redacted selection explanation. @pk */
export interface EdgeSelectionExplanation {
  readonly satisfiedRequirements: readonly string[];
  readonly appliedPreferences: readonly EdgeSelectionPreference[];
  readonly strategy: EdgeSelectionStrategy;
  readonly evaluatedCandidates: number;
  readonly inventoryVersion: number;
  readonly evaluatedAt: number;
}

/** Selected public device plus a safe explanation. @pk */
export interface EdgeSelectionResult {
  readonly device: EdgePublicDeviceView;
  readonly explanation: EdgeSelectionExplanation;
}

/** Immutable bounded device set selected from one authorized inventory snapshot. @pk */
export interface EdgeSelectionSetResult {
  readonly devices: readonly EdgePublicDeviceView[];
  readonly explanation: EdgeSelectionExplanation;
}

/** Internal dispatch resolution returned only after current-state revalidation. @pk */
export interface EdgeDispatchDeviceResolution {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
  readonly inventoryVersion: number;
}

/** Inventory query service configuration. @pk */
export interface EdgeInventoryServiceOptions {
  readonly devices: EdgeDeviceRegistry;
  readonly presence: EdgePresenceStore;
  readonly readiness: EdgeReadinessStore;
  readonly capabilities?: EdgeCapabilityManifestStore;
  readonly authorizer: EdgeInventoryAuthorizer;
  readonly now?: () => number;
  readonly maxCandidates?: number;
}

/**
 * Composes durable identity/metadata with authorization, authenticated dynamic
 * state, readiness, and capability manifests before producing public views.
 * @pk
 */
export class EdgeInventoryService {
  private readonly now: () => number;
  private readonly maxCandidates: number;

  constructor(private readonly options: EdgeInventoryServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxCandidates = Math.max(1, Math.min(10_000, options.maxCandidates ?? 1_000));
  }

  async list(context: EdgeInventoryContext, query: EdgeInventoryQuery = {}): Promise<EdgePublicInventoryPage> {
    validateQuery(query);
    const visible = await this.visibleSnapshot(context);
    const filtered = visible.filter((device) => matchesQuery(device, query));
    const offset = decodePublicCursor(query.cursor);
    const limit = Math.max(1, Math.min(100, query.limit ?? 20));
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return Object.freeze({
      devices: Object.freeze(page),
      ...(nextOffset < filtered.length ? { nextCursor: encodePublicCursor(nextOffset) } : {}),
      warnings: Object.freeze([]),
    });
  }

  async get(context: EdgeInventoryContext, deviceName: string): Promise<EdgePublicDeviceView> {
    validateToken(deviceName, "deviceName", 80);
    const visible = await this.visibleSnapshot(context);
    const normalized = normalize(deviceName);
    const device = visible.find((candidate) => normalize(candidate.device.name) === normalized);
    if (!device) throw nonEnumeratingUnavailable();
    return device;
  }

  async select(context: EdgeInventoryContext, request: EdgeSelectionRequest): Promise<EdgeSelectionResult> {
    validateSelection(request);
    const limit = Math.min(this.maxCandidates, request.maxCandidates ?? this.maxCandidates);
    const snapshot = (await this.visibleSnapshot(context)).slice(0, limit);
    const eligible = snapshot.filter((device) => matchesRequirements(device, request.requires));
    if (eligible.length === 0) {
      throw edgeError("EDGE_UNAVAILABLE", "No eligible Edge device satisfies the requested requirements.", {
        details: {
          unmetRequirementCategories: requirementCategories(request.requires),
          nextActions: ["Relax a hard requirement or complete setup on an authorized device."],
        },
      });
    }
    const preferences = request.prefer ?? [];
    const strategy = request.strategy ?? "name";
    const ranked = [...eligible].sort((left, right) => compareDevices(
      left,
      right,
      preferences,
      strategy,
      request.userDefaultDeviceName,
    ));
    const selected = ranked[0]!;
    return Object.freeze({
      device: selected,
      explanation: Object.freeze({
        satisfiedRequirements: Object.freeze(requirementCategories(request.requires)),
        appliedPreferences: Object.freeze([...preferences]),
        strategy,
        evaluatedCandidates: snapshot.length,
        inventoryVersion: selected.device.inventoryVersion,
        evaluatedAt: this.now(),
      }),
    });
  }

  /** Resolve all eligible candidates up to a caller-supplied hard result cap. @pk */
  async selectMany(
    context: EdgeInventoryContext,
    request: EdgeSelectionRequest,
    maxResults: number,
  ): Promise<EdgeSelectionSetResult> {
    validateSelection(request);
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw edgeError("EDGE_PROTOCOL", "Selection result limit must be between 1 and 100.");
    }
    const limit = Math.min(this.maxCandidates, request.maxCandidates ?? this.maxCandidates);
    const snapshot = (await this.visibleSnapshot(context)).slice(0, limit);
    const eligible = snapshot.filter((device) => matchesRequirements(device, request.requires));
    if (eligible.length === 0) {
      throw edgeError("EDGE_UNAVAILABLE", "No eligible Edge device satisfies the requested requirements.", {
        details: { unmetRequirementCategories: requirementCategories(request.requires) },
      });
    }
    if (eligible.length > maxResults) {
      throw edgeError("EDGE_CAPACITY", "Declarative selection exceeds the effective device limit.", {
        details: { limit: maxResults, nextActions: ["Narrow the selector or request a smaller authorized subset."] },
      });
    }
    const preferences = request.prefer ?? [];
    const strategy = request.strategy ?? "name";
    const ranked = [...eligible].sort((left, right) => compareDevices(left, right, preferences, strategy, request.userDefaultDeviceName));
    return Object.freeze({
      devices: Object.freeze(ranked),
      explanation: Object.freeze({
        satisfiedRequirements: Object.freeze(requirementCategories(request.requires)),
        appliedPreferences: Object.freeze([...preferences]),
        strategy,
        evaluatedCandidates: snapshot.length,
        inventoryVersion: Math.max(...ranked.map((device) => device.device.inventoryVersion)),
        evaluatedAt: this.now(),
      }),
    });
  }

  async revalidateForDispatch(
    context: EdgeInventoryContext,
    deviceRef: EdgePublicDeviceRef,
    deploymentId?: string,
  ): Promise<EdgeDispatchDeviceResolution> {
    const record = await this.options.devices.getByName(context.tenantId, deviceRef.name, this.now());
    if (!record || record.revoked) throw nonEnumeratingUnavailable();
    const safeRecord = await this.safeRecord(context.tenantId, record.edgeNodeId);
    if (!safeRecord || !await this.options.authorizer.canAccessDevice(context, safeRecord)) {
      throw nonEnumeratingUnavailable();
    }
    if ((record.inventoryVersion ?? 1) !== deviceRef.inventoryVersion) {
      throw edgeError("EDGE_INVENTORY_CONFLICT", "Edge inventory changed; discover the device again.");
    }
    const presence = await this.options.presence.get(context.tenantId, record.edgeNodeId);
    if (!presence || presence.status !== "online" || !presence.heartbeat.fresh || (presence.capacity?.available ?? 1) < 1) {
      throw edgeError("EDGE_UNAVAILABLE", "Edge device is unavailable for dispatch.");
    }
    if (deploymentId !== undefined) {
      if (!await this.options.authorizer.canAccessDeployment(context, safeRecord, deploymentId)) {
        throw nonEnumeratingUnavailable();
      }
      const readiness = await this.options.readiness.get(context.tenantId, record.edgeNodeId, deploymentId);
      if (!readiness || readiness.status !== "ready" || (readiness.expiresAt !== undefined && readiness.expiresAt <= this.now())) {
        throw edgeError("EDGE_SETUP_REQUIRED", "Edge deployment is not currently ready.");
      }
    }
    return Object.freeze({
      tenantId: context.tenantId,
      edgeNodeId: record.edgeNodeId,
      connectionGeneration: presence.connectionGeneration,
      inventoryVersion: record.inventoryVersion ?? 1,
    });
  }

  private async visibleSnapshot(context: EdgeInventoryContext): Promise<readonly EdgePublicDeviceView[]> {
    await this.options.presence.purgeStale(this.now());
    await this.options.readiness.purgeExpired(this.now());
    const records = await this.allTenantRecords(context.tenantId);
    const views: EdgePublicDeviceView[] = [];
    for (const record of records) {
      if (record.revoked || !await this.options.authorizer.canAccessDevice(context, record)) continue;
      views.push(await this.composeView(context, record));
    }
    return Object.freeze(views.sort((left, right) => normalize(left.device.name).localeCompare(normalize(right.device.name))));
  }

  private async allTenantRecords(tenantId: string): Promise<readonly EdgeInventoryListItem[]> {
    const records: EdgeInventoryListItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.devices.list(tenantId, { limit: 100, ...(cursor ? { cursor } : {}) });
      records.push(...page.items.slice(0, this.maxCandidates - records.length));
      cursor = records.length >= this.maxCandidates ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return records;
  }

  private async safeRecord(tenantId: string, edgeNodeId: string): Promise<EdgeInventoryListItem | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.options.devices.list(tenantId, { limit: 100, ...(cursor ? { cursor } : {}) });
      const match = page.items.find((record) => record.edgeNodeId === edgeNodeId);
      if (match) return match;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
  }

  private async composeView(
    context: EdgeInventoryContext,
    record: EdgeInventoryListItem,
  ): Promise<EdgePublicDeviceView> {
    const presence = await this.options.presence.get(context.tenantId, record.edgeNodeId);
    const readinessValues = await this.options.readiness.list(context.tenantId, record.edgeNodeId);
    const readiness: EdgePublicReadinessSummary[] = [];
    for (const value of readinessValues) {
      if (!await this.options.authorizer.canAccessDeployment(context, record, value.deploymentId)) continue;
      const manifest = await this.options.capabilities?.get(context.tenantId, record.edgeNodeId, value.deploymentId);
      readiness.push(Object.freeze({
        deploymentId: value.deploymentId,
        status: value.status,
        ...(value.recipeVersion === undefined ? {} : { recipeVersion: value.recipeVersion }),
        observedAt: value.observedAt,
        fresh: value.expiresAt === undefined || value.expiresAt > this.now(),
        ...(manifest ? { toolCount: manifest.tools.length, resourceCount: manifest.resources.length } : {}),
        ...(value.reasonCategory ? { reasonCategory: value.reasonCategory } : {}),
        ...(value.nextActions ? { nextActions: value.nextActions } : {}),
        ...(value.desiredVersion === undefined ? {} : { desiredVersion: value.desiredVersion }),
        ...(value.launchDigest === undefined ? {} : { launchDigest: value.launchDigest }),
        ...(value.installationState === undefined ? {} : {
          installation: Object.freeze({
            state: value.installationState,
            ...(value.installationDigest ? { digest: value.installationDigest } : {}),
            retryable: value.retryable ?? false,
            ...(value.attemptId ? { attemptId: value.attemptId } : {}),
            ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}),
          }),
        }),
        setup: Object.freeze({ state: setupState(value.status, value.installationState) }),
        workload: Object.freeze({ state: workloadState(value.status, value.installationState) }),
      }));
    }
    const status: EdgePresenceStatus = presence?.status ?? "offline";
    return Object.freeze({
      device: Object.freeze({ name: record.user.name, inventoryVersion: record.inventoryVersion }),
      ...(record.user.description ? { description: record.user.description } : {}),
      tags: Object.freeze([...record.user.tags]),
      ...(record.observed?.platform ? { platform: record.observed.platform } : {}),
      ...(record.observed?.architecture ? { architecture: record.observed.architecture } : {}),
      ...(record.observed?.agentVersion ? { agentVersion: record.observed.agentVersion } : {}),
      executionFeatures: Object.freeze([...(record.observed?.executionFeatures ?? [])]),
      pools: Object.freeze([...record.managed.pools]),
      status,
      heartbeatFresh: presence?.heartbeat.fresh ?? false,
      ...(presence ? { lastHeartbeatAt: presence.heartbeat.lastHeartbeatAt } : {}),
      ...(presence?.capacity ? { capacity: presence.capacity } : {}),
      ...(presence?.load ? { load: presence.load } : {}),
      readiness: Object.freeze(readiness.sort((left, right) => left.deploymentId.localeCompare(right.deploymentId))),
      warnings: Object.freeze(status === "stale" ? ["Device heartbeat is stale."] : []),
    });
  }
}

function validateQuery(query: EdgeInventoryQuery): void {
  if (query.name !== undefined) validateToken(query.name, "name", 80);
  validateTokens(query.tags, "tags", 32, 80);
  validateTokens(query.features, "features", 32, 80);
  validateTokens(query.platforms, "platforms", 16, 64);
  if (query.pool !== undefined) validateToken(query.pool, "pool", 80);
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw edgeError("EDGE_PROTOCOL", "Inventory limit must be between 1 and 100.");
  }
}

function validateSelection(request: EdgeSelectionRequest): void {
  validateTokens(request.requires?.tags, "requires.tags", 32, 80);
  validateTokens(request.requires?.features, "requires.features", 32, 80);
  validateTokens(request.requires?.platforms, "requires.platforms", 16, 64);
  if (request.prefer && request.prefer.length > 8) throw edgeError("EDGE_PROTOCOL", "Too many selection preferences.");
  if (request.maxCandidates !== undefined && (!Number.isSafeInteger(request.maxCandidates) || request.maxCandidates < 1)) {
    throw edgeError("EDGE_PROTOCOL", "maxCandidates must be a positive integer.");
  }
}

function validateTokens(values: readonly string[] | undefined, field: string, maxItems: number, maxLength: number): void {
  if (values === undefined) return;
  if (values.length > maxItems) throw edgeError("EDGE_PROTOCOL", `${field} contains too many values.`);
  for (const value of values) validateToken(value, field, maxLength);
}

function validateToken(value: string, field: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw edgeError("EDGE_PROTOCOL", `${field} is invalid.`);
  }
}

function matchesQuery(device: EdgePublicDeviceView, query: EdgeInventoryQuery): boolean {
  return (query.name === undefined || normalize(device.device.name).includes(normalize(query.name)))
    && (query.tags === undefined || query.tags.every((tag) => device.tags.includes(tag)))
    && (query.features === undefined || query.features.every((feature) => device.executionFeatures.includes(feature)))
    && (query.platforms === undefined || (device.platform !== undefined && query.platforms.includes(device.platform)))
    && (query.pool === undefined || device.pools.includes(query.pool))
    && (query.statuses === undefined || query.statuses.includes(device.status))
    && ((query.deploymentId === undefined && query.readiness === undefined) || device.readiness.some((value) =>
      (query.deploymentId === undefined || value.deploymentId === query.deploymentId)
      && (query.readiness === undefined || query.readiness.includes(value.status))));
}

function matchesRequirements(device: EdgePublicDeviceView, requirements: EdgeSelectionRequirements | undefined): boolean {
  if (device.status !== "online" || !device.heartbeatFresh || (device.capacity?.available ?? 1) < 1) return false;
  if (!requirements) return true;
  return (requirements.tags === undefined || requirements.tags.every((tag) => device.tags.includes(tag)))
    && (requirements.features === undefined || requirements.features.every((feature) => device.executionFeatures.includes(feature)))
    && (requirements.platforms === undefined || (device.platform !== undefined && requirements.platforms.includes(device.platform)))
    && (requirements.pool === undefined || device.pools.includes(requirements.pool))
    && (requirements.deploymentId === undefined || device.readiness.some((value) => value.deploymentId === requirements.deploymentId
      && value.status === "ready" && value.fresh
      && (requirements.installationDigest === undefined || value.installation?.digest === requirements.installationDigest)
      && (requirements.launchDigest === undefined || value.launchDigest === requirements.launchDigest)));
}

function setupState(status: EdgeDeploymentReadinessStatus, installation: InstallationLifecycleState | undefined): EdgePublicReadinessSummary["setup"]["state"] {
  if (installation && !["installed", "configuring", "starting", "ready", "degraded"].includes(installation)) return "not-started";
  if (status === "ready") return "ready";
  if (status === "setup-required") return "pending";
  return "blocked";
}

function workloadState(status: EdgeDeploymentReadinessStatus, installation: InstallationLifecycleState | undefined): EdgePublicReadinessSummary["workload"]["state"] {
  if (status === "ready") return "ready";
  if (installation === "starting") return "starting";
  if (installation === "degraded") return "degraded";
  if (status === "blocked" || status === "unavailable" || status === "stale") return "stopped";
  return "not-started";
}

function compareDevices(
  left: EdgePublicDeviceView,
  right: EdgePublicDeviceView,
  preferences: readonly EdgeSelectionPreference[],
  strategy: EdgeSelectionStrategy,
  userDefaultDeviceName: string | undefined,
): number {
  for (const preference of preferences) {
    const compared = comparePreference(left, right, preference, userDefaultDeviceName);
    if (compared !== 0) return compared;
  }
  const strategyResult = comparePreference(left, right, strategy, userDefaultDeviceName);
  if (strategyResult !== 0) return strategyResult;
  return normalize(left.device.name).localeCompare(normalize(right.device.name));
}

function comparePreference(
  left: EdgePublicDeviceView,
  right: EdgePublicDeviceView,
  preference: EdgeSelectionPreference | EdgeSelectionStrategy,
  userDefaultDeviceName: string | undefined,
): number {
  switch (preference) {
    case "lowest-load":
    case "least-loaded":
      return loadScore(left) - loadScore(right);
    case "highest-capacity":
      return (right.capacity?.available ?? 0) - (left.capacity?.available ?? 0);
    case "user-default":
      return Number(normalize(right.device.name) === normalize(userDefaultDeviceName ?? ""))
        - Number(normalize(left.device.name) === normalize(userDefaultDeviceName ?? ""));
    case "name":
      return normalize(left.device.name).localeCompare(normalize(right.device.name));
  }
}

function loadScore(device: EdgePublicDeviceView): number {
  return device.load?.utilization ?? (device.load ? device.load.active + device.load.queued : Number.POSITIVE_INFINITY);
}

function requirementCategories(requirements: EdgeSelectionRequirements | undefined): string[] {
  if (!requirements) return [];
  return (["tags", "features", "platforms", "pool", "deploymentId"] as const)
    .filter((key) => requirements[key] !== undefined);
}

function encodePublicCursor(offset: number): string {
  return Buffer.from(`edge-inventory:${offset}`, "utf8").toString("base64url");
}

function decodePublicCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw edgeError("EDGE_PROTOCOL", "Inventory cursor is invalid.");
  }
  const match = /^edge-inventory:(\d+)$/.exec(decoded);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset)) throw edgeError("EDGE_PROTOCOL", "Inventory cursor is invalid.");
  return offset;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function nonEnumeratingUnavailable(): Error {
  return edgeError("EDGE_UNAUTHORIZED_TARGET", "Edge device is unavailable or unauthorized.");
}
