import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryInstallationMutationLock,
  computeInstallationDigest,
  edge,
  type InstallationDigest,
  type InstallationProviderAdapter,
} from "@fentaris/core";
import {
  BoundedInstallerRunner,
  InstallationConsentManager,
  InstallationCoordinator,
  InstallationExecutionError,
  ManagedInstallationSourceResolver,
  SharedInstallationProvider,
  ProtectedInstallationState,
  SecureTarExtractor,
  TerminalInstallationConsent,
  buildInstallationReview,
  redactInstallerText,
  type InstallationCommandExecutor,
  type InstallationStateDocument,
  type JsonStore,
} from "../src/index.js";

class MemoryStore<T> implements JsonStore<T> {
  value?: T;
  async load() { return this.value === undefined ? undefined : structuredClone(this.value); }
  async save(value: T) { this.value = structuredClone(value); }
  async delete() { this.value = undefined; }
}

const digest = (character: string): InstallationDigest => `sha256:${character.repeat(64)}`;

function recipe() {
  return edge.install.custom({
    source: { kind: "inline", filename: "install.js", content: "write managed output" },
    entrypoint: "install.js",
    interpreter: "node",
  }, {
    permissions: { network: "none" },
    verification: [{ kind: "executable", target: "bin/server" }],
    outputs: [{ name: "server", kind: "executable", path: "bin/server" }],
  });
}

describe("protected installation state and consent", () => {
  it("persists bounded attempts, lifecycle, artifacts, approvals, and active pointers", async () => {
    const backing = new MemoryStore<InstallationStateDocument>();
    const state = new ProtectedInstallationState(backing);
    const consent = new InstallationConsentManager(state, () => 10);
    const review = consent.review(recipe(), { network: "none" });
    await consent.decide(review, "approved");
    await state.putAttempt({ attemptId: "a1", deploymentId: "server", desiredVersion: 1, recipeDigest: recipe().digest, state: "failed", startedAt: 1, finishedAt: 2, retryable: true });
    await state.putLifecycle({ deploymentId: "server", desiredVersion: 1, recipeDigest: recipe().digest, launchDigest: digest("1"), state: "failed", readiness: "blocked", observedAt: 2 });
    await state.putArtifact({ recipeDigest: recipe().digest, root: "/managed/root", outputs: { server: "/managed/root/bin/server" }, verifiedAt: 2, active: false, references: 1 });
    await state.activate("server", { recipeDigest: recipe().digest, root: "/managed/root", outputs: { server: "/managed/root/bin/server" }, verifiedAt: 2, active: true, references: 1 }, 1);
    const snapshot = await state.snapshot();
    expect(snapshot.approvals[`${review.approvalDigest}:false`]?.decision).toBe("approved");
    expect(snapshot.activePointers.server).toBe(recipe().digest);
    expect((await state.attempts(recipe().digest))[0]?.attemptId).toBe("a1");
  });

  it("binds approval to the complete effective plan and separates cleanup approval", async () => {
    const state = new ProtectedInstallationState(new MemoryStore<InstallationStateDocument>());
    const consent = new InstallationConsentManager(state, () => 10);
    const first = buildInstallationReview(recipe(), { network: "none" });
    const changed = buildInstallationReview(recipe(), { network: "restricted" });
    expect(first.approvalDigest).not.toBe(changed.approvalDigest);
    expect(first.source).not.toHaveProperty("credentialRef");
    await consent.decide(first, "approved");
    expect((await consent.decision(first))?.decision).toBe("approved");
    expect(await consent.decision(first, true)).toBeUndefined();
    await consent.decide(first, "revoked");
    expect((await consent.decision(first))?.decision).toBe("revoked");
    await consent.decide(first, "approved", true);
    expect((await consent.decision(first, true))?.decision).toBe("approved");
  });

  it("presents the exact bounded review before terminal approval or denial", async () => {
    const state = new ProtectedInstallationState(new MemoryStore<InstallationStateDocument>());
    const consent = new InstallationConsentManager(state, () => 10);
    const present = vi.fn();
    const terminal = new TerminalInstallationConsent(consent, { present, confirm: async () => true });
    const decision = await terminal.reviewAndDecide(recipe(), { network: "none" });
    expect(present).toHaveBeenCalledWith(expect.objectContaining({
      recipeDigest: recipe().digest,
      entrypoint: "install.js",
      permissions: expect.objectContaining({ network: "none" }),
      verification: recipe().verification,
      cleanup: recipe().cleanup,
    }));
    expect(decision.decision).toBe("approved");
  });
});

