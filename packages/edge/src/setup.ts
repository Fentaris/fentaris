import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import {
  LAUNCH_RECIPE_VERSION,
  edgeError,
  isRuntimeValueToken,
  isInstalledArtifactReference,
  type LaunchRecipe,
  type SetupField,
  type SetupFieldAccess,
  type SetupSchema,
  type EdgeTelemetry,
} from "@fentaris/core";
import type { CredentialStore, JsonStore } from "./platform.js";

export interface DesiredSetupRequirement {
  readonly deploymentId: string;
  readonly desiredStateVersion: number;
  readonly recipe: LaunchRecipe;
  readonly schema: SetupSchema;
}

export type LocalSetupStatus = "pending" | "ready" | "denied" | "revoked";

export interface LocalSetupState {
  readonly deploymentId: string;
  readonly desiredStateVersion: number;
  readonly recipeDigest: string;
  readonly setupSchemaVersion: number;
  readonly status: LocalSetupStatus;
  readonly grantRefs: Readonly<Record<string, string>>;
  readonly fieldDigests: Readonly<Record<string, string>>;
  readonly missingFields: readonly string[];
}

export interface SetupFieldResponse {
  readonly approved: boolean;
  readonly value?: unknown;
}

export interface LocalSetupProvider {
  approveWorkload(requirement: DesiredSetupRequirement): Promise<boolean>;
  collectField(field: SetupField, requirement: DesiredSetupRequirement): Promise<SetupFieldResponse>;
}

export interface TerminalSetupPrompter {
  confirm(message: string): Promise<boolean>;
  input(message: string, options?: { secret?: boolean }): Promise<string>;
}

/** Interactive terminal prompter that suppresses local secret echo on a TTY. */
export class NodeTerminalSetupPrompter implements TerminalSetupPrompter {
  async confirm(message: string): Promise<boolean> {
    const value = (await this.input(`${message} [y/N]:`)).trim().toLowerCase();
    return value === "y" || value === "yes";
  }

  async input(message: string, options?: { secret?: boolean }): Promise<string> {
    if (options?.secret && process.stdin.isTTY) {
      return hiddenInput(message);
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await prompt.question(`${message} `);
    } finally {
      prompt.close();
    }
  }
}

/** Initial terminal setup provider with explicit workload and resource consent. */
export class TerminalSetupProvider implements LocalSetupProvider {
  constructor(private readonly prompt: TerminalSetupPrompter) {}

  approveWorkload(requirement: DesiredSetupRequirement): Promise<boolean> {
    return this.prompt.confirm(
      `Allow deployment "${requirement.deploymentId}" to run recipe ${requirement.recipe.digest}?`,
    );
  }

  async collectField(field: SetupField): Promise<SetupFieldResponse> {
    const label = field.label ?? field.name;
    if (field.kind === "folder" || field.kind === "file") {
      const approved = await this.prompt.confirm(
        `Grant ${field.access} access for ${field.kind} "${label}"?`,
      );
      if (!approved) return { approved: false };
    }
    const raw = await this.prompt.input(`${label}:`, { secret: field.kind === "secret" });
    return { approved: true, value: parseTerminalValue(field, raw) };
  }
}

export type LocalGrantRecord =
  | {
      readonly id: string;
      readonly deploymentId: string;
      readonly fieldName: string;
      readonly fieldDigest: string;
      readonly kind: "folder" | "file";
      readonly canonicalPath: string;
      readonly access: SetupFieldAccess;
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly deploymentId: string;
      readonly fieldName: string;
      readonly fieldDigest: string;
      readonly kind: "secret";
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly deploymentId: string;
      readonly fieldName: string;
      readonly fieldDigest: string;
      readonly kind: "string" | "boolean" | "number" | "select";
      readonly value: string | boolean | number;
      readonly createdAt: number;
    };

export interface LocalGrantDatabase {
  readonly grants: Readonly<Record<string, LocalGrantRecord>>;
  readonly states: Readonly<Record<string, LocalSetupState>>;
  readonly approvedRecipeDigests: readonly string[];
}

export interface CompiledLocalLaunchPlan {
  readonly deploymentId: string;
  readonly recipeDigest: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface LocalSetupManagerOptions {
  readonly store: JsonStore<LocalGrantDatabase>;
  readonly credentials: CredentialStore;
  readonly provider: LocalSetupProvider;
  readonly now?: () => number;
  readonly grantId?: () => string;
  readonly onGrantRevoked?: (grantId: string, deploymentIds: readonly string[]) => void | Promise<void>;
  readonly telemetry?: EdgeTelemetry;
  readonly resolveInstalledArtifact?: (reference: import("@fentaris/core").InstalledArtifactReference) => Promise<string>;
}

/** Local setup/grant reconciliation and launch-plan compilation. */
export class LocalSetupManager {
  private readonly now: () => number;
  private readonly grantId: () => string;

