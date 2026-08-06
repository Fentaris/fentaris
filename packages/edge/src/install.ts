import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  edgeError,
  edgeInstallDirectoryName,
  edgeInstallPackageId,
  type EdgeInstallPlan,
  type EdgeTelemetry,
} from "@fentaris/core";
import type { JsonStore } from "./platform.js";
import type { DesiredSetupRequirement } from "./setup.js";

/** One managed-install command invocation with an explicit argument vector. */
export interface EdgeInstallCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Outcome of one managed-install command invocation. */
export interface EdgeInstallCommandResult {
  readonly exitCode: number | null;
  readonly timedOut?: boolean;
}

/** Replaceable seam for running the package manager. */
export interface EdgeInstallCommandRunner {
  run(input: EdgeInstallCommandInput): Promise<EdgeInstallCommandResult>;
}

/** Local managed-install lifecycle state. */
export type LocalInstallStatus = "installing" | "installed" | "failed" | "denied";

/** Bounded, non-sensitive reason categories reported to the control plane. */
export type LocalInstallReasonCategory =
  | "install-pending"
  | "install-failed"
  | "install-denied"
  | "install-verification-failed";

/** Durable per-deployment managed-install record. */
export interface LocalInstallState {
  readonly deploymentId: string;
  readonly installDigest: string;
  readonly packageId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly status: LocalInstallStatus;
  /** Managed install directory name; never reported off the device. */
  readonly directoryName: string;
  readonly resolvedVersion?: string;
  readonly reasonCategory?: LocalInstallReasonCategory;
  readonly attempts: number;
  readonly lastAttemptAt: number;
  readonly installedAt?: number;
}

export interface LocalInstallDatabase {
  readonly records: Readonly<Record<string, LocalInstallState>>;
}

/** Aggregate install counts safe for local status output. */
export interface ManagedInstallSummary {
  readonly installedPackages: number;
  readonly pendingInstalls: number;
  readonly failedInstalls: number;
}

export interface ManagedInstallManagerOptions {
  readonly store: JsonStore<LocalInstallDatabase>;
  /** Root directory owned by Fentaris for managed installs and their cache. */
  readonly root: string;
  readonly runner?: EdgeInstallCommandRunner;
  readonly packageManager?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
  /** Local package policy consulted before any registry fetch. */
  readonly allowInstall?: (plan: EdgeInstallPlan) => boolean | Promise<boolean>;
  readonly telemetry?: EdgeTelemetry;
  readonly now?: () => number;
  readonly stagingId?: () => string;
}

/** Node package-manager runner without shell interpretation. */
export class NodeEdgeInstallCommandRunner implements EdgeInstallCommandRunner {
  run(input: EdgeInstallCommandInput): Promise<EdgeInstallCommandResult> {
    return new Promise<EdgeInstallCommandResult>((resolve, reject) => {
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env },
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
        windowsHide: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
      timer.unref?.();
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, ...(timedOut ? { timedOut } : {}) });
      });
    });
  }
}

/**
 * Installs, verifies, reuses, and prunes the MCP software a deployment pins.
 *
 * Installation runs with package lifecycle scripts disabled, no shell, a
 * minimal environment, a Fentaris-owned cache, and a bounded timeout. A staged
 * tree is promoted only after the installed version, declared bin, containment,
 * and optional integrity digest all verify.
 */
export class ManagedInstallManager {
  private readonly now: () => number;
  private readonly stagingId: () => string;
  private readonly limits: { readonly timeoutMs: number; readonly maxAttempts: number; readonly retryBackoffMs: number };

  constructor(private readonly options: ManagedInstallManagerOptions) {
    this.now = options.now ?? Date.now;
    this.stagingId = options.stagingId ?? randomUUID;
    this.limits = {
      timeoutMs: options.timeoutMs ?? 300_000,
      maxAttempts: options.maxAttempts ?? 3,
      retryBackoffMs: options.retryBackoffMs ?? 60_000,
    };
  }

  /**
   * Ensure the package pinned by a requirement is installed and verified.
   * Returns `undefined` when the recipe declares no managed install.
   */
  async ensure(requirement: DesiredSetupRequirement): Promise<LocalInstallState | undefined> {
    const plan = requirement.recipe.install;
    if (!plan) {
      await this.forget(requirement.deploymentId);
      return undefined;
    }
    const database = await this.database();
    const previous = database.records[requirement.deploymentId];
    const directoryName = edgeInstallDirectoryName(plan);
    const current = previous?.installDigest === plan.digest ? previous : undefined;
    const deploymentId = requirement.deploymentId;
    if (this.options.allowInstall && !await this.options.allowInstall(plan)) {
      return this.record(plan, deploymentId, directoryName, {
        status: "denied",
        reasonCategory: "install-denied",
        attempts: current?.attempts ?? 0,
      });
    }
    if (current?.status === "installed" && await this.verified(directoryName, plan)) return current;
    if (await this.verified(directoryName, plan)) {
      return this.record(plan, deploymentId, directoryName, {
        status: "installed",
        resolvedVersion: plan.packageVersion,
        attempts: current?.attempts ?? 0,
        installedAt: current?.installedAt ?? this.now(),
      });
    }
    if (current && !this.retryable(current)) return current;
    const attempts = (current?.attempts ?? 0) + 1;
    await this.record(plan, deploymentId, directoryName, {
      status: "installing",
      reasonCategory: "install-pending",
      attempts,
    });
    try {
      await this.install(plan, directoryName);
    } catch (error) {
      return this.record(plan, deploymentId, directoryName, {
        status: "failed",
        reasonCategory: reasonFor(error),
        attempts,
      });
    }
    return this.record(plan, deploymentId, directoryName, {
      status: "installed",
      resolvedVersion: plan.packageVersion,
      attempts,
      installedAt: this.now(),
    });
  }

