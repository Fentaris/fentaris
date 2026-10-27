import { DEFAULT_API_KEY_HEADER, isLoopback, normalizeUrl, readConfig, validateProfileName, writeConfig, type ClientConfig, type Profile } from "../config.js";
import type { Connection } from "../connection.js";
import { resolveConnection } from "../connection.js";
import { openCredentialStore, type CredentialRecord, type CredentialStore } from "../credentials.js";
import { ClientError, toClientError } from "../errors.js";
import { integerOption, stringOption, type CommandContext } from "../framework.js";
import { oauthLogin } from "../oauth.js";
import type { CommandResult } from "../output.js";
import { withSession } from "../session.js";

const LOGIN_TIMEOUT_MS = 300_000;

export async function authLogin(context: CommandContext): Promise<CommandResult> {
  const { runtime, global, options } = context;
  const config = await readConfig(runtime);
  const explicit = global.profile ? config.profiles[global.profile] : undefined;
  const supplied = context.args[0] ?? explicit?.url ?? (global.profile ? undefined : config.activeProfile ? config.profiles[config.activeProfile]?.url : undefined);
  if (!supplied) throw new ClientError("INVALID_ARGUMENTS", "Pass the proxy MCP endpoint URL.", {}, [{ description: "Sign in to a proxy", command: "frs auth login https://proxy.example/mcp" }]);
  const url = normalizeUrl(supplied);
  const name = validateProfileName(global.profile ?? profileFor(config, url));
  const warnings: string[] = [];
  if (new URL(url).protocol === "http:" && !isLoopback(url)) warnings.push(`${url} is not encrypted; credentials will be sent in clear text.`);

  const store = await openCredentialStore(runtime);
  let profile: Profile;
  let record: CredentialRecord;
  if (options["with-api-key"] === true) {
    if (options["client-id"] !== undefined || options.scope !== undefined || options.port !== undefined || options["print-url"] !== undefined) throw new ClientError("INVALID_ARGUMENTS", "--with-api-key cannot be combined with OAuth options.");
    const apiKey = (await runtime.readSecret("Fentaris API key: ")).trim();
    if (!apiKey) throw new ClientError("INVALID_ARGUMENTS", "No API key was provided on standard input.", {}, [{ description: "Pipe the key on stdin", command: `printf '%s' "$FENTARIS_API_KEY" | frs auth login ${url} --with-api-key` }]);
    const header = (stringOption(options, "api-key-header") ?? config.profiles[name]?.apiKeyHeader ?? DEFAULT_API_KEY_HEADER).toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header)) throw new ClientError("INVALID_ARGUMENTS", `"${header}" is not a valid HTTP header name.`);
    record = { type: "api-key", apiKey };
    await verify(context, { url, method: "api-key", source: "profile", headers: () => ({ [header]: apiKey }), loginAction: () => ({ description: "Sign in again", command: `frs auth login ${url} --with-api-key` }) }, "UNAUTHORIZED");
    profile = { url, method: "api-key", ...(header !== DEFAULT_API_KEY_HEADER ? { apiKeyHeader: header } : {}), updatedAt: new Date().toISOString() };
  } else {
    if (options["api-key-header"] !== undefined) throw new ClientError("INVALID_ARGUMENTS", "--api-key-header is only valid with --with-api-key.");
    const scope = stringOption(options, "scope");
    const login = await oauthLogin(runtime, {
      url,
      clientId: stringOption(options, "client-id"),
      scopes: scope ? scope.split(/[\s,]+/).filter(Boolean) : undefined,
      port: options.port === undefined ? undefined : integerOption(options, "port", 0, 65535),
      printUrl: options["print-url"] === true || global.nonInteractive,
      timeoutMs: options.timeout === undefined ? LOGIN_TIMEOUT_MS : global.timeoutMs,
      requestTimeoutMs: global.timeoutMs,
    });
    const token = login.record.type === "oauth" ? login.record.accessToken : "";
    await verify(context, { url, method: "oauth", source: "profile", headers: () => ({ authorization: `Bearer ${token}` }), loginAction: () => ({ description: "Sign in again", command: `frs auth login ${url}` }) }, "LOGIN_FAILED");
    profile = { url, method: "oauth", oauth: login.oauth, updatedAt: new Date().toISOString() };
    record = login.record;
  }
  await store.set(name, record);
  config.profiles[name] = profile;
  config.activeProfile = name;
  await writeConfig(runtime, config);
  if (store.kind === "file") warnings.push(`No system keychain is available; credentials are stored in the owner-only file ${store.location}.`);
  return {
    data: { profile: name, url, method: profile.method, storage: storage(store), active: true },
    warnings,
    nextActions: [{ description: "List the tools you can use", command: "frs tools list" }],
    human: () => `Logged in to ${url} (profile "${name}", ${profile.method === "oauth" ? "OAuth" : "API key"}). Credentials: ${store.location}.`,
  };
}

