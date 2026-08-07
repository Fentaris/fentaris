/**
 * Serializable managed Edge installation contracts.
 *
 * Recipes describe immutable input, bounded execution, declared outputs, and
 * verification. They intentionally contain no resolved credential or local
 * host path; those values are supplied by protected Edge setup grants.
 * @pk
 */
import { createHash } from "node:crypto";
import { edgeError } from "./errors.js";

/** Installation recipe serialization format version. @pk */
export const INSTALLATION_RECIPE_VERSION = 1 as const;

export type InstallationDigest = `sha256:${string}`;
export type InstallationProviderKind = "node-package" | "python" | "binary" | "container" | "manual" | "custom";
export type InstallationOutputKind = "executable" | "file" | "directory";
export type InstallationNetworkMode = "none" | "source-only" | "restricted";
export type InstallationLifecycleState =
  | "assigned" | "checking" | "approval-required" | "installing" | "installed"
  | "configuring" | "starting" | "ready" | "degraded" | "failed" | "blocked"
  | "removing" | "removed";
export type InstallationReasonCode =
  | "approval-required" | "approval-denied" | "approval-revoked"
  | "agent-upgrade-required" | "unsupported-platform" | "manual-prerequisite-required"
  | "source-integrity-failed" | "source-unavailable" | "source-credential-required"
  | "isolation-unavailable" | "elevation-denied" | "limit-exceeded"
  | "verification-failed" | "installation-failed" | "attempt-interrupted"
  | "stale-message" | "artifact-missing" | "artifact-escape" | "cleanup-approval-required";

export interface GitInstallationSource {
  readonly kind: "git";
  readonly repository: string;
  readonly commit: string;
  readonly submodules?: Readonly<Record<string, InstallationDigest>>;
  readonly credentialRef?: string;
}

export interface ArchiveInstallationSource {
  readonly kind: "archive";
  readonly url: string;
  readonly integrity: InstallationDigest;
  readonly credentialRef?: string;
  readonly maxBytes?: number;
}

export interface InlineInstallationSource {
  readonly kind: "inline";
  readonly content: string;
  readonly filename?: string;
}

export interface LocalInstallationSource {
  readonly kind: "local";
  readonly grantRef: string;
  readonly integrity: InstallationDigest;
}

export interface EnterpriseInstallationSource {
  readonly kind: "enterprise";
  readonly adapter: string;
  readonly artifactRef: string;
  readonly integrity: InstallationDigest;
  readonly credentialRef?: string;
}

export type InstallationSource = GitInstallationSource | ArchiveInstallationSource | InlineInstallationSource
  | LocalInstallationSource | EnterpriseInstallationSource;

export interface NodePackageInstallationProvider {
  readonly kind: "node-package";
  readonly package: string;
  readonly version: string;
  readonly integrity: InstallationDigest;
  readonly allowLifecycleScripts?: boolean;
}

export interface PythonInstallationProvider {
  readonly kind: "python";
  readonly package: string;
  readonly version: string;
  readonly hashes: readonly InstallationDigest[];
  readonly python?: string;
}

export interface BinaryInstallationProvider {
  readonly kind: "binary";
  readonly source: ArchiveInstallationSource;
}

export interface ContainerInstallationProvider {
  readonly kind: "container";
  readonly image: string;
  readonly digest: `sha256:${string}`;
  readonly runtime?: "docker" | "podman";
}

export interface ManualInstallationProvider {
  readonly kind: "manual";
  readonly requirement: string;
  readonly detect: InstallationVerification;
  readonly nextAction: string;
}

export interface CustomInstallationProvider {
  readonly kind: "custom";
  readonly source: InstallationSource;
  readonly entrypoint: string;
  readonly interpreter: "sh" | "bash" | "node" | "python" | "powershell" | "executable";
  readonly args?: readonly string[];
}

export type InstallationProvider = NodePackageInstallationProvider | PythonInstallationProvider
  | BinaryInstallationProvider | ContainerInstallationProvider | ManualInstallationProvider
  | CustomInstallationProvider;

export interface InstallationFilesystemPermission {
  readonly grantRef: string;
  readonly access: "read" | "read-write";
}

