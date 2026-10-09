import { resolveCredentialSource, type McpSecretSource, type McpConnectionState, type McpVault, type McpProxyOptions } from "@fentaris/core";
import type { ProjectDiscovery, Runtime } from "../../shared/types.js";
import { openProjectVault } from "../secrets/vault.js";

export type McpProjectVault = McpVault & {
  bind(reference: string, source: McpSecretSource, options?: { consumer?: { kind: "mcp"; server: string; account: string }; replaceSource?: boolean }): Promise<unknown>;
  detachConsumer(reference: string, consumer: { kind: "mcp"; server: string; account: string }): Promise<unknown>;
};

/** MCP commands share the same source registry and encrypted lifecycle store as secrets. */
export async function openMcpProjectVault(project: ProjectDiscovery, runtime: Runtime, config: McpProxyOptions, state: McpConnectionState, unlockKey?: string): Promise<McpProjectVault> {
  const key = unlockKey ?? runtime.env.FENTARIS_VAULT_KEY ?? runtime.env.FENTARIS_VAULT_UNLOCK_KEY;
  const vault = await openProjectVault(project, key === undefined ? runtime : { ...runtime, env: { ...runtime.env, FENTARIS_VAULT_KEY: key } });
  return {
    resolve: (reference) => !state.sources[reference] && config.defaults?.credentials?.[reference] ? resolveCredentialSource(config.defaults.credentials[reference]) : vault.resolve(reference),
    set: (reference, value, options) => vault.set(reference, value, options),
    async bind(reference, source, options) { await vault.bind(reference, source, options); state.sources[reference] = source; },
    detachConsumer: (reference, consumer) => vault.detachConsumer(reference, consumer),
    oauthStore: (account) => vault.oauthStore(account),
  };
}
