import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  computeInstallationDigest,
  edgeError,
  installationApprovalDigest,
  normalizeInstallationReadiness,
  validateInstallationRecipe,
  type InstallationApprovalRecord,
  type InstallationArtifactRecord,
  type InstallationAttemptSummary,
  type InstallationDigest,
  type InstallationLifecycleSummary,
  type InstallationMutationLock,
  type InstallationProviderAdapter,
  type InstallationProviderContext,
  type InstallationProviderKind,
  type InstallationReasonCode,
  type InstallationRecipe,
  type InstallationResolvedSource,
  type InstallationSource,
  type InstallationVerification,
  type InstalledArtifactReference,
} from "@fentaris/core";
import type { CredentialStore, JsonStore } from "./platform.js";
import { redactInstallerText } from "./redaction.js";

export interface DurableInstallationAttempt extends InstallationAttemptSummary {
  readonly deploymentId: string;
  readonly desiredVersion: number;
  readonly processIds?: readonly number[];
  readonly diagnostics?: readonly string[];
}

export interface InstallationStateDocument {
  readonly schemaVersion: 1;
  readonly attempts: Readonly<Record<string, DurableInstallationAttempt>>;
  readonly approvals: Readonly<Record<string, InstallationApprovalRecord>>;
  readonly lifecycle: Readonly<Record<string, InstallationLifecycleSummary>>;
  readonly artifacts: Readonly<Record<string, InstallationArtifactRecord>>;
  readonly activePointers: Readonly<Record<string, InstallationDigest>>;
  readonly retentionReferences: Readonly<Record<string, readonly InstallationDigest[]>>;
}

const emptyDocument = (): InstallationStateDocument => ({
  schemaVersion: 1,
  attempts: {},
  approvals: {},
  lifecycle: {},
  artifacts: {},
  activePointers: {},
  retentionReferences: {},
});

/** Protected durable installation state persisted atomically by the platform store. */
export class ProtectedInstallationState {
  private queue = Promise.resolve();
  constructor(private readonly store: JsonStore<InstallationStateDocument>) {}

  async snapshot(): Promise<InstallationStateDocument> {
    return structuredClone(await this.store.load() ?? emptyDocument());
  }

  async update<T>(mutation: (document: InstallationStateDocument) => readonly [InstallationStateDocument, T]): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const [next, value] = mutation(await this.snapshot());
      await this.store.save(next);
      result = value;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  putAttempt(attempt: DurableInstallationAttempt): Promise<void> {
    return this.update((document) => [{ ...document, attempts: { ...document.attempts, [attempt.attemptId]: freeze(attempt) } }, undefined]);
  }

  putApproval(approval: InstallationApprovalRecord): Promise<void> {
    return this.update((document) => [{ ...document, approvals: { ...document.approvals, [approvalKey(approval.approvalDigest, approval.cleanup)]: freeze(approval) } }, undefined]);
  }

  putLifecycle(value: InstallationLifecycleSummary): Promise<void> {
    return this.update((document) => {
      const current = document.lifecycle[value.deploymentId];
      if (current && (value.desiredVersion < current.desiredVersion
        || (value.desiredVersion === current.desiredVersion && value.recipeDigest !== current.recipeDigest)
        || value.observedAt < current.observedAt)) {
        throw edgeError("EDGE_PROTOCOL", "Installation lifecycle update is stale.");
      }
      return [{ ...document, lifecycle: { ...document.lifecycle, [value.deploymentId]: freeze(value) } }, undefined];
    });
  }

  putArtifact(value: InstallationArtifactRecord): Promise<void> {
    return this.update((document) => [{ ...document, artifacts: { ...document.artifacts, [value.recipeDigest]: freeze(value) } }, undefined]);
  }

  async approval(digest: InstallationDigest, cleanup = false): Promise<InstallationApprovalRecord | undefined> {
    return (await this.snapshot()).approvals[approvalKey(digest, cleanup)];
  }

  async lifecycle(deploymentId: string): Promise<InstallationLifecycleSummary | undefined> {
    return (await this.snapshot()).lifecycle[deploymentId];
  }

  async artifact(digest: InstallationDigest): Promise<InstallationArtifactRecord | undefined> {
    return (await this.snapshot()).artifacts[digest];
  }

