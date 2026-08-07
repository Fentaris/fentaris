import path from "node:path";
import { LocalSecretsBackend, type SecretScope } from "@fentaris/core";
import type { CliOptions, ProjectDiscovery, Runtime } from "../../shared/types.js";
import { exists } from "../../shared/utils.js";
import { authKeyFromRuntime } from "../auth/local-store.js";
import { ensureProjectAuthKey, loadProjectEnv } from "../project/env.js";

const unusedKeyWithoutCredentialStore = "fentaris:no-local-credential-store";

export function authDirectory(project: ProjectDiscovery): string {
  return path.join(project.root, project.config.authDir);
}

export function manifestPath(project: ProjectDiscovery): string {
  return path.join(authDirectory(project), "secrets.manifest.json");
}

export function credentialsPath(project: ProjectDiscovery): string {
  return path.join(authDirectory(project), "credentials.enc.json");
}

export async function openLocalSecretsBackend(
  project: ProjectDiscovery,
  runtime: Runtime,
  options: CliOptions = {},
  behavior: { createKeyIfMissing?: boolean } = {},
): Promise<LocalSecretsBackend> {
  const env = await loadProjectEnv(project.root, runtime.env);
  const configuredKey = typeof options.key === "string" ? options.key : env.FENTARIS_AUTH_KEY;
  if (!configuredKey?.trim() && !(await exists(credentialsPath(project)))) {
    if (behavior.createKeyIfMissing === true) {
      const generated = await ensureProjectAuthKey(project.root, runtime.env);
      return LocalSecretsBackend.open({ dir: authDirectory(project), key: generated.key });
    }
    return LocalSecretsBackend.open({ dir: authDirectory(project), key: unusedKeyWithoutCredentialStore });
  }
  const key = await authKeyFromRuntime({ ...runtime, env }, options);
  return LocalSecretsBackend.open({ dir: authDirectory(project), key });
}

export function scopeFromOptions(options: CliOptions): SecretScope {
  if (typeof options.user === "string" && typeof options.group === "string") {
    throw new Error("Use either --user or --group, not both.");
  }
  if (typeof options.user === "string") {
    return { kind: "user", id: options.user };
  }
  if (typeof options.group === "string") {
    return { kind: "group", id: options.group };
  }
  return { kind: "default" };
}

export function formatScopeLabel(scope: SecretScope): string {
  if (scope.kind === "default") {
    return "default";
  }
  if (scope.kind === "user") {
    return `user:${scope.id}`;
  }
  return `group:${scope.id}`;
}