  constructor(private readonly options: LocalSetupManagerOptions) {
    this.now = options.now ?? Date.now;
    this.grantId = options.grantId ?? randomUUID;
  }

  async ingest(requirement: DesiredSetupRequirement): Promise<LocalSetupState> {
    assertDeclarative(requirement.recipe);
    if (requirement.recipe.version !== LAUNCH_RECIPE_VERSION) {
      throw edgeError("EDGE_PROTOCOL", "Unsupported launch recipe version.");
    }
    const database = await this.database();
    const previous = database.states[requirement.deploymentId];
    const grants = { ...database.grants };
    const grantRefs: Record<string, string> = {};
    const fieldDigests: Record<string, string> = {};
    const missingFields: string[] = [];
    const approved = new Set(database.approvedRecipeDigests);
    const created: LocalGrantRecord[] = [];
    const retired: LocalGrantRecord[] = [];

    if (!approved.has(requirement.recipe.digest)) {
      if (!await this.options.provider.approveWorkload(requirement)) {
        const denied = stateFor(requirement, "denied", {}, {}, Object.keys(requirement.schema.fields));
        await this.save({ ...database, grants, states: { ...database.states, [requirement.deploymentId]: denied } });
        await this.emitTransition(denied);
        return denied;
      }
      approved.add(requirement.recipe.digest);
    }

    try {
      for (const [name, field] of Object.entries(requirement.schema.fields)) {
        const digest = fieldDigest(field);
        fieldDigests[name] = digest;
        const oldGrantId = previous?.grantRefs[name];
        const oldGrant = oldGrantId ? grants[oldGrantId] : undefined;
        if (oldGrant && oldGrant.fieldDigest === digest) {
          grantRefs[name] = oldGrant.id;
          continue;
        }
        if (oldGrant) {
          retired.push(oldGrant);
          delete grants[oldGrant.id];
        }
        const response = await this.options.provider.collectField(field, requirement);
        if (!response.approved) {
          if (field.required) missingFields.push(name);
          continue;
        }
        const value = response.value ?? defaultValue(field);
        if (value === undefined && !field.required) continue;
        if (value === undefined) {
          missingFields.push(name);
          continue;
        }
        const grant = await this.createGrant(requirement.deploymentId, field, digest, value);
        created.push(grant);
        grants[grant.id] = grant;
        grantRefs[name] = grant.id;
      }
      for (const [name, oldGrantId] of Object.entries(previous?.grantRefs ?? {})) {
        if (name in requirement.schema.fields) continue;
        const oldGrant = grants[oldGrantId];
        if (oldGrant) {
          retired.push(oldGrant);
          delete grants[oldGrantId];
        }
      }

      const status: LocalSetupStatus = missingFields.length === 0 ? "ready" : "pending";
      const state = stateFor(requirement, status, grantRefs, fieldDigests, missingFields);
      await this.save({
        grants,
        states: { ...database.states, [requirement.deploymentId]: state },
        approvedRecipeDigests: [...approved],
      });
      await Promise.all(retired.map((grant) => this.deleteGrant(grant)));
      await this.emitTransition(state);
      return state;
    } catch (error) {
      await Promise.all(created.map((grant) => this.deleteGrant(grant)));
      throw error;
    }
  }

  async status(deploymentId: string): Promise<LocalSetupState | undefined> {
    return (await this.database()).states[deploymentId];
  }

  /** Delete every local grant, setup state, and protected setup secret. */
  async clear(): Promise<void> {
    const database = await this.database();
    await Promise.all(Object.values(database.grants).map((grant) => this.deleteGrant(grant)));
    await this.options.store.delete();
  }