  async attempts(digest: InstallationDigest): Promise<readonly DurableInstallationAttempt[]> {
    return Object.values((await this.snapshot()).attempts)
      .filter((attempt) => attempt.recipeDigest === digest)
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  async activate(deploymentId: string, artifact: InstallationArtifactRecord, retain: number): Promise<void> {
    await this.update((document) => {
      const previous = document.activePointers[deploymentId];
      const retained = [previous, ...(document.retentionReferences[deploymentId] ?? [])]
        .filter((digest): digest is InstallationDigest => digest !== undefined && digest !== artifact.recipeDigest)
        .slice(0, retain);
      const artifacts = { ...document.artifacts };
      if (previous && previous !== artifact.recipeDigest && artifacts[previous]) {
        const references = Math.max(0, artifacts[previous]!.references - 1);
        artifacts[previous] = { ...artifacts[previous]!, active: references > 0, references };
      }
      artifacts[artifact.recipeDigest] = { ...artifact, active: true };
      return [{
        ...document,
        artifacts,
        activePointers: { ...document.activePointers, [deploymentId]: artifact.recipeDigest },
        retentionReferences: { ...document.retentionReferences, [deploymentId]: retained },
      }, undefined];
    });
  }

  async removeReference(deploymentId: string, digest: InstallationDigest): Promise<InstallationArtifactRecord | undefined> {
    return this.update((document) => {
      const current = document.artifacts[digest];
      if (!current) return [document, undefined];
      const references = Math.max(0, current.references - 1);
      const artifact = { ...current, active: references > 0, references };
      const activePointers = { ...document.activePointers };
      delete activePointers[deploymentId];
      return [{ ...document, artifacts: { ...document.artifacts, [digest]: artifact }, activePointers }, artifact];
    });
  }

  async rollbackCandidate(deploymentId: string): Promise<InstallationArtifactRecord | undefined> {
    const document = await this.snapshot();
    const digest = document.retentionReferences[deploymentId]?.[0];
    return digest ? document.artifacts[digest] : undefined;
  }

  clear(): Promise<void> { return this.store.delete(); }
}

export interface InstallationReviewModel {
  readonly approvalDigest: InstallationDigest;
  readonly recipeDigest: InstallationDigest;
  readonly provider: InstallationProviderKind;
  readonly providerDetails: Readonly<Record<string, unknown>>;
  readonly source?: Readonly<Record<string, unknown>>;
  readonly entrypoint?: string;
  readonly interpreter?: string;
  readonly arguments: readonly string[];
  readonly permissions: InstallationRecipe["permissions"];
  readonly outputs: InstallationRecipe["outputs"];
  readonly verification: InstallationRecipe["verification"];
  readonly cleanup: InstallationRecipe["cleanup"];
}

/** Build exact bounded custom-install review material without credential values. */
export function buildInstallationReview(recipe: InstallationRecipe, localPolicy: unknown): InstallationReviewModel {
  const provider = recipe.provider;
  const source = provider.kind === "custom" ? sanitizeSource(provider.source) : undefined;
  return freeze({
    approvalDigest: installationApprovalDigest(recipe, localPolicy),
    recipeDigest: recipe.digest,
    provider: provider.kind,
    providerDetails: sanitizeProvider(provider),
    ...(source ? { source } : {}),
    ...(provider.kind === "custom" ? { entrypoint: provider.entrypoint, interpreter: provider.interpreter } : {}),
    arguments: provider.kind === "custom" ? [...(provider.args ?? [])] : [],
    permissions: recipe.permissions,
    outputs: recipe.outputs,
    verification: recipe.verification,
    cleanup: recipe.cleanup,
  });
}

export class InstallationConsentManager {
  constructor(private readonly state: ProtectedInstallationState, private readonly now: () => number = Date.now) {}
  review(recipe: InstallationRecipe, localPolicy: unknown): InstallationReviewModel { return buildInstallationReview(recipe, localPolicy); }
  async decide(review: InstallationReviewModel, decision: "approved" | "denied" | "revoked", cleanup = false): Promise<void> {
    await this.state.putApproval({ approvalDigest: review.approvalDigest, recipeDigest: review.recipeDigest, decision, cleanup, decidedAt: this.now() });
  }
  async decision(review: InstallationReviewModel, cleanup = false) { return this.state.approval(review.approvalDigest, cleanup); }
}

export interface InstallationReviewPrompter {
  present(review: InstallationReviewModel): void | Promise<void>;
  confirm(message: string): Promise<boolean>;
}

/** Interactive local approval flow that presents the complete bounded review. */
export class TerminalInstallationConsent {
  constructor(private readonly consent: InstallationConsentManager, private readonly prompt: InstallationReviewPrompter) {}
  async reviewAndDecide(recipe: InstallationRecipe, localPolicy: unknown, cleanup = false): Promise<InstallationApprovalRecord> {
    const review = this.consent.review(recipe, cleanup ? { localPolicy, cleanup: true } : localPolicy);
    await this.prompt.present(review);
    const approved = await this.prompt.confirm(cleanup
      ? `Approve custom cleanup ${review.approvalDigest}?`
      : `Approve custom installation ${review.approvalDigest}?`);
    await this.consent.decide(review, approved ? "approved" : "denied", cleanup);
    return (await this.consent.decision(review, cleanup))!;
  }
}

export interface InstallationIsolationAdapter {
  readonly filesystem: boolean;
  readonly network: boolean;
  wrap(input: InstallerRunRequest): Promise<InstallerRunRequest>;
}

/** Build an enforceable platform adapter when an approved sandbox command is configured. */
export function commandIsolationAdapter(options: {
  readonly platform?: NodeJS.Platform;
  readonly executable?: string;
} = {}): InstallationIsolationAdapter {
  const platform = options.platform ?? process.platform;
  const executable = options.executable;
  if (!executable) return noIsolationAdapter;
  if (platform === "linux") return {
    filesystem: true,
    network: true,
    wrap: async (input) => ({
      ...input,
      command: executable,
      args: ["--die-with-parent", "--unshare-all", "--new-session", "--bind", input.cwd, input.cwd, "--chdir", input.cwd, input.command, ...(input.args ?? [])],
    }),
  };
  if (platform === "darwin") return {
    filesystem: true,
    network: true,
    wrap: async (input) => ({
      ...input,
      command: executable,
      args: ["-p", `(version 1) (deny default) (allow process*) (allow file-read*) (allow file-write* (subpath "${escapeSandbox(input.cwd)}"))${input.requireNetworkIsolation ? "" : " (allow network*)"}`, input.command, ...(input.args ?? [])],
    }),
  };
  return noIsolationAdapter;
}

export interface InstallerRunRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly secrets?: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxDiskBytes: number;
  readonly allowedExecutables?: readonly string[];
  readonly requireFilesystemIsolation?: boolean;
  readonly requireNetworkIsolation?: boolean;
}

export interface InstallerRunResult {
  readonly code: number;
  readonly output: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly pid?: number;
}

