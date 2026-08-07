import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  diffManifest,
  encodeSecretScope,
  parseManifest,
  secretRefKey,
  type SecretRef,
  type SecretsManifest,
  type SecretsManifestApiKey,
  type SecretsManifestEntry,
} from "@fentaris/core";
import type { HealthResult, ProjectDiscovery, Runtime } from "../../shared/types.js";
import { exists } from "../../shared/utils.js";
import { loadProjectEnv } from "../project/env.js";
import { credentialsPath, formatScopeLabel, manifestPath, openLocalSecretsBackend } from "./backend.js";
import { scanEntrypointForSecrets } from "./manifest-scan.js";

export type SecretsDoctorOptions = {
  strict?: boolean;
  key?: string;
};

export type SecretsDoctorIssue = {
  status: "pass" | "warn" | "fail";
  ref: string;
  scope: string;
  detail: string;
  hint?: string;
};

export async function getSecretsDoctorIssues(project: ProjectDiscovery, runtime: Runtime, options: SecretsDoctorOptions = {}): Promise<SecretsDoctorIssue[]> {
  const issues: SecretsDoctorIssue[] = [];
  const manifest = await loadRequiredManifest(project);
  const required = manifest.references.filter((entry) => entry.source?.type !== "env" && entry.source?.type !== "manual");
  const env = await loadProjectEnv(project.root, runtime.env);
  const key = options.key ?? env.FENTARIS_AUTH_KEY;
  const storeExists = await exists(credentialsPath(project));

  let stored: SecretRef[] = [];
  if (storeExists && key?.trim()) {
    try {
      const backend = await openLocalSecretsBackend(project, runtime, { key });
      stored = await backend.listRefs();
    } catch (error) {
      issues.push({
        status: "fail",
        ref: "credentials.enc.json",
        scope: "local",
        detail: error instanceof Error ? error.message : "Unable to decrypt local credentials.",
        hint: "Verify FENTARIS_AUTH_KEY matches the local credential store.",
      });
    }
  } else if (storeExists) {
    issues.push({
      status: "warn",
      ref: "credentials.enc.json",
      scope: "local",
      detail: "Encrypted store found but FENTARIS_AUTH_KEY is not set.",
      hint: "Set FENTARIS_AUTH_KEY to verify stored secrets.",
    });
  }

  const diff = diffManifest(required, stored);
  for (const entry of diff.missing) {
    issues.push({
      status: options.strict ? "fail" : "warn",
      ref: entry.ref,
      scope: entry.scope,
      detail: "Required secret is missing from the local store.",
      hint: hintForSet(entry),
    });
  }

  for (const entry of diff.extra) {
    issues.push({
      status: "warn",
      ref: entry.ref,
      scope: encodeSecretScope(entry.scope),
      detail: "Stored secret is not listed in the secrets manifest.",
      hint: "Run fentaris secrets manifest to update the committed schema.",
    });
  }

  for (const entry of manifest.references) {
    if (entry.source?.type === "env" && !env[entry.source.name]?.trim()) {
      issues.push({
        status: options.strict ? "fail" : "warn",
        ref: entry.ref,
        scope: entry.scope,
        detail: `Required environment variable ${entry.source.name} is missing.`,
        hint: `Set ${entry.source.name} in the project .env or deployment environment.`,
      });
    } else if (entry.source?.type === "manual") {
      issues.push({
        status: options.strict ? "fail" : "warn",
        ref: entry.ref,
        scope: entry.scope,
        detail: entry.source.reason,
        hint: "Configure this custom credential source manually.",
      });
    }
  }

  for (const requirement of manifest.apiKeys ?? []) {
    const issue = apiKeyIssue(requirement, stored, env, options.strict === true);
    if (issue) issues.push(issue);
  }

  for (const tracked of await gitTrackedSecretFiles(project)) {
    issues.push({
      status: "fail",
      ref: tracked,
      scope: "git",
      detail: "Sensitive file is tracked by git.",
      hint: `Remove it from git tracking and add it to .gitignore.`,
    });
  }

  if (project.config.fentaris?.projectId) {
    issues.push({
      status: "warn",
      ref: "fentaris.cloud",
      scope: "cloud",
      detail: "Fentaris Cloud project is configured but cloud sync is not available yet.",
      hint: "Use the local encrypted store for now. Cloud sync arrives in a later release.",
    });
  }

  if (project.config.authDir !== ".fentaris") {
    issues.push({
      status: "warn",
      ref: "authDir",
      scope: "config",
      detail: `Custom authDir (${project.config.authDir}) may not match credentialJson() defaults.`,
      hint: "Prefer authDir \".fentaris\" unless you have aligned all credential paths.",
    });
  }

  return issues;
}

