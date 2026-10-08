import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LocalSecretsBackend } from "../secrets/local-backend.js";
import { findEnvironmentProjectRoot } from "../environment.js";
import type { McpVault } from "./vaultOAuthStore.js";

/** Bridge to the shared ProjectVault when integrated, retaining encrypted legacy storage on this branch. */
export function mcpRuntimeVault(dir: string, env: NodeJS.ProcessEnv = process.env): McpVault {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const shared = path.resolve(import.meta.dirname, `../secrets/project-vault${extension}`);
  let vault: Promise<McpVault> | undefined;
  const open = () => vault ??= (async () => {
    if (existsSync(shared)) {
      const module = await import(pathToFileURL(shared).href) as { ProjectVault: { open(options: { root: string; dir: string; env: NodeJS.ProcessEnv }): Promise<McpVault> } };
      return module.ProjectVault.open({ root: findEnvironmentProjectRoot(), dir, env });
    }
    const key = env.FENTARIS_VAULT_UNLOCK_KEY ?? env.FENTARIS_AUTH_KEY;
    const backend = key ? new LocalSecretsBackend({ dir, key }) : undefined;
    return {
      async resolve(reference: string) {
        if (!backend && existsSync(path.join(dir, "credentials.enc.json"))) throw new Error("The project credential vault is locked.");
        return backend?.resolve(reference);
      },
      async set(reference: string, value: string) {
        if (!backend) throw new Error("The project credential vault is locked. Supply an explicit vault unlock key.");
        if (reference.startsWith("fentaris.internal.oauth.")) await backend.setInternal(reference, value);
        else await backend.set(reference, value, { kind: "default" });
      },
    };
  })();
  return { resolve: async (reference) => (await open()).resolve(reference), set: async (reference, value, options) => (await open()).set(reference, value, options) };
}

export function hasSharedProjectVault(): boolean {
  return existsSync(path.resolve(import.meta.dirname, `../secrets/project-vault${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`));
}
