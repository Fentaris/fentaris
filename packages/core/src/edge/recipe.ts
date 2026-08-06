/**
 * Versioned, serializable MCP launch recipe.
 *
 * A launch recipe is data only: executable, argument/env templates (which may
 * contain runtime-value tokens), client metadata, setup schema identifiers, a
 * content digest, and workload/isolation policy hints. The edge agent resolves
 * supported tokens from local grants and starts the local process; it never
 * evaluates cloud-supplied executable code.
 * @pk
 */

import { createHash } from "node:crypto";
import type { StdioTransportOptions } from "../transports/client/StdioTransport.js";
import { isRuntimeValueToken, type RuntimeValueToken } from "./runtimeInput.js";
import { edgeError } from "./errors.js";
import { compileEdgeNpmInstallPlan, validateEdgeInstallPlan, type EdgeInstallPlan } from "./install.js";
import type { SetupSchema } from "./setup.js";

/** Launch recipe serialization format version. @pk */
export const LAUNCH_RECIPE_VERSION = 1;

/** A versioned, serializable launch recipe. @pk */
export interface LaunchRecipe {
  /** Recipe serialization version. @pk */
  readonly version: number;
  /** Executable command. @pk */
  readonly command: string;
  /** Argument templates; entries may be runtime-value tokens. @pk */
  readonly args: readonly (string | RuntimeValueToken)[];
  /** Environment templates; values may be runtime-value tokens. @pk */
  readonly env: Readonly<Record<string, string | RuntimeValueToken>>;
  /** Stderr policy. @pk */
  readonly stderr?: "inherit" | "pipe" | "overlapped" | "ignore";
  /** Client name reported to the upstream MCP. @pk */
  readonly clientName?: string;
  /** Client version reported to the upstream MCP. @pk */
  readonly clientVersion?: string;
  /** Setup schema version this recipe expects. @pk */
  readonly setupSchemaVersion?: number;
  /** Sorted setup field names referenced by this recipe. @pk */
  readonly setupFieldRefs: readonly string[];
  /**
   * Managed installation for this deployment. When present, `command` is a bare
   * bin name resolved inside the edge-managed install directory instead of the
   * device `PATH`.
   * @pk
   */
  readonly install?: EdgeInstallPlan;
  /** Stable content digest over the canonical recipe payload. @pk */
  readonly digest: string;
}

function canonicalRecipePayload(recipe: Omit<LaunchRecipe, "digest">): string {
  return JSON.stringify({
    version: recipe.version,
    command: recipe.command,
    args: recipe.args,
    env: recipe.env,
    stderr: recipe.stderr,
    clientName: recipe.clientName,
    clientVersion: recipe.clientVersion,
    setupSchemaVersion: recipe.setupSchemaVersion,
    setupFieldRefs: recipe.setupFieldRefs,
    install: recipe.install,
  });
}

/** Compute a stable SHA-256 digest for a recipe payload. @pk */
export function computeRecipeDigest(payload: Omit<LaunchRecipe, "digest">): string {
  return "sha256:" + createHash("sha256").update(canonicalRecipePayload(payload)).digest("hex");
}

/** Collect setup field names referenced by runtime-value tokens in a recipe. @pk */
export function collectRecipeRuntimeRefs(
  args: readonly (string | RuntimeValueToken)[],
  env: Readonly<Record<string, string | RuntimeValueToken>>,
): string[] {
  const refs = new Set<string>();
  for (const value of args) {
    if (isRuntimeValueToken(value)) refs.add(value.ref);
  }
  for (const value of Object.values(env)) {
    if (isRuntimeValueToken(value)) refs.add(value.ref);
  }
  return [...refs].sort();
}

/**
 * Compile a {@link LaunchRecipe} from stdio transport options. Collects the
 * setup field names referenced by runtime-value tokens and binds the recipe to
 * a setup schema version when provided. Throws for empty commands.
 * @pk
 */