/** Process-tree supervised, bounded, no-elevation installer execution. */
export class BoundedInstallerRunner {
  constructor(
    private readonly isolation: InstallationIsolationAdapter = noIsolationAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  async run(input: InstallerRunRequest): Promise<InstallerRunResult> {
    denyElevation(input.command, input.args ?? []);
    if (input.allowedExecutables && !input.allowedExecutables.includes(path.basename(input.command))) {
      throw installationFailure("elevation-denied", "Installer executable is not allowed by local policy.");
    }
    if ((input.requireFilesystemIsolation && !this.isolation.filesystem) || (input.requireNetworkIsolation && !this.isolation.network)) {
      throw installationFailure("isolation-unavailable", "Required installer isolation is unavailable on this platform.");
    }
    const wrapped = await this.isolation.wrap(input);
    await mkdir(wrapped.cwd, { recursive: true, mode: 0o700 });
    const startedAt = this.now();
    return new Promise<InstallerRunResult>((resolve, reject) => {
      const child = spawn(wrapped.command, [...(wrapped.args ?? [])], {
        cwd: wrapped.cwd,
        env: allowlistedEnvironment(wrapped.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let bytes = 0;
      let output = "";
      let settled = false;
      const terminate = () => terminateTree(child.pid);
      const timer = setTimeout(() => {
        terminate();
        finishError(installationFailure("limit-exceeded", "Installer timed out."));
      }, wrapped.timeoutMs);
      const finishError = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const collect = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > wrapped.maxOutputBytes) {
          terminate();
          finishError(installationFailure("limit-exceeded", "Installer output limit exceeded."));
          return;
        }
        output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", finishError);
      child.once("exit", async (code) => {
        if (settled) return;
        try {
          if (await directoryBytes(wrapped.cwd) > wrapped.maxDiskBytes) throw installationFailure("limit-exceeded", "Installer disk limit exceeded.");
          const sanitized = redactInstallerText(output, wrapped.secrets ?? []);
          if (code !== 0) throw installationFailure("installation-failed", `Installer exited with code ${code ?? -1}: ${sanitized}`);
          settled = true;
          clearTimeout(timer);
          resolve({ code: 0, output: sanitized, startedAt, finishedAt: this.now(), ...(child.pid ? { pid: child.pid } : {}) });
        } catch (error) { finishError(error); }
      });
    });
  }
}

export interface InstallationCommandExecutor {
  run(command: string, args: readonly string[], options: { cwd: string; env?: Readonly<Record<string, string>> }): Promise<string>;
}

export class NodeInstallationCommandExecutor implements InstallationCommandExecutor {
  constructor(private readonly runner = new BoundedInstallerRunner()) {}
  async run(command: string, args: readonly string[], options: { cwd: string; env?: Readonly<Record<string, string>> }): Promise<string> {
    return (await this.runner.run({ command, args, cwd: options.cwd, env: options.env, timeoutMs: 300_000, maxOutputBytes: 1_048_576, maxDiskBytes: 1_073_741_824 })).output;
  }
}

export interface InstallationDownloadAdapter {
  download(url: string, destination: string, credential?: string, maxBytes?: number): Promise<void>;
}

export class FetchInstallationDownloader implements InstallationDownloadAdapter {
  async download(url: string, destination: string, credential?: string, maxBytes = 536_870_912): Promise<void> {
    const response = await fetch(url, { redirect: "error", headers: credential ? { authorization: `Bearer ${credential}` } : {} });
    if (!response.ok || !response.body) throw installationFailure("source-unavailable", `Archive download failed with status ${response.status}.`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw installationFailure("limit-exceeded", "Archive exceeds the source size limit.");
    const handle = await open(destination, "wx", 0o600);
    let total = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) throw installationFailure("limit-exceeded", "Archive exceeds the source size limit.");
        await handle.write(chunk);
      }
    } finally { await handle.close(); }
  }
}

/** Tar archive extraction with preflight type/path checks and post-extract containment. */
export class SecureTarExtractor {
  constructor(private readonly commands: InstallationCommandExecutor = new NodeInstallationCommandExecutor()) {}
  async extract(archive: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const listing = await this.commands.run("tar", ["-tvf", archive], { cwd: destination });
    for (const line of listing.split("\n").filter(Boolean)) {
      const type = line[0];
      if (type !== "-" && type !== "d") throw installationFailure("source-integrity-failed", "Archive contains links or special files.");
      const name = line.trim().split(/\s+/).at(-1) ?? "";
      assertContainedRelative(name, "archive entry");
    }
    await this.commands.run("tar", ["-xf", archive, "--no-same-owner", "--no-same-permissions", "-C", destination], { cwd: destination });
    await assertTreeSafe(destination);
  }
}

export interface LocalInstallationGrantResolver {
  resolve(grantRef: string): Promise<string>;
}

export interface EnterpriseInstallationResolver {
  readonly adapter: string;
  resolve(artifactRef: string, destination: string, credential?: string): Promise<void>;
}

/** Immutable Git/archive/inline/local/enterprise staging implementation. */
export class ManagedInstallationSourceResolver {
  constructor(private readonly options: {
    readonly commands?: InstallationCommandExecutor;
    readonly downloader?: InstallationDownloadAdapter;
    readonly extractor?: SecureTarExtractor;
    readonly credentials?: CredentialStore;
    readonly local?: LocalInstallationGrantResolver;
    readonly enterprise?: readonly EnterpriseInstallationResolver[];
  } = {}) {}

  async resolve(source: InstallationSource, destination: string): Promise<InstallationResolvedSource> {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    if (source.kind === "git") await this.git(source, destination);
    else if (source.kind === "archive") await this.archive(source, destination);
    else if (source.kind === "inline") await this.inline(source, destination);
    else if (source.kind === "local") await this.local(source, destination);
    else await this.enterprise(source, destination);
    const digest = await hashTree(destination);
    const expected = source.kind === "local" || source.kind === "enterprise" ? source.integrity : undefined;
    if (expected && digest !== expected) {
      await rm(destination, { recursive: true, force: true });
      throw installationFailure("source-integrity-failed", "Resolved source digest does not match the recipe.");
    }
    return { root: destination, digest };
  }

