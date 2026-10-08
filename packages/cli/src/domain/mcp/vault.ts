import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { LocalSecretsBackend, type McpSecretSource, type McpConnectionState, type McpVault, type McpProxyOptions, resolveCredentialSource } from "@fentaris/core";
import type { ProjectDiscovery, Runtime } from "../../shared/types.js";
import { authDirectory } from "../secrets/backend.js";
import { completeInput } from "../../shared/input.js";
import type { CliOptions } from "../../shared/types.js";

export type McpProjectVault = McpVault & {
  ensureUnlocked?(options: CliOptions, nextCommand: string): Promise<void>;
  bind(reference: string, source: McpSecretSource, options?: { consumer?: { kind: "mcp"; server: string; account: string }; replaceSource?: boolean }): Promise<unknown>;
  detachConsumer(reference: string, consumer: { kind: "mcp"; server: string; account: string }): Promise<unknown>;
};

/** Use #298's shared facade when integrated; otherwise adapt the existing encrypted backend. */
export async function openMcpProjectVault(project: ProjectDiscovery, runtime: Runtime, config: McpProxyOptions, state: McpConnectionState, unlockKey?: string): Promise<McpProjectVault> {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const shared = path.resolve(import.meta.dirname, `../secrets/vault${extension}`);
  if (existsSync(shared)) {
    const module = await import(pathToFileURL(shared).href) as { openProjectVault: (project: ProjectDiscovery, runtime: Runtime) => Promise<McpProjectVault> };
    const vault = await module.openProjectVault(project, unlockKey ? { ...runtime, env: { ...runtime.env, FENTARIS_VAULT_UNLOCK_KEY: unlockKey } } : runtime);
    return {
      resolve: (reference) => !state.sources[reference] && config.defaults?.credentials?.[reference] ? resolveCredentialSource(config.defaults.credentials[reference]) : vault.resolve(reference),
      set: (reference, value, options) => vault.set(reference, value, options),
      async bind(reference, source, options) { await vault.bind(reference, source, options); state.sources[reference] = source; },
      detachConsumer: (reference, consumer) => vault.detachConsumer(reference, consumer),
    };
  }
  let key = unlockKey ?? runtime.env.FENTARIS_VAULT_UNLOCK_KEY ?? runtime.env.FENTARIS_AUTH_KEY;
  let backend = key ? new LocalSecretsBackend({ dir: authDirectory(project), key }) : undefined;
  return {
    async ensureUnlocked(options, nextCommand) {
      if (backend) return;
      const input = await completeInput(runtime, options, [{ name: "vault-unlock-key", question: "Project vault unlock key", secret: true }], `${nextCommand} --key <VAULT_UNLOCK_KEY>`);
      key = input["vault-unlock-key"];
      backend = new LocalSecretsBackend({ dir: authDirectory(project), key });
      runtime.env.FENTARIS_VAULT_UNLOCK_KEY = key;
    },
    async resolve(reference) {
      const source = state.sources[reference];
      if (source?.type === "environment") return runtime.env[source.name];
      if (source?.type === "external") throw new Error("Configure the external source through the shared project vault before connecting this account.");
      const configured = config.defaults?.credentials?.[reference];
      if (!source && configured) return resolveCredentialSource(configured);
      if (!backend && existsSync(path.join(authDirectory(project), "credentials.enc.json"))) throw new Error("The project vault is locked. Supply FENTARIS_VAULT_UNLOCK_KEY or an explicit --key.");
      return backend?.resolve(reference);
    },
    async set(reference, value) {
      if (!backend) throw new Error("The project vault is locked. Configure an explicit vault unlock key; no key was generated or written to .env.");
      if (state.sources[reference] && state.sources[reference].type !== "vault") throw new Error("The reference has an explicit non-vault source. Reuse it without copying its value, or change its source through secrets.");
      if (reference.startsWith("fentaris.internal.oauth.")) await backend.setInternal(reference, value);
      else await backend.set(reference, value, { kind: "default" });
      state.sources[reference] = { type: "vault" };
    },
    async bind(reference, source) {
      const existing = state.sources[reference];
      if (existing && JSON.stringify(existing) !== JSON.stringify(source)) throw new Error("The reference already has a different source. Change sources explicitly through secrets.");
      state.sources[reference] = source;
    },
    async detachConsumer() { /* Public connection binding removal preserves all shared values. */ },
  };
}