export interface InstallationLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxDiskBytes: number;
  readonly maxProcesses: number;
}

export interface InstallationPermissions {
  readonly network: InstallationNetworkMode;
  readonly networkHosts?: readonly string[];
  readonly filesystem?: readonly InstallationFilesystemPermission[];
  readonly executables?: readonly string[];
  readonly environment?: readonly string[];
  readonly elevation: false;
  readonly requireFilesystemIsolation?: boolean;
  readonly requireNetworkIsolation?: boolean;
  readonly limits: InstallationLimits;
}

export interface InstallationVerification {
  readonly kind: "command" | "file" | "executable" | "container-image";
  readonly target: string;
  readonly args?: readonly string[];
  readonly expectedVersion?: string;
  readonly expectedDigest?: InstallationDigest;
}

export interface InstallationOutput {
  readonly name: string;
  readonly kind: InstallationOutputKind;
  readonly path: string;
}

export interface InstallationRetention {
  readonly previousVersions: number;
  readonly maxAgeMs?: number;
}

export interface InstallationCleanup {
  readonly kind: "managed-directory" | "custom" | "manual";
  readonly entrypoint?: string;
  readonly interpreter?: CustomInstallationProvider["interpreter"];
  readonly args?: readonly string[];
  readonly externalSideEffects?: boolean;
}

export interface InstallationPlatformConstraint {
  readonly platforms?: readonly NodeJS.Platform[];
  readonly architectures?: readonly string[];
  readonly runtimes?: Readonly<Record<string, string>>;
}

/** Complete versioned installation recipe. @pk */
export interface InstallationRecipe {
  readonly version: typeof INSTALLATION_RECIPE_VERSION;
  readonly provider: InstallationProvider;
  readonly permissions: InstallationPermissions;
  readonly verification: readonly InstallationVerification[];
  readonly outputs: readonly InstallationOutput[];
  readonly retention: InstallationRetention;
  readonly cleanup: InstallationCleanup;
  readonly platforms?: InstallationPlatformConstraint;
  readonly digest: InstallationDigest;
}

export type InstallationRecipeInput = Omit<InstallationRecipe, "version" | "digest">;

export interface InstalledArtifactReference {
  readonly __fentarisInstalledArtifact: true;
  readonly installationDigest: InstallationDigest;
  readonly output: string;
  readonly kind: InstallationOutputKind;
}

export interface InstallationAttemptSummary {
  readonly attemptId: string;
  readonly recipeDigest: InstallationDigest;
  readonly state: InstallationLifecycleState;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly reasonCode?: InstallationReasonCode;
  readonly retryable: boolean;
}

export interface InstallationLifecycleSummary {
  readonly deploymentId: string;
  readonly desiredVersion: number;
  readonly recipeDigest: InstallationDigest;
  readonly launchDigest: string;
  readonly state: InstallationLifecycleState;
  readonly readiness: "ready" | "setup-required" | "blocked" | "unavailable";
  readonly observedAt: number;
  readonly attempt?: InstallationAttemptSummary;
  readonly reasonCode?: InstallationReasonCode;
  readonly nextAction?: string;
}

export interface InstallationArtifactRecord {
  readonly recipeDigest: InstallationDigest;
  readonly root: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly verifiedAt: number;
  readonly active: boolean;
  readonly references: number;
  readonly externalSideEffects?: boolean;
}

export interface InstallationApprovalRecord {
  readonly approvalDigest: InstallationDigest;
  readonly recipeDigest: InstallationDigest;
  readonly decision: "approved" | "denied" | "revoked";
  readonly decidedAt: number;
  readonly cleanup?: boolean;
}

export interface InstallationProviderContext {
  readonly recipe: InstallationRecipe;
  readonly attemptId: string;
  readonly stagingRoot: string;
  readonly installationRoot: string;
}

export interface InstallationProviderAdapter {
  readonly kind: InstallationProviderKind;
  preflight(context: InstallationProviderContext): Promise<{ ready: boolean; reasonCode?: InstallationReasonCode }>;
  install(context: InstallationProviderContext): Promise<void>;
  verify(context: InstallationProviderContext): Promise<Readonly<Record<string, string>>>;
  cleanup(context: InstallationProviderContext): Promise<void>;
}