  private async git(source: Extract<InstallationSource, { kind: "git" }>, destination: string): Promise<void> {
    const commands = this.options.commands ?? new NodeInstallationCommandExecutor();
    const credential = source.credentialRef ? await this.options.credentials?.get(source.credentialRef) : undefined;
    if (source.credentialRef && !credential) throw installationFailure("source-credential-required", "Private Git source credential is unavailable locally.");
    const askpass = path.join(destination, process.platform === "win32" ? ".fentaris-askpass.cmd" : ".fentaris-askpass");
    if (credential) {
      const contents = process.platform === "win32"
        ? "@echo off\r\necho %FENTARIS_SOURCE_CREDENTIAL%\r\n"
        : "#!/bin/sh\nprintf '%s\\n' \"$FENTARIS_SOURCE_CREDENTIAL\"\n";
      await writeFile(askpass, contents, { encoding: "utf8", mode: 0o700 });
      await chmod(askpass, 0o700).catch(() => undefined);
    }
    const env: Readonly<Record<string, string>> = credential ? {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpass,
      GIT_ASKPASS_REQUIRE: "force",
      FENTARIS_SOURCE_CREDENTIAL: credential,
    } : { GIT_TERMINAL_PROMPT: "0" };
    await commands.run("git", ["init", "--quiet"], { cwd: destination });
    await commands.run("git", ["remote", "add", "origin", source.repository], { cwd: destination });
    try {
      await commands.run("git", ["fetch", "--depth", "1", "origin", source.commit], { cwd: destination, env });
    } finally { await rm(askpass, { force: true }); }
    await commands.run("git", ["checkout", "--detach", "--quiet", "FETCH_HEAD"], { cwd: destination });
    const actual = (await commands.run("git", ["rev-parse", "HEAD"], { cwd: destination })).trim();
    if (actual !== source.commit) throw installationFailure("source-integrity-failed", "Git checkout did not resolve to the exact requested commit.");
    const gitmodules = path.join(destination, ".gitmodules");
    if (await exists(gitmodules)) throw installationFailure("source-integrity-failed", "Git submodules are disabled by the bounded source policy.");
    await rm(path.join(destination, ".git"), { recursive: true, force: true });
  }

  private async archive(source: Extract<InstallationSource, { kind: "archive" }>, destination: string): Promise<void> {
    const archive = `${destination}.archive`;
    const credential = source.credentialRef ? await this.options.credentials?.get(source.credentialRef) : undefined;
    if (source.credentialRef && !credential) throw installationFailure("source-credential-required", "Private source credential is unavailable locally.");
    try {
      await (this.options.downloader ?? new FetchInstallationDownloader()).download(source.url, archive, credential, source.maxBytes);
      if (await hashFile(archive) !== source.integrity) throw installationFailure("source-integrity-failed", "Archive digest mismatch.");
      await (this.options.extractor ?? new SecureTarExtractor()).extract(archive, destination);
    } finally { await rm(archive, { force: true }); }
  }

  private async inline(source: Extract<InstallationSource, { kind: "inline" }>, destination: string): Promise<void> {
    const filename = source.filename ?? "installer";
    assertContainedRelative(filename, "inline filename");
    await writeFile(path.join(destination, filename), source.content, { encoding: "utf8", mode: 0o700 });
  }

  private async local(source: Extract<InstallationSource, { kind: "local" }>, destination: string): Promise<void> {
    const granted = await this.options.local?.resolve(source.grantRef);
    if (!granted) throw installationFailure("source-unavailable", "Approved local source grant is unavailable.");
    const info = await lstat(granted);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw installationFailure("source-integrity-failed", "Local source is a link or special file.");
    if (info.isDirectory()) await cp(granted, destination, { recursive: true, dereference: false, errorOnExist: false });
    else await copyFile(granted, path.join(destination, path.basename(granted)));
    await assertTreeSafe(destination);
  }

  private async enterprise(source: Extract<InstallationSource, { kind: "enterprise" }>, destination: string): Promise<void> {
    const adapter = this.options.enterprise?.find((candidate) => candidate.adapter === source.adapter);
    if (!adapter) throw installationFailure("source-unavailable", "Enterprise source adapter is unavailable.");
    const credential = source.credentialRef ? await this.options.credentials?.get(source.credentialRef) : undefined;
    if (source.credentialRef && !credential) throw installationFailure("source-credential-required", "Enterprise source credential is unavailable locally.");
    await adapter.resolve(source.artifactRef, destination, credential);
    await assertTreeSafe(destination);
  }
}

export interface InstallationVerificationService {
  verify(recipe: InstallationRecipe, root: string): Promise<Readonly<Record<string, string>>>;
}

export class NodeInstallationVerificationService implements InstallationVerificationService {
  async verify(recipe: InstallationRecipe, root: string): Promise<Readonly<Record<string, string>>> {
    const canonicalRoot = await realpath(root);
    const outputs: Record<string, string> = {};
    for (const output of recipe.outputs) {
      const candidate = await containedPath(canonicalRoot, output.path);
      const info = await stat(candidate);
      if (output.kind === "directory" ? !info.isDirectory() : !info.isFile()) throw installationFailure("verification-failed", `Declared output ${output.name} has the wrong type.`);
      if (output.kind === "executable" && process.platform !== "win32" && (info.mode & 0o111) === 0) throw installationFailure("verification-failed", `Declared output ${output.name} is not executable.`);
      outputs[output.name] = candidate;
    }
    for (const verification of recipe.verification) await verifyOne(verification, canonicalRoot);
    return freeze(outputs);
  }
}

export class SharedInstallationProvider implements InstallationProviderAdapter {
  constructor(
    readonly kind: InstallationProviderKind,
    private readonly source: ManagedInstallationSourceResolver,
    private readonly runner: BoundedInstallerRunner,
    private readonly verifier: InstallationVerificationService = new NodeInstallationVerificationService(),
  ) {}