describe("bounded installer runner", () => {
  it("uses an allowlisted environment, redacts output, and rejects elevation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-installer-runner-"));
    try {
      const runner = new BoundedInstallerRunner();
      const result = await runner.run({
        command: process.execPath,
        args: ["-e", "console.log(process.env.TEST_VALUE, process.env.SECRET_VALUE)"],
        cwd: directory,
        env: { TEST_VALUE: "visible", SECRET_VALUE: "protected" },
        secrets: ["protected"],
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
        maxDiskBytes: 1_024,
        allowedExecutables: [path.basename(process.execPath)],
      });
      expect(result.output).toContain("visible");
      expect(result.output).not.toContain("protected");
      await expect(runner.run({ command: "sudo", args: ["true"], cwd: directory, timeoutMs: 100, maxOutputBytes: 10, maxDiskBytes: 10 }))
        .rejects.toMatchObject({ reasonCode: "elevation-denied" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("fails closed for unavailable isolation and enforces timeout/output bounds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-installer-limits-"));
    try {
      const runner = new BoundedInstallerRunner();
      await expect(runner.run({ command: process.execPath, args: ["-e", "0"], cwd: directory, timeoutMs: 100, maxOutputBytes: 10, maxDiskBytes: 10, requireNetworkIsolation: true }))
        .rejects.toMatchObject({ reasonCode: "isolation-unavailable" });
      await expect(runner.run({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: directory, timeoutMs: 25, maxOutputBytes: 10, maxDiskBytes: 10 }))
        .rejects.toMatchObject({ reasonCode: "limit-exceeded" });
      await expect(runner.run({ command: process.execPath, args: ["-e", "console.log('too much output')"], cwd: directory, timeoutMs: 1_000, maxOutputBytes: 2, maxDiskBytes: 10 }))
        .rejects.toMatchObject({ reasonCode: "limit-exceeded" });
      await expect(runner.run({ command: process.execPath, args: ["-e", "require('fs').writeFileSync('large', 'x'.repeat(32))"], cwd: directory, timeoutMs: 1_000, maxOutputBytes: 100, maxDiskBytes: 2 }))
        .rejects.toMatchObject({ reasonCode: "limit-exceeded" });
      await expect(runner.run({ command: process.execPath, args: ["-e", "0"], cwd: directory, timeoutMs: 1_000, maxOutputBytes: 100, maxDiskBytes: 100, allowedExecutables: ["not-node"] }))
        .rejects.toMatchObject({ reasonCode: "elevation-denied" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("source resolution and integrity", () => {
  it("stages complete inline content and approved local content with exact identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-source-"));
    try {
      const inline = path.join(directory, "inline");
      const resolver = new ManagedInstallationSourceResolver();
      const resolved = await resolver.resolve({ kind: "inline", filename: "install.sh", content: "echo exact" }, inline);
      expect(await readFile(path.join(inline, "install.sh"), "utf8")).toBe("echo exact");
      expect(resolved.digest).toMatch(/^sha256:/);

      const localFile = path.join(directory, "local.txt");
      await writeFile(localFile, "local exact");
      const fileDigest = `sha256:${createHash("sha256").update("local exact").digest("hex")}` as InstallationDigest;
      const treeDigest = computeInstallationDigest([{ path: "local.txt", digest: fileDigest }]);
      const localResolver = new ManagedInstallationSourceResolver({ local: { resolve: async () => localFile } });
      await expect(localResolver.resolve({ kind: "local", grantRef: "grant-1", integrity: treeDigest }, path.join(directory, "local-stage"))).resolves.toMatchObject({ digest: treeDigest });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects archive traversal, symlink/special entries, and integrity mismatch", async () => {
    const commands: InstallationCommandExecutor = { run: vi.fn(async () => "-rw-r--r-- user group 1 Jan 1 00:00 ../escape") };
    await expect(new SecureTarExtractor(commands).extract("archive.tar", await mkdtemp(path.join(tmpdir(), "fentaris-tar-"))))
      .rejects.toBeInstanceOf(InstallationExecutionError);
  });

  it("rejects archive digest mismatch, local symlinks, Git submodules, and hides private credentials", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-source-security-"));
    try {
      const downloader = { download: vi.fn(async (_url: string, destination: string, credential?: string) => {
        expect(credential).toBe("private-value");
        await writeFile(destination, "wrong archive");
      }) };
      const credentials = { get: vi.fn(async () => "private-value"), set: vi.fn(), delete: vi.fn() };
      const resolver = new ManagedInstallationSourceResolver({ downloader, credentials });
      await expect(resolver.resolve({ kind: "archive", url: "https://example.com/tool.tar", integrity: digest("f"), credentialRef: "source-token" }, path.join(directory, "archive")))
        .rejects.toMatchObject({ reasonCode: "source-integrity-failed" });

      const target = path.join(directory, "target");
      const link = path.join(directory, "link");
      await writeFile(target, "value");
      await symlink(target, link);
      const localResolver = new ManagedInstallationSourceResolver({ local: { resolve: async () => link } });
      await expect(localResolver.resolve({ kind: "local", grantRef: "grant", integrity: digest("e") }, path.join(directory, "local")))
        .rejects.toMatchObject({ reasonCode: "source-integrity-failed" });

      const commands: InstallationCommandExecutor = { run: vi.fn(async (command, args, options) => {
        expect(args.join(" ")).not.toContain("private-value");
        if (args[0] === "checkout") await writeFile(path.join(options.cwd, ".gitmodules"), "[submodule]");
        if (args[0] === "rev-parse") return "a".repeat(40);
        return "";
      }) };
      const gitResolver = new ManagedInstallationSourceResolver({ commands, credentials });
      await expect(gitResolver.resolve({ kind: "git", repository: "https://example.com/private.git", commit: "a".repeat(40), credentialRef: "source-token" }, path.join(directory, "git")))
        .rejects.toMatchObject({ reasonCode: "source-integrity-failed" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("redacts credentials, protected values, and private paths", () => {
    expect(redactInstallerText("Bearer abc token=xyz /Users/alice/private secret-value", ["secret-value"]))
      .toBe("Bearer [REDACTED] token=[REDACTED] [REDACTED_PATH] [REDACTED]");
  });
});

describe("installation coordinator", () => {
  it("provides a conforming adapter for every provider kind", async () => {
    const source = { resolve: vi.fn(async (_source, destination: string) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "server"), "server");
      return { root: destination, digest: digest("1") };
    }) };
    const runner = { run: vi.fn(async () => ({ code: 0, output: "[]", startedAt: 1, finishedAt: 2 })) };
    const verifier = { verify: vi.fn(async () => ({ server: "/managed/server" })) };
    for (const kind of ["custom", "node-package", "python", "binary", "container", "manual"] as const) {
      const provider = new SharedInstallationProvider(kind, source as never, runner as never, verifier);
      expect(provider.kind).toBe(kind);
      expect(typeof provider.preflight).toBe("function");
      expect(typeof provider.install).toBe("function");
      expect(typeof provider.verify).toBe("function");
      expect(typeof provider.cleanup).toBe("function");
    }
  });

  it("requires exact custom approval, installs once, verifies, activates, and replays idempotently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-coordinator-"));
    try {
      const state = new ProtectedInstallationState(new MemoryStore<InstallationStateDocument>());
      const consent = new InstallationConsentManager(state, () => 10);
      let installs = 0;
      const provider: InstallationProviderAdapter = {
        kind: "custom",
        preflight: async () => ({ ready: false }),
        install: async (context) => {
          installs += 1;
          await mkdir(path.join(context.installationRoot, "bin"), { recursive: true });
          await writeFile(path.join(context.installationRoot, "bin", "server"), "server");
          await chmod(path.join(context.installationRoot, "bin", "server"), 0o700);
        },
        verify: async (context) => ({ server: path.join(context.installationRoot, "bin", "server") }),
        cleanup: async () => undefined,
      };
      const coordinator = new InstallationCoordinator({
        state,
        consent,
        lock: new InMemoryInstallationMutationLock(),
        providers: new Map([["custom", provider]]),
        installationRoot: path.join(directory, "install"),
        stagingRoot: path.join(directory, "stage"),
        now: (() => { let value = 0; return () => ++value; })(),
        attemptId: () => "attempt-1",
      });
      const request = { deploymentId: "server", desiredVersion: 1, launchDigest: digest("1"), recipe: recipe(), localPolicy: { network: "none" } };
      expect((await coordinator.reconcile(request)).state).toBe("approval-required");
      const review = consent.review(request.recipe, request.localPolicy);
      await consent.decide(review, "approved");
      expect((await coordinator.reconcile(request)).state).toBe("installed");
      expect((await coordinator.reconcile(request)).state).toBe("installed");
      expect(installs).toBe(1);
      const artifact = await state.artifact(request.recipe.digest);
      expect(artifact?.active).toBe(true);
      expect((await coordinator.reconcile({ ...request, deploymentId: "server-2" })).state).toBe("installed");
      expect((await state.artifact(request.recipe.digest))?.references).toBe(2);
      await coordinator.remove("server", request.recipe);
      expect(await state.artifact(request.recipe.digest)).toMatchObject({ active: true, references: 1 });
      await coordinator.remove("server-2", request.recipe);
      expect(await state.artifact(request.recipe.digest)).toMatchObject({ active: false, references: 0 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves failed attempts, creates a new explicit retry, and marks crashes interrupted", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-retry-"));
    try {
      const state = new ProtectedInstallationState(new MemoryStore<InstallationStateDocument>());
      const consent = new InstallationConsentManager(state);
      const provider: InstallationProviderAdapter = {
        kind: "custom",
        preflight: async () => ({ ready: false }),
        install: vi.fn(async () => { throw new Error("token=secret /Users/alice/private"); }),
        verify: async () => ({}),
        cleanup: async () => undefined,
      };
      let id = 0;
      const coordinator = new InstallationCoordinator({ state, consent, lock: new InMemoryInstallationMutationLock(), providers: new Map([["custom", provider]]), installationRoot: path.join(directory, "install"), stagingRoot: path.join(directory, "stage"), attemptId: () => `attempt-${++id}` });
      const request = { deploymentId: "server", desiredVersion: 1, launchDigest: digest("1"), recipe: recipe(), localPolicy: {} };
      const review = consent.review(request.recipe, {});
      await consent.decide(review, "approved");
      expect((await coordinator.reconcile(request)).state).toBe("failed");
      expect((await coordinator.reconcile(request)).state).toBe("failed");
      expect((await coordinator.reconcile({ ...request, explicitRetry: true })).state).toBe("failed");
      expect(await state.attempts(request.recipe.digest)).toHaveLength(2);
      await state.putAttempt({ attemptId: "orphan", deploymentId: "server", desiredVersion: 1, recipeDigest: request.recipe.digest, state: "installing", startedAt: 1, retryable: false, processIds: [999_999] });
      const terminate = vi.fn(async () => undefined);
      const recovery = new InstallationCoordinator({ state, consent, lock: new InMemoryInstallationMutationLock(), providers: new Map(), installationRoot: path.join(directory, "install"), stagingRoot: path.join(directory, "stage"), terminateProcess: terminate });
      expect(await recovery.recoverInterrupted()).toHaveLength(1);
      expect(terminate).toHaveBeenCalledWith(999_999);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
