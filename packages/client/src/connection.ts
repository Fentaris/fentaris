import { DEFAULT_API_KEY_HEADER, normalizeUrl, readConfig, type Profile } from "./config.js";
import { openCredentialStore, type CredentialRecord, type CredentialStore } from "./credentials.js";
import { ClientError, type NextAction } from "./errors.js";
import type { GlobalOptions } from "./framework.js";
import { refreshOAuth } from "./oauth.js";
import type { Runtime } from "./runtime.js";

/** Refresh slightly before expiry so a token does not lapse mid-request. */
const EXPIRY_SKEW_MS = 30_000;

export type Connection = {
  url: string;
  method: "oauth" | "api-key" | "access-token" | "none";
  source: "profile" | "environment";
  profileName?: string;
  profile?: Profile;
  store?: CredentialStore;
  headers(): Record<string, string>;
  /** Refresh OAuth credentials once; false when refreshing is impossible. */
  refresh?(): Promise<boolean>;
  loginAction(): NextAction;
  /** Non-secret credential facts for status output. */
  describe?(): { expiresAt?: string; tokenSubject?: string };
};

export async function resolveConnection(runtime: Runtime, global: GlobalOptions): Promise<Connection> {
  const config = await readConfig(runtime);
  const profileName = global.profile ?? config.activeProfile;
  const profile = profileName ? config.profiles[profileName] : undefined;
  if (global.profile && !profile && !runtime.env.FENTARIS_URL) {
    throw new ClientError("NOT_FOUND", `Profile "${global.profile}" does not exist.`, {}, [{ description: "List profiles", command: "frs profile list" }]);
  }
  const envUrl = runtime.env.FENTARIS_URL ? normalizeUrl(runtime.env.FENTARIS_URL) : undefined;
  const url = envUrl ?? profile?.url;
  const login: NextAction = { description: "Sign in to a Fentaris proxy", command: `frs auth login ${url ?? "<url>"}` };
  if (!url) throw new ClientError("NOT_LOGGED_IN", "No Fentaris proxy is configured. Sign in first or set FENTARIS_URL.", {}, [login]);
  const header = (runtime.env.FENTARIS_API_KEY_HEADER || profile?.apiKeyHeader || DEFAULT_API_KEY_HEADER).toLowerCase();
  const base = { url, profileName, profile, loginAction: () => login };

  if (runtime.env.FENTARIS_ACCESS_TOKEN) {
    const token = runtime.env.FENTARIS_ACCESS_TOKEN;
    return { ...base, method: "access-token", source: "environment", headers: () => ({ authorization: `Bearer ${token}` }) };
  }
  if (runtime.env.FENTARIS_API_KEY) {
    const key = runtime.env.FENTARIS_API_KEY;
    return { ...base, method: "api-key", source: "environment", headers: () => ({ [header]: key }) };
  }
  // Stored credentials are only ever sent to the URL they were issued for.
  if (!profile || !profileName || (envUrl && envUrl !== profile.url)) {
    return { ...base, method: "none", source: "environment", headers: () => ({}) };
  }
  const store = await openCredentialStore(runtime);
  let record = await store.get(profileName);
  if (!record) throw new ClientError("NOT_LOGGED_IN", `Profile "${profileName}" has no stored credentials.`, { profile: profileName }, [{ description: "Sign in again", command: `frs auth login ${profile.url}${profileName === "default" ? "" : ` --profile ${profileName}`}${profile.method === "api-key" ? " --with-api-key" : ""}` }]);
  const refresh = async (): Promise<boolean> => {
    if (record?.type !== "oauth" || !profile.oauth || !record.refreshToken) return false;
    record = await refreshOAuth(runtime, profile.oauth, record);
    await store.set(profileName, record);
    return true;
  };
  if (record.type === "oauth" && record.expiresAt !== undefined && record.expiresAt - EXPIRY_SKEW_MS < Date.now() && record.refreshToken) {
    await refresh().catch((error: unknown) => {
      throw error instanceof ClientError ? new ClientError(error.code, error.message, error.details, [login]) : error;
    });
  }
  return {
    ...base,
    method: record.type,
    source: "profile",
    store,
    headers: () => credentialHeaders(record!, header),
    refresh,
    describe: () => record?.type === "oauth" ? {
      ...(record.expiresAt ? { expiresAt: new Date(record.expiresAt).toISOString() } : {}),
      ...(tokenSubject(record.accessToken) ? { tokenSubject: tokenSubject(record.accessToken) } : {}),
    } : {},
  };
}

/** Display-only subject of a JWT access token; the proxy remains the verifier. */
function tokenSubject(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown; email?: unknown };
    return typeof claims.email === "string" ? claims.email : typeof claims.sub === "string" ? claims.sub : undefined;
  } catch { return undefined; }
}

function credentialHeaders(record: CredentialRecord, header: string): Record<string, string> {
  return record.type === "api-key" ? { [header]: record.apiKey } : { authorization: `Bearer ${record.accessToken}` };
}