  async preflight(context: InstallationProviderContext) {
    if (context.recipe.provider.kind === "manual") {
      const detect = context.recipe.provider.detect;
      try {
        await this.runner.run(runRequest(context.recipe, detect.target, detect.args ?? [], context.stagingRoot));
        return { ready: true };
      }
      catch { return { ready: false, reasonCode: "manual-prerequisite-required" as const }; }
    }
    return { ready: await exists(context.installationRoot) };
  }

  async install(context: InstallationProviderContext): Promise<void> {
    const provider = context.recipe.provider;
    await mkdir(context.installationRoot, { recursive: true, mode: 0o700 });
    if (provider.kind === "custom") {
      const staged = await this.source.resolve(provider.source, context.stagingRoot);
      const entrypoint = await containedPath(staged.root, provider.entrypoint);
      const command = interpreterCommand(provider.interpreter, entrypoint);
      const args = provider.interpreter === "executable" ? [...(provider.args ?? [])] : [entrypoint, ...(provider.args ?? [])];
      await this.runner.run(runRequest(context.recipe, command, args, staged.root));
      await cp(staged.root, context.installationRoot, { recursive: true, force: true });
      return;
    }
    if (provider.kind === "binary") {
      const staged = await this.source.resolve(provider.source, context.stagingRoot);
      await cp(staged.root, context.installationRoot, { recursive: true, force: true });
      return;
    }
    if (provider.kind === "node-package") {
      const spec = `${provider.package}@${provider.version}`;
      await mkdir(context.stagingRoot, { recursive: true, mode: 0o700 });
      const packed = await this.runner.run(runRequest(context.recipe, "npm", ["pack", "--json", "--pack-destination", context.stagingRoot, spec], context.stagingRoot));
      const metadata = JSON.parse(packed.output) as Array<{ filename?: string }>;
      const filename = metadata[0]?.filename;
      if (!filename) throw installationFailure("source-integrity-failed", "npm did not return a packed artifact identity.");
      const tarball = path.join(context.stagingRoot, filename);
      if (await hashFile(tarball) !== provider.integrity) throw installationFailure("source-integrity-failed", "Node package integrity mismatch.");
      await this.runner.run(runRequest(context.recipe, "npm", ["install", "--prefix", context.installationRoot, "--save-exact", provider.allowLifecycleScripts ? "--foreground-scripts" : "--ignore-scripts", tarball], context.installationRoot));
      return;
    }
    if (provider.kind === "python") {
      const python = provider.python ?? "python3";
      await mkdir(context.stagingRoot, { recursive: true, mode: 0o700 });
      await this.runner.run(runRequest(context.recipe, python, ["-m", "pip", "download", "--no-deps", "--dest", context.stagingRoot, `${provider.package}==${provider.version}`], context.stagingRoot));
      const distributions = (await readdir(context.stagingRoot, { withFileTypes: true })).filter((entry) => entry.isFile());
      if (distributions.length === 0) throw installationFailure("source-integrity-failed", "Python resolver returned no distribution.");
      for (const distribution of distributions) {
        if (!provider.hashes.includes(await hashFile(path.join(context.stagingRoot, distribution.name)))) throw installationFailure("source-integrity-failed", "Python distribution hash is not declared by the recipe.");
      }
      await this.runner.run(runRequest(context.recipe, python, ["-m", "venv", context.installationRoot], context.installationRoot));
      const pip = process.platform === "win32" ? path.join(context.installationRoot, "Scripts", "pip.exe") : path.join(context.installationRoot, "bin", "pip");
      await this.runner.run(runRequest(context.recipe, pip, ["install", "--no-index", "--no-deps", ...distributions.map((entry) => path.join(context.stagingRoot, entry.name))], context.installationRoot));
      return;
    }
    if (provider.kind === "container") {
      const runtime = provider.runtime ?? "docker";
      await this.runner.run(runRequest(context.recipe, runtime, ["pull", `${provider.image}@${provider.digest}`], context.installationRoot));
      const inspected = await this.runner.run(runRequest(context.recipe, runtime, ["image", "inspect", "--format", "{{json .RepoDigests}}", `${provider.image}@${provider.digest}`], context.installationRoot));
      if (!inspected.output.includes(`@${provider.digest}`)) throw installationFailure("verification-failed", "Container runtime did not confirm the requested immutable digest.");
      await writeFile(path.join(context.installationRoot, "image.json"), JSON.stringify({ image: provider.image, digest: provider.digest }), { mode: 0o600 });
      return;
    }
    throw installationFailure("manual-prerequisite-required", provider.nextAction);
  }

