import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileLaunchRecipe, createSetupSchema, edge } from "@fentaris/core";
import {
  ExecutableAllowlistPolicy,
  ManagedInstallManager,
  type DesiredSetupRequirement,
  type EdgeInstallCommandInput,
  type EdgeInstallCommandRunner,
  type JsonStore,
  type LocalInstallDatabase,
} from "../src/index.js";

class MemoryStore implements JsonStore<LocalInstallDatabase> {
  value?: LocalInstallDatabase;
  async load() { return this.value; }
  async save(value: LocalInstallDatabase) { this.value = structuredClone(value); }
  async delete() { this.value = undefined; }
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "fentaris-install-"));
  temporary.push(created);
  return realpath(created);
}

const plan = (overrides: { version?: string; integrity?: string; bin?: string } = {}) => edge.npm({
  package: "@scope/server",
  version: overrides.version ?? "1.4.2",
  bin: overrides.bin ?? "scope-server",
  ...(overrides.integrity ? { integrity: overrides.integrity } : {}),
});

function requirement(options: Parameters<typeof plan>[0] = {}, deploymentId = "filesystem"): DesiredSetupRequirement {
  const schema = createSetupSchema({}, 1);
  return {
    deploymentId,
    desiredStateVersion: 1,
    schema,
    recipe: compileLaunchRecipe({ command: options.bin ?? "scope-server", args: ["--stdio"], install: plan(options) }, schema),
  };
}

/**
 * Materializes a package tree the way the package manager would, so installer
 * tests stay hermetic and never touch a registry.
 */
class FakeRunner implements EdgeInstallCommandRunner {
  readonly calls: EdgeInstallCommandInput[] = [];
  installedVersion?: string;
  integrity?: string;
  binName?: string;
  binTarget?: string;
  exitCode = 0;
  timedOut = false;

  constructor(private readonly defaults: { version: string; bin: string }) {}