export async function authStatus(context: CommandContext): Promise<CommandResult> {
  const connection = await resolveConnection(context.runtime, context.global);
  const data: Record<string, unknown> = {
    profile: connection.profileName && connection.source === "profile" ? connection.profileName : null,
    url: connection.url,
    method: connection.method,
    source: connection.source,
    storage: connection.store ? storage(connection.store) : null,
    ...(connection.describe?.() ?? {}),
  };
  try {
    const server = await withSession(context.runtime, connection, context.global, async (session) => {
      await session.client.listTools(undefined, session.options);
      return session.client.getServerVersion() ?? null;
    });
    Object.assign(data, { verified: true, server });
  } catch (error) {
    const failure = toClientError(error, { url: connection.url });
    throw new ClientError(failure.code, failure.message, { ...failure.details, ...data, verified: false }, failure.nextActions.length ? failure.nextActions : [connection.loginAction()]);
  }
  return {
    data,
    human: () => [
      `Proxy:    ${connection.url}`,
      `Profile:  ${data.profile ?? "(environment)"}`,
      `Method:   ${connection.method}${connection.source === "environment" ? " (from environment)" : ""}`,
      ...(data.tokenSubject ? [`Subject:  ${String(data.tokenSubject)}`] : []),
      ...(data.expiresAt ? [`Expires:  ${String(data.expiresAt)}`] : []),
      ...(connection.store ? [`Storage:  ${connection.store.location}`] : []),
      "Verified: yes",
    ].join("\n"),
  };
}

export async function authLogout(context: CommandContext): Promise<CommandResult> {
  const config = await readConfig(context.runtime);
  const name = context.global.profile ?? config.activeProfile;
  if (!name || !config.profiles[name]) throw new ClientError("NOT_LOGGED_IN", name ? `Profile "${name}" does not exist.` : "No profile is active.", {}, [{ description: "List profiles", command: "frs profile list" }]);
  const store = await openCredentialStore(context.runtime);
  const removed = await store.delete(name);
  return {
    data: { profile: name, removed },
    nextActions: [{ description: "Sign in again", command: `frs auth login ${config.profiles[name].url}${name === "default" ? "" : ` --profile ${name}`}` }],
    human: () => removed ? `Logged out of profile "${name}". The profile URL was kept.` : `Profile "${name}" had no stored credentials.`,
  };
}

async function verify(context: CommandContext, connection: Connection, code: "UNAUTHORIZED" | "LOGIN_FAILED"): Promise<void> {
  try {
    await withSession(context.runtime, connection, context.global, (session) => session.client.listTools(undefined, session.options));
  } catch (error) {
    const failure = toClientError(error, { url: connection.url });
    if (["AUTH_REQUIRED", "UNAUTHORIZED"].includes(failure.code)) throw new ClientError(code, `The proxy rejected the new credentials: ${failure.message}`, failure.details);
    throw failure;
  }
}

function storage(store: CredentialStore) {
  return { kind: store.kind, location: store.location };
}

/** Reuse the profile already bound to this URL; otherwise derive a stable name. */
function profileFor(config: ClientConfig, url: string): string {
  const existing = Object.entries(config.profiles).find(([, profile]) => profile.url === url);
  if (existing) return existing[0];
  if (!config.profiles.default) return "default";
  const base = new URL(url).hostname.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 56) || "proxy";
  let candidate = base;
  for (let suffix = 2; config.profiles[candidate]; suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}