export interface InstallationResolvedSource {
  readonly root: string;
  readonly digest: InstallationDigest;
}

export interface InstallationSourceResolver {
  readonly kind: InstallationSource["kind"];
  resolve(source: InstallationSource, destination: string, credentials?: Readonly<Record<string, string>>): Promise<InstallationResolvedSource>;
}

export interface InstallationAttemptStore {
  get(attemptId: string): Promise<InstallationAttemptSummary | undefined>;
  list(recipeDigest: InstallationDigest): Promise<readonly InstallationAttemptSummary[]>;
  put(attempt: InstallationAttemptSummary): Promise<void>;
}

export interface InstallationApprovalStore {
  get(approvalDigest: InstallationDigest, cleanup?: boolean): Promise<InstallationApprovalRecord | undefined>;
  put(approval: InstallationApprovalRecord): Promise<void>;
}

export interface InstallationLifecycleStore {
  get(deploymentId: string): Promise<InstallationLifecycleSummary | undefined>;
  list(): Promise<readonly InstallationLifecycleSummary[]>;
  put(lifecycle: InstallationLifecycleSummary): Promise<void>;
}

export interface InstallationArtifactStore {
  get(recipeDigest: InstallationDigest): Promise<InstallationArtifactRecord | undefined>;
  list(): Promise<readonly InstallationArtifactRecord[]>;
  put(artifact: InstallationArtifactRecord): Promise<void>;
  delete(recipeDigest: InstallationDigest): Promise<void>;
}

export interface InstallationMutationLock {
  runExclusive<T>(installationRoot: string, operation: () => Promise<T>): Promise<T>;
}

