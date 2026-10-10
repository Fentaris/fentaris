import { ProjectVault } from "../secrets/project-vault.js";
import { findEnvironmentProjectRoot } from "../secrets/environment.js";
import type { McpVault } from "./vaultOAuthStore.js";

/** Share credential sources and private OAuth lifecycle records with ProjectVault. */
export function mcpRuntimeVault(dir: string, env: NodeJS.ProcessEnv = process.env): McpVault {
  let vault: Promise<ProjectVault> | undefined;
  const open = () => vault ??= ProjectVault.open({ root: findEnvironmentProjectRoot(), dir, env: { ...env, FENTARIS_VAULT_KEY: env.FENTARIS_VAULT_KEY ?? env.FENTARIS_VAULT_UNLOCK_KEY } });
  return {
    resolve: async (reference) => (await open()).resolve(reference),
    set: async (reference, value, options) => (await open()).set(reference, value, options),
    oauthStore: (account) => ({
      get: async (server, session) => (await open()).oauthStore(account).get(server, session),
      set: async (server, session, record) => (await open()).oauthStore(account).set(server, session, record),
      delete: async (server, session) => (await open()).oauthStore(account).delete(server, session),
      update: async (server, session, mutate) => (await open()).oauthStore(account).update!(server, session, mutate),
      list: async () => (await open()).oauthStore(account).list(),
    }),
  };
}