export async function secretsDoctorHealthResults(project: ProjectDiscovery, runtime: Runtime | undefined, options: SecretsDoctorOptions = {}): Promise<HealthResult[]> {
  if (!runtime) {
    return [];
  }

  const issues = await getSecretsDoctorIssues(project, runtime, options);
  const manifestExists = await exists(manifestPath(project));
  const entrypoint = path.join(project.root, project.config.entrypoint);
  const scanned = await exists(entrypoint) ? await scanEntrypointForSecrets(entrypoint) : { references: [], envVars: [], apiKeys: [], diagnostics: [] };
  const shouldHaveManifest = manifestExists || scanned.references.length > 0 || scanned.apiKeys.length > 0 || scanned.envVars.length > 0;
  const results: HealthResult[] = shouldHaveManifest
    ? [
        {
          group: "Auth",
          label: "secrets manifest",
          status: manifestExists ? "pass" : "warn",
          detail: manifestExists ? "Found committed secrets schema." : "Missing secrets.manifest.json.",
          hint: manifestExists ? undefined : "Run fentaris secrets manifest to generate the committed schema.",
        },
      ]
    : [];

  for (const issue of issues) {
    results.push({
      group: "Auth",
      label: issue.ref === issue.scope ? issue.ref : `${issue.ref} (${issue.scope})`,
      status: issue.status,
      detail: issue.detail,
      hint: issue.hint,
    });
  }

  return results;
}

export async function loadRequiredReferences(project: ProjectDiscovery): Promise<SecretsManifestEntry[]> {
  return (await loadRequiredManifest(project)).references;
}

export async function loadRequiredManifest(project: ProjectDiscovery): Promise<SecretsManifest> {
  const manifestFile = manifestPath(project);
  if (await exists(manifestFile)) {
    return parseManifest(parseManifestJson(await readFile(manifestFile, "utf8"), manifestFile));
  }

  const entrypoint = path.join(project.root, project.config.entrypoint);
  if (await exists(entrypoint)) {
    const scanned = await scanEntrypointForSecrets(entrypoint);
    return {
      version: 1,
      references: scanned.references,
      ...(scanned.envVars.length ? { envVars: scanned.envVars } : {}),
      ...(scanned.apiKeys.length ? { apiKeys: scanned.apiKeys } : {}),
    };
  }

  return { version: 1, references: [] };
}