/** Canonical JSON serialization used for digest and approval identity. @pk */
export function canonicalizeInstallationValue(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Compute a stable SHA-256 installation digest. @pk */
export function computeInstallationDigest(value: unknown): InstallationDigest {
  return `sha256:${createHash("sha256").update(canonicalizeInstallationValue(value)).digest("hex")}`;
}

/** Compile and strictly validate an installation recipe. @pk */
export function compileInstallationRecipe(input: InstallationRecipeInput): InstallationRecipe {
  const payload = { version: INSTALLATION_RECIPE_VERSION, ...input };
  return validateInstallationRecipe({ ...payload, digest: computeInstallationDigest(payload) });
}

export function serializeInstallationRecipe(recipe: InstallationRecipe): string {
  const validated = validateInstallationRecipe(recipe);
  return canonicalizeInstallationValue(validated);
}

export function parseInstallationRecipe(data: string): InstallationRecipe {
  let value: unknown;
  try { value = JSON.parse(data); } catch { throw edgeError("EDGE_PROTOCOL", "malformed installation recipe payload"); }
  return validateInstallationRecipe(value);
}

/** Strictly validate immutable sources, bounded permissions, outputs, and digest. @pk */
export function validateInstallationRecipe(value: unknown): InstallationRecipe {
  if (!isRecord(value)) throw edgeError("EDGE_PROTOCOL", "installation recipe payload is not an object");
  if (value.version !== INSTALLATION_RECIPE_VERSION) throw edgeError("EDGE_PROTOCOL", `unsupported installation recipe version ${String(value.version)}`);
  validateProvider(value.provider);
  validatePermissions(value.permissions);
  if (!Array.isArray(value.verification) || value.verification.length === 0) fail("installation verification must not be empty");
  value.verification.forEach(validateVerification);
  if (!Array.isArray(value.outputs) || value.outputs.length === 0) fail("installation outputs must not be empty");
  const names = new Set<string>();
  for (const output of value.outputs) {
    if (!isRecord(output) || !validName(output.name) || !["executable", "file", "directory"].includes(String(output.kind))) fail("installation output is malformed");
    validateRelativePath(output.path, "installation output path");
    if (names.has(output.name as string)) fail(`duplicate installation output ${String(output.name)}`);
    names.add(output.name as string);
  }
  if (!isRecord(value.retention) || !boundedInteger(value.retention.previousVersions, 0, 10)) fail("installation retention is malformed");
  if (!isRecord(value.cleanup) || !["managed-directory", "custom", "manual"].includes(String(value.cleanup.kind))) fail("installation cleanup is malformed");
  if (value.cleanup.kind === "custom") {
    validateRelativePath(value.cleanup.entrypoint, "cleanup entrypoint");
    if (value.cleanup.externalSideEffects !== true) fail("custom cleanup must declare externalSideEffects");
  }
  if (value.platforms !== undefined && !isRecord(value.platforms)) fail("installation platforms are malformed");
  const payload = withoutDigest(value);
  const digest = computeInstallationDigest(payload);
  if (value.digest !== digest) fail("installation recipe digest mismatch");
  return deepFreeze(structuredClone({ ...payload, digest })) as InstallationRecipe;
}

/** Create a serializable reference to one declared installation output. @pk */
export function installedArtifact(recipe: InstallationRecipe, output: string): InstalledArtifactReference {
  const declaration = recipe.outputs.find((candidate) => candidate.name === output);
  if (!declaration) throw new TypeError(`installation output ${output} is not declared`);
  return Object.freeze({ __fentarisInstalledArtifact: true, installationDigest: recipe.digest, output, kind: declaration.kind });
}

export function isInstalledArtifactReference(value: unknown): value is InstalledArtifactReference {
  return isRecord(value) && value.__fentarisInstalledArtifact === true && typeof value.installationDigest === "string"
    && validName(value.output) && ["executable", "file", "directory"].includes(String(value.kind));
}

/** Normalize detailed installation state for compatible readiness clients. @pk */
export function normalizeInstallationReadiness(state: InstallationLifecycleState): InstallationLifecycleSummary["readiness"] {
  if (state === "ready") return "ready";
  if (["approval-required", "assigned", "checking", "installing", "installed", "configuring", "starting"].includes(state)) return "setup-required";
  if (["blocked", "failed", "degraded"].includes(state)) return "blocked";
  return "unavailable";
}

export function installationApprovalDigest(recipe: InstallationRecipe, localPolicy: unknown): InstallationDigest {
  return computeInstallationDigest({ recipe, localPolicy });
}

export interface InstallationBuilderDefaults {
  readonly permissions?: Partial<InstallationPermissions>;
  readonly verification: readonly InstallationVerification[];
  readonly outputs: readonly InstallationOutput[];
  readonly retention?: InstallationRetention;
  readonly cleanup?: InstallationCleanup;
  readonly platforms?: InstallationPlatformConstraint;
}

const DEFAULT_LIMITS: InstallationLimits = Object.freeze({ timeoutMs: 300_000, maxOutputBytes: 1_048_576, maxDiskBytes: 536_870_912, maxProcesses: 32 });

function build(provider: InstallationProvider, options: InstallationBuilderDefaults): InstallationRecipe {
  const permissions: InstallationPermissions = {
    network: options.permissions?.network ?? "source-only",
    elevation: false,
    limits: { ...DEFAULT_LIMITS, ...options.permissions?.limits },
    ...(options.permissions?.networkHosts ? { networkHosts: [...options.permissions.networkHosts] } : {}),
    ...(options.permissions?.filesystem ? { filesystem: [...options.permissions.filesystem] } : {}),
    ...(options.permissions?.executables ? { executables: [...options.permissions.executables] } : {}),
    ...(options.permissions?.environment ? { environment: [...options.permissions.environment] } : {}),
    ...(options.permissions?.requireFilesystemIsolation !== undefined ? { requireFilesystemIsolation: options.permissions.requireFilesystemIsolation } : {}),
    ...(options.permissions?.requireNetworkIsolation !== undefined ? { requireNetworkIsolation: options.permissions.requireNetworkIsolation } : {}),
  };
  return compileInstallationRecipe({
    provider,
    permissions,
    verification: options.verification,
    outputs: options.outputs,
    retention: options.retention ?? { previousVersions: 1 },
    cleanup: options.cleanup ?? { kind: "managed-directory" },
    ...(options.platforms ? { platforms: options.platforms } : {}),
  });
}

/** Public builders exposed as `edge.install.*`. @pk */
export const install = Object.freeze({
  nodePackage: (provider: Omit<NodePackageInstallationProvider, "kind">, options: InstallationBuilderDefaults) => build({ kind: "node-package", ...provider }, options),
  python: (provider: Omit<PythonInstallationProvider, "kind">, options: InstallationBuilderDefaults) => build({ kind: "python", ...provider }, options),
  binary: (provider: Omit<BinaryInstallationProvider, "kind">, options: InstallationBuilderDefaults) => build({ kind: "binary", ...provider }, options),
  container: (provider: Omit<ContainerInstallationProvider, "kind">, options: InstallationBuilderDefaults) => build({ kind: "container", ...provider }, options),
  manual: (provider: Omit<ManualInstallationProvider, "kind">, options: Omit<InstallationBuilderDefaults, "verification">) => build({ kind: "manual", ...provider }, { ...options, verification: [provider.detect] }),
  custom: (provider: Omit<CustomInstallationProvider, "kind">, options: InstallationBuilderDefaults) => build({ kind: "custom", ...provider }, options),
});

/** Deterministic single-process adapter implementations for tests and local use. @pk */
export class InMemoryInstallationAttemptStore implements InstallationAttemptStore {
  private readonly values = new Map<string, InstallationAttemptSummary>();
  async get(id: string) { return this.values.get(id); }
  async list(digest: InstallationDigest) { return [...this.values.values()].filter((value) => value.recipeDigest === digest).sort((a, b) => a.startedAt - b.startedAt); }
  async put(value: InstallationAttemptSummary) { this.values.set(value.attemptId, deepFreeze(structuredClone(value))); }
}

export class InMemoryInstallationApprovalStore implements InstallationApprovalStore {
  private readonly values = new Map<string, InstallationApprovalRecord>();
  async get(digest: InstallationDigest, cleanup = false) { return this.values.get(`${digest}:${cleanup}`); }
  async put(value: InstallationApprovalRecord) { this.values.set(`${value.approvalDigest}:${value.cleanup === true}`, deepFreeze(structuredClone(value))); }
}

export class InMemoryInstallationLifecycleStore implements InstallationLifecycleStore {
  private readonly values = new Map<string, InstallationLifecycleSummary>();
  async get(id: string) { return this.values.get(id); }
  async list() { return [...this.values.values()].sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)); }
  async put(value: InstallationLifecycleSummary) { this.values.set(value.deploymentId, deepFreeze(structuredClone(value))); }
}