  verify(context: InstallationProviderContext) {
    if (context.recipe.provider.kind === "manual") {
      return Promise.resolve(Object.fromEntries(context.recipe.outputs.map((output) => [output.name, context.recipe.provider.kind === "manual" ? context.recipe.provider.detect.target : output.path])));
    }
    return this.verifier.verify(context.recipe, context.installationRoot);
  }
  async cleanup(context: InstallationProviderContext) {
    const cleanup = context.recipe.cleanup;
    if (cleanup.kind === "manual") throw installationFailure("manual-prerequisite-required", "Complete the documented cleanup locally.");
    if (cleanup.kind === "custom") {
      if (!cleanup.entrypoint || !cleanup.interpreter) throw installationFailure("verification-failed", "Custom cleanup is missing an entrypoint or interpreter.");
      const entrypoint = await containedPath(context.installationRoot, cleanup.entrypoint);
      const command = interpreterCommand(cleanup.interpreter, entrypoint);
      const args = cleanup.interpreter === "executable" ? [...(cleanup.args ?? [])] : [entrypoint, ...(cleanup.args ?? [])];
      await this.runner.run(runRequest(context.recipe, command, args, context.installationRoot));
    }
    await rm(context.installationRoot, { recursive: true, force: true });
  }
}

export interface InstallationReconcileRequest {
  readonly deploymentId: string;
  readonly desiredVersion: number;
  readonly launchDigest: string;
  readonly recipe: InstallationRecipe;
  readonly localPolicy?: unknown;
  readonly explicitRetry?: boolean;
}

export interface InstallationCoordinatorOptions {
  readonly state: ProtectedInstallationState;
  readonly consent: InstallationConsentManager;
  readonly lock: InstallationMutationLock;
  readonly providers: ReadonlyMap<InstallationProviderKind, InstallationProviderAdapter>;
  readonly installationRoot: string;
  readonly stagingRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly now?: () => number;
  readonly attemptId?: () => string;
  readonly terminateProcess?: (pid: number) => Promise<void>;
}

/** Idempotent, crash-aware installation lifecycle coordinator. */
export class InstallationCoordinator {
  private readonly now: () => number;
  private readonly attemptId: () => string;
  constructor(private readonly options: InstallationCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.attemptId = options.attemptId ?? randomUUID;
  }

  async reconcile(request: InstallationReconcileRequest): Promise<InstallationLifecycleSummary> {
    const recipe = validateInstallationRecipe(request.recipe);
    const root = path.join(this.options.installationRoot, digestDirectory(recipe.digest));
    return this.options.lock.runExclusive(root, async () => {
      const existing = await this.options.state.lifecycle(request.deploymentId);
      if (existing && existing.desiredVersion > request.desiredVersion) throw edgeError("EDGE_PROTOCOL", "Installation desired state is stale.");
      if (existing && existing.desiredVersion === request.desiredVersion && existing.recipeDigest === recipe.digest) {
        if (["ready", "installed"].includes(existing.state)) return existing;
        if (!request.explicitRetry && existing.state === "failed") return existing;
      }
      if (!platformSupported(recipe, this.options.platform ?? process.platform, this.options.architecture ?? process.arch)) {
        return this.transition(request, "blocked", { reasonCode: "unsupported-platform", retryable: false });
      }
      const provider = this.options.providers.get(recipe.provider.kind);
      if (!provider) return this.transition(request, "blocked", { reasonCode: "agent-upgrade-required", retryable: false });
      if (recipe.provider.kind === "custom") {
        const review = this.options.consent.review(recipe, request.localPolicy ?? {});
        const approval = await this.options.consent.decision(review);
        if (!approval) return this.transition(request, "approval-required", { reasonCode: "approval-required", retryable: false, nextAction: `Review installation ${review.approvalDigest}.` });
        if (approval.decision !== "approved") return this.transition(request, "blocked", { reasonCode: approval.decision === "revoked" ? "approval-revoked" : "approval-denied", retryable: false });
      }
      const artifact = await this.options.state.artifact(recipe.digest);
      if (artifact && await exists(artifact.root)) {
        await this.options.state.activate(request.deploymentId, { ...artifact, active: true, references: artifact.references + 1 }, recipe.retention.previousVersions);
        return this.transition(request, "installed", { retryable: false });
      }
      const prior = await this.options.state.attempts(recipe.digest);
      if (!request.explicitRetry && prior.some((attempt) => attempt.state === "failed")) {
        return this.transition(request, "failed", { reasonCode: prior.at(-1)?.reasonCode ?? "installation-failed", retryable: true, attempt: prior.at(-1) });
      }
      const attemptId = this.attemptId();
      const startedAt = this.now();
      const attempt: DurableInstallationAttempt = { attemptId, deploymentId: request.deploymentId, desiredVersion: request.desiredVersion, recipeDigest: recipe.digest, state: "installing", startedAt, retryable: false };
      await this.options.state.putAttempt(attempt);
      await this.transition(request, "installing", { retryable: false, attempt });
      const stagingRoot = path.join(this.options.stagingRoot, attemptId);
      const context: InstallationProviderContext = { recipe, attemptId, stagingRoot, installationRoot: root };
      try {
        const preflight = await provider.preflight(context);
        if (!preflight.ready) await provider.install(context);
        const outputs = await provider.verify(context);
        const verified: InstallationArtifactRecord = { recipeDigest: recipe.digest, root, outputs, verifiedAt: this.now(), active: true, references: 1, externalSideEffects: recipe.cleanup.externalSideEffects };
        await this.options.state.putArtifact(verified);
        await this.options.state.activate(request.deploymentId, verified, recipe.retention.previousVersions);
        const complete: DurableInstallationAttempt = { ...attempt, state: "installed", finishedAt: this.now() };
        await this.options.state.putAttempt(complete);
        return this.transition(request, "installed", { retryable: false, attempt: complete });
      } catch (error) {
        const reasonCode = installationReason(error);
        const failed: DurableInstallationAttempt = { ...attempt, state: "failed", finishedAt: this.now(), reasonCode, retryable: retryableReason(reasonCode), diagnostics: [redactInstallerText(error instanceof Error ? error.message : String(error))] };
        await this.options.state.putAttempt(failed);
        return this.transition(request, "failed", { reasonCode, retryable: failed.retryable, attempt: failed });
      } finally { await rm(stagingRoot, { recursive: true, force: true }); }
    });
  }