  /** Absolute, contained bin path for a verified managed install. */
  async resolveCommand(requirement: DesiredSetupRequirement): Promise<string> {
    const plan = requirement.recipe.install;
    if (!plan) throw edgeError("EDGE_WORKLOAD", "Deployment does not declare a managed install.");
    const state = (await this.database()).records[requirement.deploymentId];
    if (!state || state.installDigest !== plan.digest || state.status !== "installed") {
      throw edgeError("EDGE_SETUP_REQUIRED", "Managed install for this deployment is not ready.", {
        details: {
          deploymentId: requirement.deploymentId,
          package: edgeInstallPackageId(plan),
          reasonCategory: state?.reasonCategory ?? "install-pending",
        },
      });
    }
    return this.verifiedBin(edgeInstallDirectoryName(plan), plan);
  }

  async status(deploymentId: string): Promise<LocalInstallState | undefined> {
    return (await this.database()).records[deploymentId];
  }

  async summary(): Promise<ManagedInstallSummary> {
    const records = Object.values((await this.database()).records);
    const installed = new Set(
      records.filter((record) => record.status === "installed").map((record) => record.installDigest),
    );
    return {
      installedPackages: installed.size,
      pendingInstalls: records.filter((record) => record.status === "installing").length,
      failedInstalls: records.filter((record) => record.status === "failed" || record.status === "denied").length,
    };
  }

  /** Drop records and directories that no desired deployment references. */
  async prune(activeDeploymentIds: readonly string[]): Promise<readonly string[]> {
    const active = new Set(activeDeploymentIds);
    const database = await this.database();
    const records: Record<string, LocalInstallState> = {};
    for (const [deploymentId, record] of Object.entries(database.records)) {
      if (active.has(deploymentId)) records[deploymentId] = record;
    }
    const referenced = new Set(Object.values(records).map((record) => record.directoryName));
    const present = await readdir(this.installsRoot(), { withFileTypes: true }).catch(() => []);
    const removed = [...new Set([
      ...Object.values(database.records).map((record) => record.directoryName),
      ...present.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    ])].filter((directoryName) => !referenced.has(directoryName)).sort();
    for (const directoryName of removed) {
      await rm(path.join(this.installsRoot(), directoryName), { recursive: true, force: true });
    }
    if (removed.length > 0 || Object.keys(records).length !== Object.keys(database.records).length) {
      await this.options.store.save({ records });
    }
    return removed;
  }

  /** Remove every managed install, its cache, and all install state. */
  async clear(): Promise<void> {
    await rm(this.options.root, { recursive: true, force: true });
    await this.options.store.delete();
  }

  private async install(plan: EdgeInstallPlan, directoryName: string): Promise<void> {
    const staging = path.join(this.options.root, ".staging", this.stagingId());
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(staging, "package.json"),
        JSON.stringify({ name: "fentaris-managed-install", version: "0.0.0", private: true }),
        { encoding: "utf8", mode: 0o600 },
      );
      const result = await this.runner().run({
        command: this.options.packageManager ?? "npm",
        args: installArguments(plan),
        cwd: staging,
        env: this.installEnvironment(),
        timeoutMs: this.limits.timeoutMs,
      });
      if (result.timedOut) {
        throw edgeError("EDGE_WORKLOAD", "Managed install timed out.");
      }
      if (result.exitCode !== 0) {
        throw edgeError("EDGE_WORKLOAD", "Managed install command failed.", {
          details: { exitCode: result.exitCode },
        });
      }
      await this.verify(staging, plan);
      const target = path.join(this.installsRoot(), directoryName);
      await mkdir(this.installsRoot(), { recursive: true, mode: 0o700 });
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async verify(directory: string, plan: EdgeInstallPlan): Promise<string> {
    const manifest = await readJson(path.join(directory, "node_modules", ...plan.package.split("/"), "package.json"));
    const installedVersion = manifest && typeof manifest.version === "string" ? manifest.version : undefined;
    if (installedVersion !== plan.packageVersion) {
      throw verificationError("Installed package version does not match the pinned version.", {
        expected: plan.packageVersion,
        installed: installedVersion ?? "unknown",
      });
    }
    if (plan.integrity !== undefined) {
      const recorded = await recordedIntegrity(directory, plan.package);
      if (recorded !== plan.integrity) {
        throw verificationError("Installed package integrity does not match the declared digest.");
      }
    }
    return containedBin(directory, plan);
  }

