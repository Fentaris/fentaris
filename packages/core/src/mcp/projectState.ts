import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { credential } from "../credentials/index.js";
import { hasSharedProjectVault, mcpRuntimeVault } from "./runtimeVault.js";
import type { McpServer } from "../server/McpServer.js";
import { findEnvironmentProjectRoot } from "../environment.js";

/** Public binding metadata, never secret values. @pk */
export type McpConnectionBinding = {
  server: string;
  account: string;
  disconnected?: boolean;
  bindings?: Record<string, string>;
  updatedAt: number;
};
/** A credential source matches the shared project vault contract. @pk */
export type McpSecretSource = { type: "vault" } | { type: "environment"; name: string } | { type: "external"; provider: string; locator: string };
/** Versioned, non-secret connection registry. @pk */
export type McpConnectionState = { version: 1; connections: McpConnectionBinding[]; sources: Record<string, McpSecretSource> };

export function mcpStateDirectory(root = findEnvironmentProjectRoot()): string {
  for (const file of ["fentaris.json", "fentaris.config.json"]) {
    const name = path.join(root, file);
    if (existsSync(name)) {
      const config = JSON.parse(readFileSync(name, "utf8")) as { authDir?: string };
      return path.resolve(root, config.authDir ?? ".fentaris");
    }
  }
  return path.join(root, ".fentaris");
}

export function readMcpConnectionState(dir: string): McpConnectionState {
  const file = path.join(dir, "mcp-connections.json");
  if (!existsSync(file)) return { version: 1, connections: [], sources: {} };
  const state = JSON.parse(readFileSync(file, "utf8")) as McpConnectionState;
  if (!state || state.version !== 1 || !Array.isArray(state.connections) || !state.sources || typeof state.sources !== "object" || Array.isArray(state.sources)) throw new Error("Unsupported MCP connection registry. Restore a supported registry before continuing.");
  for (const entry of state.connections) {
    if (!entry || typeof entry.server !== "string" || !entry.server.trim() || typeof entry.account !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.account) || !Number.isFinite(entry.updatedAt) || (entry.disconnected !== undefined && typeof entry.disconnected !== "boolean") || (entry.bindings && (typeof entry.bindings !== "object" || Array.isArray(entry.bindings) || Object.values(entry.bindings).some((ref) => typeof ref !== "string" || !ref.trim() || ref.startsWith("fentaris.internal.oauth."))))) throw new Error("Invalid MCP connection registry.");
  }
  for (const [ref, source] of Object.entries(state.sources)) if (!ref.trim() || !source || !(source.type === "vault" || (source.type === "environment" && typeof source.name === "string" && source.name.trim()) || (source.type === "external" && typeof source.provider === "string" && source.provider.trim() && typeof source.locator === "string" && source.locator.trim()))) throw new Error("Invalid MCP credential source registry.");
  return state;
}

/** Publish a complete binding only after credentials/authentication succeeded. @pk */
export async function writeMcpConnectionState(dir: string, state: McpConnectionState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "mcp-connections.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** Serialize connection changes so concurrent account setup cannot lose another binding. @pk */
export async function updateMcpConnectionState(dir: string, mutate: (state: McpConnectionState) => McpConnectionState): Promise<McpConnectionState> {
  await mkdir(dir, { recursive: true });
  const lock = path.join(dir, "mcp-connections.lock");
  const started = Date.now();
  let handle;
  while (!handle) {
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await stat(lock).then((value) => Date.now() - value.mtimeMs > 15000).catch(() => false)) { await unlink(lock).catch(() => undefined); continue; }
      if (Date.now() - started > 5000) throw new Error("Timed out acquiring the MCP connection registry lock.", { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    const state = mutate(readMcpConnectionState(dir));
    await writeMcpConnectionState(dir, state);
    return state;
  } finally { await handle.close(); await unlink(lock).catch(() => undefined); }
}

/** Apply public bindings to existing configured servers. No implicit account creation. @pk */
export function applyMcpConnectionState(servers: readonly McpServer[], state: McpConnectionState): void {
  for (const entry of state.connections) {
    for (const server of servers.filter((candidate) => candidate.name === entry.server)) {
      if (!server.accountNames().includes(entry.account)) continue;
      server.bindAccount(entry.account, entry);
    }
  }
}

/** Local adapter to the current shared encrypted secrets system. @pk */
export async function resolveMcpProjectSecret(ref: string, dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (hasSharedProjectVault()) return mcpRuntimeVault(dir, env).resolve(ref);
  const source = readMcpConnectionState(dir).sources[ref];
  if (source?.type === "environment") return env[source.name];
  if (source?.type === "external") throw new Error(`External provider "${source.provider}" must be configured through the shared project vault.`);
  return mcpRuntimeVault(dir, env).resolve(ref);
}

export function bindingCredentials(entry: McpConnectionBinding): Record<string, ReturnType<typeof credential>> {
  return Object.fromEntries(Object.entries(entry.bindings ?? {}).map(([slot, ref]) => [slot, credential(ref)]));
}
