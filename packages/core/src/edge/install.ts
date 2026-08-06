/**
 * Declarative managed-install plans for edge MCP deployments.
 *
 * An install plan is data only: package source, exact package name, exact
 * version, the bin entry to launch, and optional integrity/registry pins. The
 * edge agent installs the pinned package into a Fentaris-owned directory,
 * verifies it, and launches the declared bin from there; it never evaluates
 * cloud-supplied executable code and never resolves the command from the
 * ambient device `PATH` when a plan is present.
 * @pk
 */

import { createHash } from "node:crypto";
import { edgeError } from "./errors.js";

/** Install plan serialization format version. @pk */
export const EDGE_INSTALL_PLAN_VERSION = 1;

/** Supported managed-install package sources. @pk */
export type EdgeInstallPlanKind = "npm";

/** A pinned npm package installed on the edge for one deployment. @pk */
export interface EdgeNpmInstallPlan {
  /** Plan serialization version. @pk */
  readonly version: number;
  /** Package source discriminator. @pk */
  readonly kind: "npm";
  /** Exact registry package name. @pk */
  readonly package: string;
  /** Exact package version; ranges and dist-tags are rejected. @pk */
  readonly packageVersion: string;
  /** Bin entry launched from the managed install directory. @pk */
  readonly bin: string;
  /** Expected registry integrity digest for the installed package. @pk */
  readonly integrity?: string;
  /** Explicit registry URL; defaults to the device package-manager registry. @pk */
  readonly registryUrl?: string;
  /** Stable content digest over the canonical plan payload. @pk */
  readonly digest: string;
}

/** A declarative managed-install plan. @pk */
export type EdgeInstallPlan = EdgeNpmInstallPlan;

/** Author-supplied npm install declaration. @pk */
export interface EdgeNpmInstallPlanInput {
  /** Exact registry package name. @pk */
  readonly package: string;
  /** Exact package version. @pk */
  readonly version: string;
  /** Bin entry to launch; defaults to the unscoped package name. @pk */
  readonly bin?: string;
  /** Expected registry integrity digest. @pk */
  readonly integrity?: string;
  /** Explicit registry URL. @pk */
  readonly registryUrl?: string;
}

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const BIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTEGRITY_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** Compute a stable SHA-256 digest for an install plan payload. @pk */
export function computeEdgeInstallDigest(payload: Omit<EdgeInstallPlan, "digest">): string {
  const canonical = JSON.stringify({
    version: payload.version,
    kind: payload.kind,
    package: payload.package,
    packageVersion: payload.packageVersion,
    bin: payload.bin,
    integrity: payload.integrity,
    registryUrl: payload.registryUrl,
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * Compile an npm install declaration into a validated, frozen install plan.
 * Rejects version ranges, dist-tags, unsafe package names, bin values that
 * contain path separators, malformed integrity digests, and non-HTTPS
 * registries other than loopback development URLs.
 * @pk
 */
export function compileEdgeNpmInstallPlan(input: EdgeNpmInstallPlanInput): EdgeNpmInstallPlan {
  if (!input || typeof input !== "object") {
    throw new TypeError("edge.npm() requires an options object");
  }
  const packageName = requireString(input.package, "edge.npm() package");
  if (packageName.length > 214 || !PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new TypeError(`edge.npm() package "${packageName}" is not a valid registry package name`);
  }
  const packageVersion = requireString(input.version, "edge.npm() version");
  if (!EXACT_VERSION_PATTERN.test(packageVersion)) {
    throw new TypeError(
      `edge.npm() version must be an exact version such as "1.4.2"; received "${packageVersion}"`,
    );
  }
  const bin = input.bin === undefined ? defaultBinName(packageName) : requireString(input.bin, "edge.npm() bin");
  if (!BIN_PATTERN.test(bin)) {
    throw new TypeError(`edge.npm() bin "${bin}" must be a bare executable name without path separators`);
  }
  if (input.integrity !== undefined && !INTEGRITY_PATTERN.test(input.integrity)) {
    throw new TypeError("edge.npm() integrity must be a subresource integrity digest such as \"sha512-...\"");
  }
  if (input.registryUrl !== undefined) assertRegistryUrl(input.registryUrl);
  const payload: Omit<EdgeNpmInstallPlan, "digest"> = {
    version: EDGE_INSTALL_PLAN_VERSION,
    kind: "npm",
    package: packageName,
    packageVersion,
    bin,
    ...(input.integrity ? { integrity: input.integrity } : {}),
    ...(input.registryUrl ? { registryUrl: input.registryUrl } : {}),
  };
  return Object.freeze({ ...payload, digest: computeEdgeInstallDigest(payload) });
}

/**
 * Validate an install plan received from the control plane. Applies the same
 * rules as {@link compileEdgeNpmInstallPlan} and rejects a mismatched digest.
 * @pk
 */
export function validateEdgeInstallPlan(value: unknown): EdgeInstallPlan {
  if (!value || typeof value !== "object") {
    throw edgeError("EDGE_PROTOCOL", "install plan payload is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== EDGE_INSTALL_PLAN_VERSION) {
    throw edgeError("EDGE_PROTOCOL", `unsupported install plan version ${String(candidate.version)}`);
  }
  if (candidate.kind !== "npm") {
    throw edgeError("EDGE_PROTOCOL", `unsupported install plan kind ${String(candidate.kind)}`);
  }
  let plan: EdgeNpmInstallPlan;
  try {
    plan = compileEdgeNpmInstallPlan({
      package: candidate.package as string,
      version: candidate.packageVersion as string,
      ...(candidate.bin === undefined ? {} : { bin: candidate.bin as string }),
      ...(candidate.integrity === undefined ? {} : { integrity: candidate.integrity as string }),
      ...(candidate.registryUrl === undefined ? {} : { registryUrl: candidate.registryUrl as string }),
    });
  } catch (error) {
    throw edgeError("EDGE_PROTOCOL", error instanceof Error ? error.message : "install plan is malformed");
  }
  if (typeof candidate.digest === "string" && candidate.digest !== plan.digest) {
    throw edgeError("EDGE_PROTOCOL", "install plan digest mismatch");
  }
  return plan;
}

/** Stable `name@version` identifier for logs, status, and reporting. @pk */
export function edgeInstallPackageId(plan: EdgeInstallPlan): string {
  return `${plan.package}@${plan.packageVersion}`;
}

/** Filesystem-safe directory name for a managed install. @pk */
export function edgeInstallDirectoryName(plan: EdgeInstallPlan): string {
  const slug = `${plan.package}@${plan.packageVersion}`.replace(/[^A-Za-z0-9.@-]/g, "_");
  return `${slug}-${plan.digest.replace("sha256:", "").slice(0, 12)}`;
}

function defaultBinName(packageName: string): string {
  const unscoped = packageName.slice(packageName.lastIndexOf("/") + 1);
  if (!BIN_PATTERN.test(unscoped)) {
    throw new TypeError(`edge.npm() requires an explicit bin for package "${packageName}"`);
  }
  return unscoped;
}

function assertRegistryUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("edge.npm() registryUrl must be an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("edge.npm() registryUrl must use https except for loopback development");
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}