  async compileLaunchPlan(requirement: DesiredSetupRequirement): Promise<CompiledLocalLaunchPlan> {
    assertDeclarative(requirement.recipe);
    const database = await this.database();
    const state = database.states[requirement.deploymentId];
    if (
      !state
      || state.status !== "ready"
      || state.desiredStateVersion !== requirement.desiredStateVersion
      || state.recipeDigest !== requirement.recipe.digest
      || state.setupSchemaVersion !== requirement.schema.version
    ) {
      throw edgeError("EDGE_SETUP_REQUIRED", "Current desired deployment is not locally ready.", {
        details: { deploymentId: requirement.deploymentId },
      });
    }
    if (!database.approvedRecipeDigests.includes(requirement.recipe.digest)) {
      throw edgeError("EDGE_SETUP_REQUIRED", "Launch recipe has not received local consent.");
    }
    const resolve = async (value: string | object): Promise<string> => {
      if (typeof value === "string") return value;
      if (!isRuntimeValueToken(value)) {
        throw edgeError("EDGE_PROTOCOL", "Launch recipe contains unsupported executable data.");
      }
      const grantId = state.grantRefs[value.ref];
      const grant = grantId ? database.grants[grantId] : undefined;
      if (!grant) {
        throw edgeError("EDGE_SETUP_REQUIRED", "A required local setup grant is missing.", {
          details: { deploymentId: requirement.deploymentId, field: value.ref },
        });
      }
      if (value.kind === "secret") {
        if (grant.kind !== "secret") throw edgeError("EDGE_GRANT", "Runtime secret references a non-secret grant.");
        const secret = await this.options.credentials.get(secretKey(grant.id));
        if (secret === undefined) throw edgeError("EDGE_GRANT", "Local secret grant was revoked.");
        return secret;
      }
      return this.resolveGrantValue(grant);
    };
    const args = await Promise.all(requirement.recipe.args.map(resolve));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(requirement.recipe.env)) env[name] = await resolve(value);
    const command = typeof requirement.recipe.command === "string"
      ? requirement.recipe.command
      : isInstalledArtifactReference(requirement.recipe.command) && this.options.resolveInstalledArtifact
        ? await this.options.resolveInstalledArtifact(requirement.recipe.command)
        : undefined;
    if (!command) throw edgeError("EDGE_SETUP_REQUIRED", "Installed launch artifact is missing or stale.");
    return {
      deploymentId: requirement.deploymentId,
      recipeDigest: requirement.recipe.digest,
      command,
      args,
      env,
    };
  }

  /** Resolve a child path while rechecking canonical containment and access. */
  async resolveGrantedPath(
    grantId: string,
    childPath = ".",
    requestedAccess: SetupFieldAccess = "read",
  ): Promise<string> {
    const grant = (await this.database()).grants[grantId];
    if (!grant || (grant.kind !== "folder" && grant.kind !== "file")) {
      throw edgeError("EDGE_GRANT", "Filesystem grant is missing or revoked.");
    }
    if (requestedAccess === "read-write" && grant.access !== "read-write") {
      throw edgeError("EDGE_GRANT", "Write access exceeds the approved local grant.");
    }
    const root = await realpath(grant.canonicalPath);
    if (root !== grant.canonicalPath) {
      throw edgeError("EDGE_GRANT", "Filesystem grant canonical path changed.");
    }
    if (grant.kind === "file") {
      if (childPath !== "." && childPath !== "") throw edgeError("EDGE_GRANT", "File grants do not allow child paths.");
      return root;
    }
    const candidate = await realpath(path.resolve(root, childPath));
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw edgeError("EDGE_GRANT", "Resolved path escapes the approved local grant.");
    }
    return candidate;
  }

  async revokeGrant(grantId: string): Promise<void> {
    const database = await this.database();
    const grant = database.grants[grantId];
    if (!grant) return;
    await this.deleteGrant(grant);
    const grants = { ...database.grants };
    delete grants[grantId];
    const affected: string[] = [];
    const states: Record<string, LocalSetupState> = {};
    for (const [deploymentId, state] of Object.entries(database.states)) {
      if (!Object.values(state.grantRefs).includes(grantId)) {
        states[deploymentId] = state;
        continue;
      }
      affected.push(deploymentId);
      states[deploymentId] = {
        ...state,
        status: "revoked",
        missingFields: [...new Set([...state.missingFields, grant.fieldName])],
      };
    }
    await this.save({ ...database, grants, states });
    await this.options.onGrantRevoked?.(grantId, affected);
    for (const deploymentId of affected) {
      const state = states[deploymentId];
      if (state) await this.emitTransition(state);
    }
  }

  private async createGrant(
    deploymentId: string,
    field: SetupField,
    digest: string,
    value: unknown,
  ): Promise<LocalGrantRecord> {
    const id = this.grantId();
    const base = {
      id,
      deploymentId,
      fieldName: field.name,
      fieldDigest: digest,
      createdAt: this.now(),
    };
    if (field.kind === "folder" || field.kind === "file") {
      if (typeof value !== "string") throw edgeError("EDGE_GRANT", `${field.kind} setup requires a local path.`);
      const canonicalPath = await realpath(value);
      const info = await lstat(canonicalPath);
      if (field.kind === "folder" ? !info.isDirectory() : !info.isFile()) {
        throw edgeError("EDGE_GRANT", `Selected path is not a ${field.kind}.`);
      }
      return { ...base, kind: field.kind, canonicalPath, access: field.access };
    }
    if (field.kind === "secret") {
      if (typeof value !== "string" || value.length === 0) throw edgeError("EDGE_GRANT", "Secret setup requires a value.");
      await this.options.credentials.set(secretKey(id), value);
      return { ...base, kind: "secret" };
    }
    const scalar = validateScalar(field, value);
    return { ...base, kind: field.kind, value: scalar };
  }

  private async resolveGrantValue(grant: LocalGrantRecord): Promise<string> {
    if (grant.kind === "folder" || grant.kind === "file") {
      return this.resolveGrantedPath(grant.id);
    }
    if (grant.kind === "secret") {
      throw edgeError("EDGE_GRANT", "Secret grant requires a runtime.secret reference.");
    }
    if ("value" in grant) return String(grant.value);
    throw edgeError("EDGE_GRANT", "Unsupported local grant value.");
  }

  private async deleteGrant(grant: LocalGrantRecord): Promise<void> {
    if (grant.kind === "secret") await this.options.credentials.delete(secretKey(grant.id));
  }

  private async database(): Promise<LocalGrantDatabase> {
    return await this.options.store.load() ?? { grants: {}, states: {}, approvedRecipeDigests: [] };
  }

  private save(database: LocalGrantDatabase): Promise<void> {
    return this.options.store.save(database);
  }

  private async emitTransition(state: LocalSetupState): Promise<void> {
    await this.options.telemetry?.emit({
      name: "edge.setup.transition",
      deploymentId: state.deploymentId,
      outcome: state.status,
      metadata: {
        desiredStateVersion: state.desiredStateVersion,
        recipeDigest: state.recipeDigest,
        setupSchemaVersion: state.setupSchemaVersion,
        missingFields: state.missingFields,
      },
    }).catch(() => undefined);
  }
}