export function compileLaunchRecipe(options: StdioTransportOptions, schema?: SetupSchema): LaunchRecipe {
  if (!options || typeof options.command !== "string" || options.command.trim() === "") {
    throw new TypeError("compileLaunchRecipe requires a non-empty command");
  }
  const args = options.args ?? [];
  const env = options.env ?? {};
  const setupFieldRefs = collectRecipeRuntimeRefs(args, env);
  const install = options.install === undefined
    ? undefined
    : "digest" in options.install
      ? options.install
      : compileEdgeNpmInstallPlan(options.install);
  if (install) assertManagedInstallCommand(options.command, (message) => new TypeError(message));
  const payload: Omit<LaunchRecipe, "digest"> = {
    version: LAUNCH_RECIPE_VERSION,
    command: options.command,
    args: [...args],
    env: { ...env },
    ...(options.stderr ? { stderr: options.stderr } : {}),
    ...(options.clientName ? { clientName: options.clientName } : {}),
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    ...(schema ? { setupSchemaVersion: schema.version } : {}),
    setupFieldRefs,
    ...(install ? { install } : {}),
  };
  return Object.freeze({ ...payload, digest: computeRecipeDigest(payload) });
}

/**
 * A managed-install recipe launches a bin from the edge-managed install
 * directory, so its command must be a bare executable name.
 * @pk
 */
export function assertManagedInstallCommand(command: string, fail: (message: string) => Error): void {
  const message = "A managed-install launch recipe command must be a bare bin name without path separators";
  if (command.includes("/") || command.includes("\\") || command === "." || command === "..") {
    throw fail(message);
  }
}

/** Serialize a recipe to a canonical JSON string. @pk */
export function serializeLaunchRecipe(recipe: LaunchRecipe): string {
  return JSON.stringify(recipe);
}

/** Parse and validate a serialized recipe. @pk */
export function parseLaunchRecipe(data: string): LaunchRecipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw edgeError("EDGE_PROTOCOL", "malformed launch recipe payload");
  }
  return validateLaunchRecipe(parsed);
}

/** Validate an already-decoded launch recipe object. @pk */
export function validateLaunchRecipe(value: unknown): LaunchRecipe {
  if (!value || typeof value !== "object") {
    throw edgeError("EDGE_PROTOCOL", "launch recipe payload is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== LAUNCH_RECIPE_VERSION) {
    throw edgeError("EDGE_PROTOCOL", `unsupported launch recipe version ${String(candidate.version)}`);
  }
  if (typeof candidate.command !== "string" || candidate.command.trim() === "") {
    throw edgeError("EDGE_PROTOCOL", "launch recipe command is missing");
  }
  if (!Array.isArray(candidate.args) || typeof candidate.env !== "object" || candidate.env === null) {
    throw edgeError("EDGE_PROTOCOL", "launch recipe args/env are malformed");
  }
  const args = (candidate.args as unknown[]).map((value) => normalizeLaunchValue(value));
  const env: Record<string, string | RuntimeValueToken> = {};
  for (const [key, value] of Object.entries(candidate.env as Record<string, unknown>)) {
    env[key] = normalizeLaunchValue(value);
  }
  const setupFieldRefs = collectRecipeRuntimeRefs(args, env);
  const install = candidate.install === undefined ? undefined : validateEdgeInstallPlan(candidate.install);
  if (install) {
    assertManagedInstallCommand(candidate.command, (message) => edgeError("EDGE_PROTOCOL", message));
  }
  const payload: Omit<LaunchRecipe, "digest"> = {
    version: LAUNCH_RECIPE_VERSION,
    command: candidate.command,
    args,
    env,
    ...(typeof candidate.stderr === "string" ? { stderr: candidate.stderr as LaunchRecipe["stderr"] } : {}),
    ...(typeof candidate.clientName === "string" ? { clientName: candidate.clientName } : {}),
    ...(typeof candidate.clientVersion === "string" ? { clientVersion: candidate.clientVersion } : {}),
    ...(typeof candidate.setupSchemaVersion === "number" ? { setupSchemaVersion: candidate.setupSchemaVersion } : {}),
    setupFieldRefs,
    ...(install ? { install } : {}),
  };
  const digest = computeRecipeDigest(payload);
  if (typeof candidate.digest === "string" && candidate.digest !== digest) {
    throw edgeError("EDGE_PROTOCOL", "launch recipe digest mismatch");
  }
  return Object.freeze({ ...payload, digest });
}

function normalizeLaunchValue(value: unknown): string | RuntimeValueToken {
  if (typeof value === "string") return value;
  if (isRuntimeValueToken(value)) return value;
  throw edgeError("EDGE_PROTOCOL", "launch recipe argument/environment value is neither a string nor a runtime token");
}