  status(deploymentId: string): Promise<InstallationLifecycleSummary | undefined> {
    return this.options.state.lifecycle(deploymentId);
  }

  review(recipe: InstallationRecipe, localPolicy: unknown = {}, cleanup = false): InstallationReviewModel {
    return this.options.consent.review(recipe, cleanup ? { localPolicy, cleanup: true } : localPolicy);
  }

  async decide(recipe: InstallationRecipe, decision: "approved" | "denied" | "revoked", localPolicy: unknown = {}, cleanup = false): Promise<InstallationApprovalRecord> {
    const review = this.review(recipe, localPolicy, cleanup);
    await this.options.consent.decide(review, decision, cleanup);
    return (await this.options.consent.decision(review, cleanup))!;
  }

  async recoverInterrupted(): Promise<readonly DurableInstallationAttempt[]> {
    const document = await this.options.state.snapshot();
    const interrupted: DurableInstallationAttempt[] = [];
    for (const attempt of Object.values(document.attempts).filter((candidate) => candidate.state === "installing")) {
      for (const pid of attempt.processIds ?? []) await this.options.terminateProcess?.(pid);
      const updated: DurableInstallationAttempt = { ...attempt, state: "failed", finishedAt: this.now(), reasonCode: "attempt-interrupted", retryable: true };
      await this.options.state.putAttempt(updated);
      interrupted.push(updated);
    }
    return interrupted;
  }

  async remove(deploymentId: string, recipe: InstallationRecipe, approveCleanup = false): Promise<InstallationLifecycleSummary> {
    const existing = await this.options.state.lifecycle(deploymentId);
    const request = { deploymentId, desiredVersion: existing?.desiredVersion ?? 0, launchDigest: existing?.launchDigest ?? "sha256:removed", recipe };
    if (recipe.cleanup.kind === "custom" && recipe.cleanup.externalSideEffects) {
      const review = this.options.consent.review(recipe, { cleanup: true });
      const approval = await this.options.consent.decision(review, true);
      if (!approveCleanup || approval?.decision !== "approved") return this.transition(request, "blocked", { reasonCode: "cleanup-approval-required", retryable: false });
    }
    await this.transition(request, "removing", { retryable: false });
    const current = await this.options.state.artifact(recipe.digest);
    if (current && current.references <= 1) {
      const provider = this.options.providers.get(recipe.provider.kind);
      if (!provider) return this.transition(request, "blocked", { reasonCode: "agent-upgrade-required", retryable: false });
      try {
        await provider.cleanup({
          recipe,
          attemptId: `cleanup-${randomUUID()}`,
          stagingRoot: this.options.stagingRoot,
          installationRoot: current.root,
        });
      } catch (error) {
        const reasonCode = installationReason(error);
        return this.transition(request, "failed", { reasonCode, retryable: retryableReason(reasonCode) });
      }
    }
    const artifact = await this.options.state.removeReference(deploymentId, recipe.digest);
    if (artifact?.references === 0) await rm(artifact.root, { recursive: true, force: true });
    return this.transition(request, "removed", { retryable: false });
  }

  async rollback(deploymentId: string, request: InstallationReconcileRequest): Promise<InstallationLifecycleSummary> {
    const candidate = await this.options.state.rollbackCandidate(deploymentId);
    if (!candidate || candidate.externalSideEffects || !await exists(candidate.root)) {
      return this.transition(request, "failed", { reasonCode: "artifact-missing", retryable: false, nextAction: "Perform manual recovery; no safe verified rollback is available." });
    }
    await this.options.state.activate(deploymentId, { ...candidate, active: true, references: candidate.references + 1 }, request.recipe.retention.previousVersions);
    return this.transition({ ...request, recipe: { ...request.recipe, digest: candidate.recipeDigest } }, "installed", { retryable: false });
  }

  async resolveArtifact(reference: InstalledArtifactReference): Promise<string> {
    const artifact = await this.options.state.artifact(reference.installationDigest);
    const output = artifact?.outputs[reference.output];
    if (!artifact?.active || !output) throw installationFailure("artifact-missing", "Installed artifact output is unavailable.");
    return containedPath(await realpath(artifact.root), path.relative(artifact.root, output));
  }

