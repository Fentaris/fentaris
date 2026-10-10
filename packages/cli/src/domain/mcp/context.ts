import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { applyMcpConnectionState, bounded, loadProjectEnvironment, readMcpConnectionState, McpVaultOAuthTokenStore, LocalOAuthTokenStore, type McpProxyOptions, type McpDiscoveryCache } from "@fentaris/core";
import { discoverSecretsProject } from "../project/project.js";
import { authDirectory } from "../secrets/backend.js";
import { openMcpProjectVault } from "./vault.js";
import type { CliOptions, Runtime } from "../../shared/types.js";

export async function openMcpContext(runtime: Runtime, options: CliOptions) {
  const project = await discoverSecretsProject(runtime.cwd, { requireEntrypoint: true });
  const env = loadProjectEnvironment(project.root, { ...runtime.env, ...process.env });
  const inserted: string[] = [];
  for (const [name, value] of Object.entries(env)) if (value !== undefined && process.env[name] === undefined) { process.env[name] = value; inserted.push(name); }
  const restore = () => { for (const name of inserted) delete process.env[name]; };
  try {
    const module = await import(`${pathToFileURL(join(project.root, project.config.entrypoint)).href}?fentarisMcp=${randomUUID()}`) as Record<string, unknown>;
    const exported = module.fentarisConfig ?? module.config ?? module.default;
    if (!exported || typeof exported !== "object") throw new Error("Project entrypoint must export fentarisConfig, config, or a default Fentaris configuration.");
    const config = exported as McpProxyOptions;
    const directory = authDirectory(project);
    const state = readMcpConnectionState(directory);
    const initialSources = { ...state.sources };
    const servers = [...new Set([...(config.servers ?? []), ...(config.groups ?? []).flatMap((group) => group.servers)])];
    applyMcpConnectionState(servers, state);
    const effectiveRuntime = { ...runtime, env };
    const vault = await openMcpProjectVault(project, effectiveRuntime, config, state, typeof options.key === "string" ? options.key : undefined);
    const key = env.FENTARIS_AUTH_KEY;
    const legacy = key ? new LocalOAuthTokenStore({ dir: directory, key }) : undefined;
    const tokenStore = config.oauth?.store ?? new McpVaultOAuthTokenStore({ vault, connections: servers.flatMap((server) => server.accountNames().map((account) => ({ server: server.name, account }))), legacyStore: legacy });
    let cache: McpDiscoveryCache = {};
    try { cache = JSON.parse(await readFile(join(directory, "mcp-cache.json"), "utf8")) as McpDiscoveryCache; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    return { project, config, directory, state, initialSources, servers, vault, tokenStore, legacy, runtime: effectiveRuntime, cache,
      async saveCache(next: McpDiscoveryCache) {
        // Discovery is read-only except optional metadata for an already initialized state directory.
        try { await writeFile(join(directory, "mcp-cache.json"), JSON.stringify(next), { mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      },
      async close() {
        await Promise.allSettled(servers.map((server) => bounded(() => server.close(), 1000)));
        restore();
      },
    };
  } catch (error) { restore(); throw error; }
}
export type McpCliContext = Awaited<ReturnType<typeof openMcpContext>>;
