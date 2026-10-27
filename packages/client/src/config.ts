import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { dirname, join } from "node:path";
import { ClientError } from "./errors.js";
import type { Runtime } from "./runtime.js";

export const DEFAULT_API_KEY_HEADER = "x-fentaris-api-key";

export type OAuthProfile = {
  /** Authorization server issuer URL from the proxy's protected resource metadata. */
  authorizationServer: string;
  clientId: string;
  clientSource: "flag" | "proxy-hint" | "dynamic-registration";
  resource: string;
  scopes?: string[];
  audience?: string;
};

/** Non-secret connection metadata. Credentials live in the credential store. */
export type Profile = {
  url: string;
  method: "oauth" | "api-key";
  apiKeyHeader?: string;
  oauth?: OAuthProfile;
  updatedAt: string;
};

export type ClientConfig = { version: 1; activeProfile?: string; profiles: Record<string, Profile> };

export function configDirectory(runtime: Runtime): string {
  if (runtime.env.FENTARIS_CLIENT_CONFIG_DIR) return runtime.env.FENTARIS_CLIENT_CONFIG_DIR;
  const base = runtime.env.XDG_CONFIG_HOME || join(runtime.homedir, ".config");
  return join(base, "fentaris-client");
}

export async function readConfig(runtime: Runtime): Promise<ClientConfig> {
  try {
    const parsed = JSON.parse(await readFile(join(configDirectory(runtime), "config.json"), "utf8")) as Partial<ClientConfig>;
    if (parsed.version !== 1 || typeof parsed.profiles !== "object" || !parsed.profiles) throw new Error("unsupported format");
    return { version: 1, activeProfile: parsed.activeProfile, profiles: parsed.profiles };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
    throw new ClientError("INTERNAL_ERROR", `Cannot read ${join(configDirectory(runtime), "config.json")}: ${(error as Error).message}.`);
  }
}

export async function writeConfig(runtime: Runtime, config: ClientConfig): Promise<void> {
  await writePrivateFile(join(configDirectory(runtime), "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** Atomic owner-only write: a crash never leaves a truncated file behind. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export function validateProfileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new ClientError("INVALID_ARGUMENTS", "Profile names may contain letters, numbers, dots, underscores, and hyphens (max 64 characters).");
  return name;
}

export function normalizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ClientError("INVALID_ARGUMENTS", `"${value}" is not a valid URL. Pass the proxy MCP endpoint, for example https://proxy.example/mcp.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ClientError("INVALID_ARGUMENTS", "The proxy URL must use https:// or http://.");
  if (url.username || url.password) throw new ClientError("INVALID_ARGUMENTS", "The proxy URL must not contain credentials.");
  url.hash = "";
  return url.href;
}

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "[::1]" || (isIPv4(host) && host.startsWith("127."));
}