function parseManifestJson(source: string, filePath: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Unable to parse secrets manifest at ${filePath}: ${detail}`, { cause: error });
  }
}

export function buildListRows(required: SecretsManifest, stored: SecretRef[], env: NodeJS.ProcessEnv = process.env): Array<{ ref: string; scope: string; kind: string; status: string }> {
  const storedCredentialsByKey = new Map(
    stored.filter((entry) => entry.kind === "credential").map((entry) => [secretRefKey(entry.ref, entry.scope), entry]),
  );
  const rows: Array<{ ref: string; scope: string; kind: string; status: string }> = [];
  const seen = new Set<string>();
  const seenApiKeyUsers = new Set<string>();

  for (const entry of required.references) {
    const scope = decodeScope(entry.scope);
    const key = secretRefKey(entry.ref, scope);
    seen.add(key);
    const storedEntry = storedCredentialsByKey.get(key);
    const status = entry.source?.type === "env"
      ? env[entry.source.name]?.trim() ? "set" : "missing"
      : entry.source?.type === "manual"
        ? "manual"
        : storedEntry ? "set" : "missing";
    rows.push({
      ref: entry.ref,
      scope: entry.scope,
      kind: "credential",
      status,
    });
  }

  for (const requirement of required.apiKeys ?? []) {
    seenApiKeyUsers.add(requirement.userId);
    const storedEntry = stored.find((entry) => entry.kind === "apiKey" && entry.scope.kind === "user" && entry.scope.id === requirement.userId);
    const status = requirement.source.type === "env"
      ? env[requirement.source.name]?.trim() ? "set" : "missing"
      : requirement.source.type === "manual"
        ? "manual"
        : (storedEntry?.count ?? 0) >= (requirement.count ?? 1) ? `${storedEntry?.count ?? 0} keys` : "missing";
    rows.push({ ref: requirement.userId, scope: `user:${requirement.userId}`, kind: "apiKey", status });
  }

  for (const entry of stored) {
    const key = secretRefKey(entry.ref, entry.scope);
    if (entry.kind === "credential" && seen.has(key)) {
      continue;
    }
    if (entry.kind === "apiKey" && entry.scope.kind === "user" && seenApiKeyUsers.has(entry.scope.id)) continue;
    rows.push({
      ref: entry.ref,
      scope: formatScopeLabel(entry.scope),
      kind: entry.kind,
      status: entry.kind === "apiKey" ? `${entry.count} key${entry.count === 1 ? "" : "s"}` : "set",
    });
  }

  return rows;
}

function apiKeyIssue(requirement: SecretsManifestApiKey, stored: SecretRef[], env: NodeJS.ProcessEnv, strict: boolean): SecretsDoctorIssue | null {
  if (requirement.source.type === "env") {
    return env[requirement.source.name]?.trim() ? null : {
      status: strict ? "fail" : "warn",
      ref: requirement.userId,
      scope: "apiKey",
      detail: `Required API-key environment variable ${requirement.source.name} is missing.`,
      hint: `Set ${requirement.source.name} or run fentaris secrets setup.`,
    };
  }
  if (requirement.source.type === "manual") {
    return {
      status: strict ? "fail" : "warn",
      ref: requirement.userId,
      scope: "apiKey",
      detail: requirement.source.reason,
      hint: "Configure this API-key source manually.",
    };
  }
  const storedEntry = stored.find((entry) => entry.kind === "apiKey" && entry.scope.kind === "user" && entry.scope.id === requirement.userId);
  return (storedEntry?.count ?? 0) >= (requirement.count ?? 1) ? null : {
    status: strict ? "fail" : "warn",
    ref: requirement.userId,
    scope: "apiKey",
    detail: `Required local API key is missing (${storedEntry?.count ?? 0}/${requirement.count ?? 1}).`,
    hint: `Run fentaris auth api-key add ${requirement.userId} --generate or fentaris secrets setup.`,
  };
}

async function gitTrackedSecretFiles(project: ProjectDiscovery): Promise<string[]> {
  if (!(await isGitRepository(project.root))) {
    return [];
  }

  const candidates = [
    path.relative(project.root, credentialsPath(project)),
    ".env",
  ];
  const tracked: string[] = [];
  for (const candidate of candidates) {
    if (await gitTracksFile(project.root, candidate)) {
      tracked.push(candidate);
    }
  }
  return tracked;
}

function hintForSet(entry: SecretsManifestEntry): string {
  if (entry.scope === "default") {
    return `fentaris secrets set ${entry.ref}`;
  }
  if (entry.scope.startsWith("user:")) {
    return `fentaris secrets set ${entry.ref} --user ${entry.scope.slice("user:".length)}`;
  }
  if (entry.scope.startsWith("group:")) {
    return `fentaris secrets set ${entry.ref} --group ${entry.scope.slice("group:".length)}`;
  }
  return `fentaris secrets set ${entry.ref}`;
}

function decodeScope(scope: string): SecretRef["scope"] {
  if (scope === "default") {
    return { kind: "default" };
  }
  if (scope.startsWith("user:")) {
    return { kind: "user", id: scope.slice("user:".length) };
  }
  if (scope.startsWith("group:")) {
    return { kind: "group", id: scope.slice("group:".length) };
  }
  return { kind: "default" };
}

async function isGitRepository(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function gitTracksFile(root: string, relativePath: string): Promise<boolean> {
  if (!(await exists(path.join(root, relativePath)))) {
    return false;
  }
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-files", "--error-unmatch", relativePath], { cwd: root, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