export class InMemoryInstallationArtifactStore implements InstallationArtifactStore {
  private readonly values = new Map<InstallationDigest, InstallationArtifactRecord>();
  async get(digest: InstallationDigest) { return this.values.get(digest); }
  async list() { return [...this.values.values()].sort((a, b) => a.recipeDigest.localeCompare(b.recipeDigest)); }
  async put(value: InstallationArtifactRecord) { this.values.set(value.recipeDigest, deepFreeze(structuredClone(value))); }
  async delete(digest: InstallationDigest) { this.values.delete(digest); }
}

export class InMemoryInstallationMutationLock implements InstallationMutationLock {
  private readonly tails = new Map<string, Promise<void>>();
  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try { return await operation(); } finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}

export const IN_MEMORY_INSTALLATION_ADAPTER_WARNING = "In-memory installation adapters are single-process only and are not durable or distributed-ready.";

function validateProvider(value: unknown): void {
  if (!isRecord(value) || !["node-package", "python", "binary", "container", "manual", "custom"].includes(String(value.kind))) fail("installation provider is malformed");
  switch (value.kind) {
    case "node-package":
      requireText(value.package, "node package"); requireExactVersion(value.version); validateDigest(value.integrity); break;
    case "python":
      requireText(value.package, "python package"); requireExactVersion(value.version);
      if (!Array.isArray(value.hashes) || value.hashes.length === 0) fail("python provider requires hashes");
      value.hashes.forEach(validateDigest); break;
    case "binary": validateSource(value.source, "archive"); break;
    case "container": requireText(value.image, "container image"); validateDigest(value.digest); break;
    case "manual": requireText(value.requirement, "manual requirement"); requireText(value.nextAction, "manual next action"); validateVerification(value.detect); break;
    case "custom": validateSource(value.source); validateRelativePath(value.entrypoint, "custom entrypoint");
      if (!["sh", "bash", "node", "python", "powershell", "executable"].includes(String(value.interpreter))) fail("custom interpreter is invalid");
      if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) fail("custom arguments are malformed"); break;
  }
}