  async run(input: EdgeInstallCommandInput) {
    this.calls.push(input);
    if (this.timedOut) return { exitCode: null, timedOut: true };
    if (this.exitCode !== 0) return { exitCode: this.exitCode };
    const packageDirectory = path.join(input.cwd, "node_modules", "@scope", "server");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@scope/server", version: this.installedVersion ?? this.defaults.version }),
    );
    const binDirectory = path.join(input.cwd, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    const binPath = path.join(binDirectory, this.binName ?? this.defaults.bin);
    if (this.binTarget) await symlink(this.binTarget, binPath);
    else await writeFile(binPath, "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(
      path.join(input.cwd, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/@scope/server": { integrity: this.integrity ?? "sha512-recorded==" } } }),
    );
    return { exitCode: 0 };
  }
}

async function fixture(options: {
  allowInstall?: (plan: { package: string }) => boolean;
  maxAttempts?: number;
  retryBackoffMs?: number;
  now?: () => number;
} = {}) {
  const installRoot = path.join(await root(), "installs");
  const store = new MemoryStore();
  const runner = new FakeRunner({ version: "1.4.2", bin: "scope-server" });
  const manager = new ManagedInstallManager({
    store,
    root: installRoot,
    runner,
    allowInstall: options.allowInstall,
    maxAttempts: options.maxAttempts ?? 3,
    retryBackoffMs: options.retryBackoffMs ?? 1_000,
    now: options.now,
    stagingId: (() => {
      let next = 0;
      return () => `staging-${++next}`;
    })(),
  });
  return { installRoot, store, runner, manager };
}

describe("ManagedInstallManager", () => {
  it("installs a pinned package once, verifies it, and resolves a contained bin", async () => {
    const { manager, runner, installRoot } = await fixture();
    const desired = requirement();

    const state = await manager.ensure(desired);
    expect(state).toMatchObject({
      status: "installed",
      packageId: "@scope/server@1.4.2",
      packageVersion: "1.4.2",
      resolvedVersion: "1.4.2",
      attempts: 1,
    });
    const command = await manager.resolveCommand(desired);
    expect(command.startsWith(path.join(installRoot, "packages"))).toBe(true);
    expect(path.basename(command)).toBe("scope-server");

    await expect(manager.ensure(desired)).resolves.toMatchObject({ status: "installed", attempts: 1 });
    expect(runner.calls).toHaveLength(1);
    await expect(manager.summary()).resolves.toEqual({
      installedPackages: 1,
      pendingInstalls: 0,
      failedInstalls: 0,
    });
  });

  it("installs with lifecycle scripts disabled, an owned cache, and the pinned coordinates", async () => {
    const { manager, runner, installRoot } = await fixture();
    await manager.ensure(requirement());
    const [call] = runner.calls;
    expect(call.command).toBe("npm");
    expect(call.args).toEqual([
      "install",
      "@scope/server@1.4.2",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ]);
    expect(call.env.npm_config_cache).toBe(path.join(installRoot, "cache"));
    expect(call.env.npm_config_ignore_scripts).toBe("true");
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.cwd.includes(".staging")).toBe(true);
  });

  it("passes a declared registry to the package manager", async () => {
    const { manager, runner } = await fixture();
    const schema = createSetupSchema({}, 1);
    await manager.ensure({
      deploymentId: "filesystem",
      desiredStateVersion: 1,
      schema,
      recipe: compileLaunchRecipe({
        command: "scope-server",
        install: edge.npm({ package: "@scope/server", version: "1.4.2", bin: "scope-server", registryUrl: "https://npm.example.com" }),
      }, schema),
    });
    expect(runner.calls[0]?.args).toContain("--registry=https://npm.example.com");
  });

  it("denies unapproved packages before any fetch", async () => {
    const allowInstall = vi.fn(() => false);
    const { manager, runner } = await fixture({ allowInstall });
    await expect(manager.ensure(requirement())).resolves.toMatchObject({
      status: "denied",
      reasonCategory: "install-denied",
    });
    expect(runner.calls).toHaveLength(0);
    expect(allowInstall).toHaveBeenCalledWith(expect.objectContaining({ package: "@scope/server" }));
    await expect(manager.resolveCommand(requirement())).rejects.toMatchObject({ code: "EDGE_SETUP_REQUIRED" });
  });

  it("keeps the executable allowlist policy as the source of install approval", () => {
    const policy = new ExecutableAllowlistPolicy({ packages: ["@scope/server"] });
    expect(policy.allowInstall(plan())).toBe(true);
    expect(policy.allowInstall(edge.npm({ package: "other", version: "1.0.0" }))).toBe(false);
    expect(new ExecutableAllowlistPolicy({}).allowInstall(plan())).toBe(false);
    expect(policy.allow({
      deploymentId: "filesystem",
      recipeDigest: "sha256:0",
      command: "/managed/node_modules/.bin/scope-server",
      args: [],
      env: {},
      install: plan(),
    })).toBe(true);
  });

  it("rejects a version mismatch and never promotes the staged tree", async () => {
    const { manager, runner, installRoot } = await fixture();
    runner.installedVersion = "9.9.9";
    await expect(manager.ensure(requirement())).resolves.toMatchObject({
      status: "failed",
      reasonCategory: "install-verification-failed",
    });
    await expect(readdir(path.join(installRoot, "packages"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(installRoot, ".staging"))).resolves.toEqual([]);
  });

  it("rejects an integrity mismatch and accepts a matching digest", async () => {
    const { manager, runner } = await fixture();
    runner.integrity = "sha512-other==";
    await expect(manager.ensure(requirement({ integrity: "sha512-expected==" }))).resolves.toMatchObject({
      status: "failed",
      reasonCategory: "install-verification-failed",
    });

    const matching = await fixture();
    matching.runner.integrity = "sha512-expected==";
    await expect(matching.manager.ensure(requirement({ integrity: "sha512-expected==" }))).resolves.toMatchObject({
      status: "installed",
    });
  });

  it("rejects a missing bin and a bin that escapes the install directory", async () => {
    const missing = await fixture();
    missing.runner.binName = "other-bin";
    await expect(missing.manager.ensure(requirement())).resolves.toMatchObject({
      status: "failed",
      reasonCategory: "install-verification-failed",
    });

    const escaping = await fixture();
    const outside = path.join(await root(), "outside-bin");
    await writeFile(outside, "#!/bin/sh\n", { mode: 0o700 });
    escaping.runner.binTarget = outside;
    await expect(escaping.manager.ensure(requirement())).resolves.toMatchObject({
      status: "failed",
      reasonCategory: "install-verification-failed",
    });
  });

  it("records a failed install for a timeout or a non-zero exit", async () => {
    const timeout = await fixture();
    timeout.runner.timedOut = true;
    await expect(timeout.manager.ensure(requirement())).resolves.toMatchObject({
      status: "failed",
      reasonCategory: "install-failed",
    });

    const failure = await fixture();
    failure.runner.exitCode = 1;
    await expect(failure.manager.ensure(requirement())).resolves.toMatchObject({
      status: "failed",
      reasonCategory: "install-failed",
    });
    await expect(failure.manager.summary()).resolves.toMatchObject({ failedInstalls: 1 });
  });

  it("bounds retries with backoff and stops after the attempt budget", async () => {
    let clock = 0;
    const { manager, runner } = await fixture({ maxAttempts: 2, retryBackoffMs: 1_000, now: () => clock });
    runner.exitCode = 1;
    await expect(manager.ensure(requirement())).resolves.toMatchObject({ attempts: 1 });

    await expect(manager.ensure(requirement())).resolves.toMatchObject({ attempts: 1 });
    expect(runner.calls).toHaveLength(1);

    clock = 1_000;
    await expect(manager.ensure(requirement())).resolves.toMatchObject({ attempts: 2 });
    expect(runner.calls).toHaveLength(2);

    clock = 100_000;
    await expect(manager.ensure(requirement())).resolves.toMatchObject({ attempts: 2 });
    expect(runner.calls).toHaveLength(2);
  });

  it("adopts an existing verified install for another deployment without refetching", async () => {
    const { manager, runner } = await fixture();
    await manager.ensure(requirement({}, "first"));
    await expect(manager.ensure(requirement({}, "second"))).resolves.toMatchObject({ status: "installed" });
    expect(runner.calls).toHaveLength(1);
    await expect(manager.summary()).resolves.toMatchObject({ installedPackages: 1 });
  });

  it("reinstalls when the pinned version changes and prunes the superseded install", async () => {
    const { manager, runner, installRoot } = await fixture();
    await manager.ensure(requirement());
    runner.installedVersion = "1.5.0";
    await manager.ensure(requirement({ version: "1.5.0" }));
    expect(runner.calls).toHaveLength(2);
    await manager.prune(["filesystem"]);
    const directories = await readdir(path.join(installRoot, "packages"));
    expect(directories).toHaveLength(1);
    expect(directories[0]).toContain("1.5.0");
  });

  it("prunes installs and records that no desired deployment references", async () => {
    const { manager, store, installRoot } = await fixture();
    await manager.ensure(requirement());
    await mkdir(path.join(installRoot, "packages", "orphan"), { recursive: true });

    const removed = await manager.prune([]);
    expect(removed.length).toBeGreaterThanOrEqual(2);
    expect(store.value?.records).toEqual({});
    await expect(readdir(path.join(installRoot, "packages"))).resolves.toEqual([]);
  });

  it("forgets install state when a deployment stops declaring a managed install", async () => {
    const { manager, store } = await fixture();
    await manager.ensure(requirement());
    const schema = createSetupSchema({}, 1);
    await expect(manager.ensure({
      deploymentId: "filesystem",
      desiredStateVersion: 2,
      schema,
      recipe: compileLaunchRecipe({ command: "scope-server" }, schema),
    })).resolves.toBeUndefined();
    expect(store.value?.records).toEqual({});
  });

  it("clears every managed install and its state", async () => {
    const { manager, store, installRoot } = await fixture();
    await manager.ensure(requirement());
    await manager.clear();
    expect(store.value).toBeUndefined();
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to resolve a command for a deployment without a managed install", async () => {
    const { manager } = await fixture();
    const schema = createSetupSchema({}, 1);
    await expect(manager.resolveCommand({
      deploymentId: "filesystem",
      desiredStateVersion: 1,
      schema,
      recipe: compileLaunchRecipe({ command: "scope-server" }, schema),
    })).rejects.toMatchObject({ code: "EDGE_WORKLOAD" });
  });
});