  private async transition(request: InstallationReconcileRequest, state: InstallationLifecycleSummary["state"], options: {
    reasonCode?: InstallationReasonCode;
    retryable: boolean;
    attempt?: InstallationAttemptSummary;
    nextAction?: string;
  }): Promise<InstallationLifecycleSummary> {
    const lifecycle: InstallationLifecycleSummary = {
      deploymentId: request.deploymentId,
      desiredVersion: request.desiredVersion,
      recipeDigest: request.recipe.digest,
      launchDigest: request.launchDigest,
      state,
      readiness: normalizeInstallationReadiness(state),
      observedAt: this.now(),
      ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
      ...(options.attempt ? { attempt: options.attempt } : {}),
      ...(options.nextAction ? { nextAction: options.nextAction } : {}),
    };
    await this.options.state.putLifecycle(lifecycle);
    return lifecycle;
  }
}

export function createDefaultInstallationProviders(options: {
  source?: ManagedInstallationSourceResolver;
  runner?: BoundedInstallerRunner;
  verifier?: InstallationVerificationService;
} = {}): ReadonlyMap<InstallationProviderKind, InstallationProviderAdapter> {
  const source = options.source ?? new ManagedInstallationSourceResolver();
  const runner = options.runner ?? new BoundedInstallerRunner();
  const kinds: readonly InstallationProviderKind[] = ["custom", "node-package", "python", "binary", "container", "manual"];
  return new Map(kinds.map((kind) => [kind, new SharedInstallationProvider(kind, source, runner, options.verifier)]));
}

const noIsolationAdapter: InstallationIsolationAdapter = Object.freeze({
  filesystem: false,
  network: false,
  wrap: async (input: InstallerRunRequest) => input,
});

function runRequest(recipe: InstallationRecipe, command: string, args: readonly string[], cwd: string): InstallerRunRequest {
  return {
    command, args, cwd,
    timeoutMs: recipe.permissions.limits.timeoutMs,
    maxOutputBytes: recipe.permissions.limits.maxOutputBytes,
    maxDiskBytes: recipe.permissions.limits.maxDiskBytes,
    allowedExecutables: recipe.permissions.executables,
    requireFilesystemIsolation: recipe.permissions.requireFilesystemIsolation,
    requireNetworkIsolation: recipe.permissions.requireNetworkIsolation,
  };
}

function sanitizeSource(source: InstallationSource): Readonly<Record<string, unknown>> {
  const copy = { ...source } as Record<string, unknown>;
  delete copy.credentialRef;
  if (source.kind === "inline") copy.content = source.content.slice(0, 32_768);
  return freeze(copy);
}

function sanitizeProvider(provider: InstallationRecipe["provider"]): Readonly<Record<string, unknown>> {
  const copy = structuredClone(provider) as unknown as Record<string, unknown>;
  if (provider.kind === "custom") copy.source = sanitizeSource(provider.source);
  return freeze(copy);
}

function allowlistedEnvironment(input: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  for (const [key, value] of Object.entries(input)) if (/^[A-Z_][A-Z0-9_]*$/.test(key)) env[key] = value;
  return env;
}

function denyElevation(command: string, args: readonly string[]): void {
  const tokens = [path.basename(command), ...args].map((value) => value.toLowerCase());
  if (tokens.some((value) => ["sudo", "su", "doas", "runas", "pkexec", "start-process -verb runas"].some((term) => value === term || value.includes(term)))) {
    throw installationFailure("elevation-denied", "Installer elevation is not permitted.");
  }
}

function terminateTree(pid?: number): void {
  if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM"); } catch { /* already exited */ }
  const timer = setTimeout(() => { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* already exited */ } }, 2_000);
  timer.unref();
}

async function verifyOne(verification: InstallationVerification, root: string): Promise<void> {
  if (verification.kind === "container-image") return;
  const target = await containedPath(root, verification.target);
  const info = await stat(target);
  if (!info.isFile()) throw installationFailure("verification-failed", "Verification target is not a file.");
  if (verification.expectedDigest && await hashFile(target) !== verification.expectedDigest) throw installationFailure("verification-failed", "Verification digest mismatch.");
}

async function containedPath(root: string, relative: string): Promise<string> {
  assertContainedRelative(relative, "managed path");
  const candidate = path.resolve(root, relative);
  const parent = await realpath(path.dirname(candidate));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw installationFailure("artifact-escape", "Managed path escapes the artifact root.");
  return candidate;
}

function assertContainedRelative(value: string, field: string): void {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw installationFailure("source-integrity-failed", `${field} escapes the managed root.`);
}

async function assertTreeSafe(root: string): Promise<void> {
  const canonical = await realpath(root);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw installationFailure("source-integrity-failed", "Source contains a symlink or special file.");
      const resolved = await realpath(candidate);
      if (resolved !== canonical && !resolved.startsWith(`${canonical}${path.sep}`)) throw installationFailure("source-integrity-failed", "Source escapes its staging root.");
      if (info.isDirectory()) await visit(candidate);
    }
  };
  await visit(root);
}

async function hashFile(file: string): Promise<InstallationDigest> {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

async function hashTree(root: string): Promise<InstallationDigest> {
  const entries: Array<{ path: string; digest: InstallationDigest }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile()) entries.push({ path: path.relative(root, candidate).split(path.sep).join("/"), digest: await hashFile(candidate) });
      else throw installationFailure("source-integrity-failed", "Source contains a link or special file.");
    }
  };
  await walk(root);
  return computeInstallationDigest(entries);
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile()) total += (await stat(candidate)).size;
    }
  };
  await walk(root);
  return total;
}

function interpreterCommand(interpreter: Extract<InstallationRecipe["provider"], { kind: "custom" }>["interpreter"], entrypoint: string): string {
  if (interpreter === "executable") return entrypoint;
  if (interpreter === "powershell") return process.platform === "win32" ? "powershell.exe" : "pwsh";
  if (interpreter === "python") return "python3";
  return interpreter;
}

function platformSupported(recipe: InstallationRecipe, platform: NodeJS.Platform, architecture: string): boolean {
  return (!recipe.platforms?.platforms || recipe.platforms.platforms.includes(platform))
    && (!recipe.platforms?.architectures || recipe.platforms.architectures.includes(architecture));
}

function digestDirectory(digest: InstallationDigest): string { return digest.slice("sha256:".length); }
function escapeSandbox(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }
function approvalKey(digest: InstallationDigest, cleanup = false): string { return `${digest}:${cleanup}`; }
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function retryableReason(reason: InstallationReasonCode): boolean { return ["source-unavailable", "limit-exceeded", "installation-failed", "attempt-interrupted"].includes(reason); }
function installationReason(error: unknown): InstallationReasonCode { return error instanceof InstallationExecutionError ? error.reasonCode : "installation-failed"; }

export class InstallationExecutionError extends Error {
  constructor(readonly reasonCode: InstallationReasonCode, message: string) { super(message); this.name = `InstallationExecutionError[${reasonCode}]`; }
}
function installationFailure(reason: InstallationReasonCode, message: string): InstallationExecutionError { return new InstallationExecutionError(reason, message); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === "object") freeze(child); } return value; }