function stateFor(
  requirement: DesiredSetupRequirement,
  status: LocalSetupStatus,
  grantRefs: Readonly<Record<string, string>>,
  fieldDigests: Readonly<Record<string, string>>,
  missingFields: readonly string[],
): LocalSetupState {
  return {
    deploymentId: requirement.deploymentId,
    desiredStateVersion: requirement.desiredStateVersion,
    recipeDigest: requirement.recipe.digest,
    setupSchemaVersion: requirement.schema.version,
    status,
    grantRefs,
    fieldDigests,
    missingFields,
  };
}

function fieldDigest(field: SetupField): string {
  return JSON.stringify(canonicalize(field));
}

function secretKey(grantId: string): string {
  return `setup-secret:${grantId}`;
}

function defaultValue(field: SetupField): unknown {
  return "default" in field ? field.default : undefined;
}

function validateScalar(field: SetupField, value: unknown): string | boolean | number {
  switch (field.kind) {
    case "string":
      if (typeof value !== "string") break;
      return value;
    case "boolean":
      if (typeof value !== "boolean") break;
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) break;
      if (field.min !== undefined && value < field.min) break;
      if (field.max !== undefined && value > field.max) break;
      return value;
    case "select":
      if (typeof value !== "string" || !field.options.some((option) => option.value === value)) break;
      return value;
    default:
      throw edgeError("EDGE_GRANT", `Field "${field.name}" is not scalar.`);
  }
  throw edgeError("EDGE_GRANT", `Invalid local value for ${field.kind} field "${field.name}".`);
}

function parseTerminalValue(field: SetupField, raw: string): unknown {
  if (field.kind === "boolean") {
    if (raw === "true" || raw === "yes") return true;
    if (raw === "false" || raw === "no") return false;
    return raw;
  }
  if (field.kind === "number") return Number(raw);
  return raw;
}

function assertDeclarative(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "function" || typeof value === "symbol") {
    throw edgeError("EDGE_PROTOCOL", "Launch recipe contains executable code.");
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) assertDeclarative(child, seen);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function hiddenInput(message: string): Promise<string> {
  process.stdout.write(`${message} `);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        finish();
        reject(new Error("Terminal input cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (character && !key.ctrl) value += character;
    };
    const finish = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    process.stdin.on("keypress", onKeypress);
  });
}