  private async verified(directoryName: string, plan: EdgeInstallPlan): Promise<boolean> {
    try {
      await this.verify(path.join(this.installsRoot(), directoryName), plan);
      return true;
    } catch {
      return false;
    }
  }

  private verifiedBin(directoryName: string, plan: EdgeInstallPlan): Promise<string> {
    return this.verify(path.join(this.installsRoot(), directoryName), plan);
  }

  private retryable(state: LocalInstallState): boolean {
    if (state.status === "denied") return true;
    if (state.attempts >= this.limits.maxAttempts) return false;
    if (state.status === "installing") return true;
    const backoff = this.limits.retryBackoffMs * 2 ** Math.max(0, state.attempts - 1);
    return this.now() - state.lastAttemptAt >= backoff;
  }

  private async record(
    plan: EdgeInstallPlan,
    deploymentId: string,
    directoryName: string,
    fields: {
      readonly status: LocalInstallStatus;
      readonly reasonCategory?: LocalInstallReasonCategory;
      readonly resolvedVersion?: string;
      readonly attempts: number;
      readonly installedAt?: number;
    },
  ): Promise<LocalInstallState> {
    const database = await this.database();
    const state: LocalInstallState = {
      deploymentId,
      installDigest: plan.digest,
      packageId: edgeInstallPackageId(plan),
      packageName: plan.package,
      packageVersion: plan.packageVersion,
      status: fields.status,
      directoryName,
      attempts: fields.attempts,
      lastAttemptAt: this.now(),
      ...(fields.resolvedVersion ? { resolvedVersion: fields.resolvedVersion } : {}),
      ...(fields.reasonCategory ? { reasonCategory: fields.reasonCategory } : {}),
      ...(fields.installedAt ? { installedAt: fields.installedAt } : {}),
    };
    await this.options.store.save({ records: { ...database.records, [deploymentId]: state } });
    await this.options.telemetry?.emit({
      name: "edge.install.transition",
      deploymentId,
      outcome: state.status,
      metadata: {
        packageId: state.packageId,
        installDigest: state.installDigest,
        attempts: state.attempts,
        ...(state.reasonCategory ? { reasonCategory: state.reasonCategory } : {}),
      },
    }).catch(() => undefined);
    return state;
  }

  private async forget(deploymentId: string): Promise<void> {
    const database = await this.database();
    if (!database.records[deploymentId]) return;
    const records = { ...database.records };
    delete records[deploymentId];
    await this.options.store.save({ records });
  }

  private installEnvironment(): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const name of [
      "PATH",
      "HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "SystemRoot",
      "COMSPEC",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]) {
      const value = process.env[name];
      if (value !== undefined) inherited[name] = value;
    }
    return {
      ...inherited,
      npm_config_cache: path.join(this.options.root, "cache"),
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_progress: "false",
    };
  }

  private installsRoot(): string {
    return path.join(this.options.root, "packages");
  }

  private runner(): EdgeInstallCommandRunner {
    return this.options.runner ?? new NodeEdgeInstallCommandRunner();
  }

  private async database(): Promise<LocalInstallDatabase> {
    return await this.options.store.load() ?? { records: {} };
  }
}

function installArguments(plan: EdgeInstallPlan): string[] {
  return [
    "install",
    `${plan.package}@${plan.packageVersion}`,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...(plan.registryUrl ? [`--registry=${plan.registryUrl}`] : []),
  ];
}

async function containedBin(directory: string, plan: EdgeInstallPlan): Promise<string> {
  const binDirectory = path.join(directory, "node_modules", ".bin");
  const candidates = process.platform === "win32"
    ? [plan.bin, `${plan.bin}.cmd`, `${plan.bin}.exe`, `${plan.bin}.ps1`]
    : [plan.bin];
  const root = await realpath(directory).catch(() => undefined);
  if (!root) throw verificationError("Managed install directory is missing.");
  for (const candidate of candidates) {
    const resolved = await realpath(path.join(binDirectory, candidate)).catch(() => undefined);
    if (!resolved) continue;
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw verificationError("Managed install bin resolves outside the install directory.");
    }
    if (!(await stat(resolved)).isFile()) continue;
    return resolved;
  }
  throw verificationError("Managed install does not provide the declared bin.", { bin: plan.bin });
}

async function recordedIntegrity(directory: string, packageName: string): Promise<string | undefined> {
  const lock = await readJson(path.join(directory, "package-lock.json"));
  const packages = lock?.packages as Record<string, { integrity?: string }> | undefined;
  return packages?.[`node_modules/${packageName}`]?.integrity;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function verificationError(message: string, details?: Record<string, unknown>): Error {
  return edgeError("EDGE_WORKLOAD", message, {
    details: { ...details, reasonCategory: "install-verification-failed" },
  });
}

function reasonFor(error: unknown): LocalInstallReasonCategory {
  const details = error && typeof error === "object" && "details" in error
    ? (error as { details?: Record<string, unknown> }).details
    : undefined;
  return details?.reasonCategory === "install-verification-failed"
    ? "install-verification-failed"
    : "install-failed";
}