function validateSource(value: unknown, expected?: InstallationSource["kind"]): void {
  if (!isRecord(value) || !["git", "archive", "inline", "local", "enterprise"].includes(String(value.kind)) || (expected && value.kind !== expected)) fail("installation source is malformed");
  if (value.kind === "git") {
    requireSafeUrl(value.repository); requireText(value.commit, "git commit");
    if (!/^[a-f0-9]{40,64}$/i.test(value.commit as string)) fail("git source requires an exact commit hash");
    if (value.submodules !== undefined && (!isRecord(value.submodules) || Object.values(value.submodules).some((digest) => !isDigest(digest)))) fail("git submodules must be integrity pinned");
  } else if (value.kind === "archive") {
    requireSafeUrl(value.url); validateDigest(value.integrity);
  } else if (value.kind === "inline") {
    requireText(value.content, "inline content");
  } else if (value.kind === "local") {
    requireText(value.grantRef, "local grant reference"); validateDigest(value.integrity);
  } else if (value.kind === "enterprise") {
    requireText(value.adapter, "enterprise adapter"); requireText(value.artifactRef, "enterprise artifact reference"); validateDigest(value.integrity);
  }
}

function validatePermissions(value: unknown): void {
  if (!isRecord(value) || !["none", "source-only", "restricted"].includes(String(value.network)) || value.elevation !== false || !isRecord(value.limits)) fail("installation permissions are malformed");
  if (!boundedInteger(value.limits.timeoutMs, 1, 86_400_000) || !boundedInteger(value.limits.maxOutputBytes, 0, 16_777_216)
    || !boundedInteger(value.limits.maxDiskBytes, 1, 10_737_418_240) || !boundedInteger(value.limits.maxProcesses, 1, 256)) fail("installation limits are malformed");
  if (value.network === "restricted" && (!Array.isArray(value.networkHosts) || value.networkHosts.length === 0)) fail("restricted network requires networkHosts");
}

function validateVerification(value: unknown): void {
  if (!isRecord(value) || !["command", "file", "executable", "container-image"].includes(String(value.kind))) fail("installation verification is malformed");
  requireText(value.target, "verification target");
  if (value.kind !== "container-image") validateRelativePath(value.target, "verification target");
  if (value.expectedDigest !== undefined) validateDigest(value.expectedDigest);
}

function validateRelativePath(value: unknown, field: string): void {
  requireText(value, field);
  const path = value as string;
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/i.test(path) || path.split(/[\\/]/).includes("..")) fail(`${field} must stay inside the managed root`);
}

function requireSafeUrl(value: unknown): void {
  requireText(value, "source URL");
  let parsed: URL;
  try { parsed = new URL(value as string); } catch { fail("source URL is invalid"); }
  if (parsed.username || parsed.password) fail("source URL must not contain credentials");
  if (!["https:", "ssh:"].includes(parsed.protocol)) fail("source URL protocol is not allowed");
}

function requireExactVersion(value: unknown): void {
  requireText(value, "provider version");
  if (/[*xX~^<>=|\s]/.test(value as string) || ["latest", "next"].includes((value as string).toLowerCase())) fail("provider version must be exact");
}

function validateDigest(value: unknown): asserts value is InstallationDigest { if (!isDigest(value)) fail("integrity must be a sha256 digest"); }
function isDigest(value: unknown): value is InstallationDigest { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value); }
function requireText(value: unknown, field: string): asserts value is string { if (typeof value !== "string" || value.trim() === "") fail(`${field} must be non-empty`); }
function validName(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value); }
function boundedInteger(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(message: string): never { throw edgeError("EDGE_PROTOCOL", message); }
function withoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...value };
  delete payload.digest;
  return payload;
}
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, sortValue(value[key])]));
  return value;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
