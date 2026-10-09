import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpProxyOptions } from "../proxy/McpProxy.js";
import type { McpServer, McpSecretResolver } from "../server/McpServer.js";
import type { OAuthTokenStore, OAuthStoreRecord } from "../auth/oauth/store.js";
import { oauthTokensExpireAt } from "../auth/oauth/store.js";
import { createOAuthManager } from "../proxy/oauthRuntime.js";

export type McpAuthenticationState = "none" | "server-managed" | "unverified" | "stored" | "refresh-needed" | "authorized" | "missing" | "expired" | "invalid" | "migration-required" | "disconnected";
export type McpDiscoveredTool = Tool & { upstreamName: string };
export type McpDiscoveryRow = {
  server: string;
  account: string;
  description?: string;
  transport: string;
  endpoint?: string;
  configuration: { valid: boolean; errors: string[] };
  authentication: { method: string; state: McpAuthenticationState; verified: boolean; expiresAt?: number; providerIdentity?: Record<string, string>; permissions?: string[]; references: string[] };
  connectivity: "unverified" | "reachable" | "unreachable" | "timeout" | "not-checked";
  status: string;
  toolCount: number | null;
  tools: McpDiscoveredTool[];
  toolMetadata: { source: "verified" | "cached" | "unavailable"; checkedAt?: number; ageMs?: number };
  recovery: string[];
  error?: { code: string; message: string };
};
export type McpDiscoveryResult = {
  version: 1;
  outcome: "success" | "partial" | "failure";
  offline: boolean;
  connections: McpDiscoveryRow[];
  summary: { configured: number; succeeded: number; failed: number; tools: number; verifiedTools: number; cachedTools: number; message: string };
  exitCode: 0 | 1 | 3;
};
export type McpDiscoveryCache = Record<string, { checkedAt: number; tools: McpDiscoveredTool[] }>;
export type McpDiscoveryOptions = { server?: string; account?: string; offline?: boolean; timeoutMs?: number; signal?: AbortSignal; cache?: McpDiscoveryCache; onProgress?: (completed: number, total: number) => void };

/** Administrative discovery bypasses downstream identity selection, never runtime authorization. @pk */
export class McpDiscoveryService {
  readonly servers: McpServer[];
  constructor(readonly config: McpProxyOptions, private readonly dependencies: { secrets: McpSecretResolver; oauthStore?: OAuthTokenStore }) {
    this.servers = [...new Set([...(config.servers ?? []), ...(config.groups ?? []).flatMap((group) => group.servers)])];
    for (const server of this.servers) server.attachAccountSecrets(dependencies.secrets);
    if (dependencies.oauthStore) createOAuthManager({ servers: this.servers.flatMap((server) => server.accountNames().flatMap((account) => {
      try { return [server.account(account)]; } catch { return []; } // Invalid accounts remain inventory rows.
    })), options: config.oauth, store: dependencies.oauthStore, resolveClientSecret: (server) => {
      const secret = server.getOAuthAuth()?.clientSecret;
      return typeof secret === "object" ? () => dependencies.secrets(secret.reference) : undefined;
    } });
  }

  async discover(options: McpDiscoveryOptions = {}): Promise<McpDiscoveryResult> {
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error("Timeout must be an integer from 1 to 60000 milliseconds.");
    if (options.server && !this.servers.some((server) => server.name === options.server)) throw new Error(`Unknown configured MCP "${options.server}".`);
    const selected = this.servers.filter((server) => !options.server || server.name === options.server);
    const targets = selected.flatMap((server) => {
      const names = server.accountNames();
      return (names.length ? names : [""]).filter((account) => !options.account || account === options.account).map((account) => ({ server, account }));
    });
    if (options.account && targets.length === 0) throw new Error(`No configured upstream account "${options.account}" matches this filter.`);
    let completed = 0;
    // Configuration can contain many upstreams: cap simultaneous processes/connections.
    const rows: McpDiscoveryRow[] = new Array(targets.length);
    let index = 0;
    const worker = async () => {
      while (index < targets.length) {
        const i = index++;
        const target = targets[i];
        rows[i] = await this.inspect(target.server, target.account, { ...options, timeoutMs: timeout });
        options.onProgress?.(++completed, targets.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    const failed = options.offline ? rows.filter((row) => !row.configuration.valid).length : rows.filter((row) => row.connectivity !== "reachable").length;
    const succeeded = rows.length - failed;
    const outcome = failed === 0 ? "success" : succeeded > 0 ? "partial" : "failure";
    return { version: 1, outcome, offline: options.offline === true, connections: rows,
      summary: { configured: rows.length, succeeded, failed, tools: rows.reduce((sum, row) => sum + row.tools.length, 0), verifiedTools: rows.filter((row) => row.toolMetadata.source === "verified").reduce((sum, row) => sum + row.tools.length, 0), cachedTools: rows.filter((row) => row.toolMetadata.source === "cached").reduce((sum, row) => sum + row.tools.length, 0), message: rows.length === 0 ? "No MCP servers are configured." : options.offline ? "Offline inventory: remote authentication and connectivity are unverified." : `${succeeded}/${rows.length} connections checked successfully; ${failed} require attention.` },
      exitCode: outcome === "failure" ? 1 : outcome === "partial" ? 3 : 0 };
  }

  private async inspect(server: McpServer, account: string, options: McpDiscoveryOptions): Promise<McpDiscoveryRow> {
    const deadline = Date.now() + options.timeoutMs!;
    const remaining = () => Math.max(1, deadline - Date.now());
    const row: McpDiscoveryRow = { server: server.name, account, description: server.description, transport: server.transport?.constructor?.name ?? "custom", endpoint: endpointOf(server.transport),
      configuration: { valid: true, errors: [] }, authentication: { method: "unknown", state: "unverified", verified: false, references: [] }, connectivity: "unverified", status: "Unverified", toolCount: null, tools: [], toolMetadata: { source: "unavailable" }, recovery: [] };
    const next = `fentaris mcp auth connect ${server.name} --account ${account}`;
    let connection: McpServer | undefined;
    let contactingUpstream = false;
    try {
      if (!account) throw new Error("No upstream accounts are configured.");
      if (this.servers.filter((candidate) => candidate.name === server.name).length > 1) throw new Error("MCP name is ambiguous across configured scopes. Use distinct MCP names or a shared server declaration.");
      connection = server.account(account);
      row.transport = connection.transport.constructor?.name ?? "custom";
      row.endpoint = endpointOf(connection.transport);
      const auth = connection.authentication();
      if (typeof connection.transport.listTools !== "function" || typeof connection.transport.close !== "function") throw new Error("Transport must implement listTools and close.");
      if (auth?.type === "oauth" && !("withAuthProvider" in connection.transport)) throw new Error("Configured transport does not support upstream OAuth.");
      if (auth?.type === "oauth" && (auth.registration === "preregistered" || auth.grant === "client_credentials") && !auth.clientId) throw new Error("Configured OAuth flow requires a client identifier.");
      if (auth?.type === "oauth" && auth.registration === "metadata-url" && !auth.clientMetadataUrl) throw new Error("Configured OAuth flow requires a client metadata URL.");
      row.authentication.method = auth?.type ?? (connection.getCredentialBindings().length ? "credentials" : "none");
      row.authentication.references = connection.getCredentialBindings().map((binding) => binding.credential.reference);
      if (auth?.type === "oauth" && typeof auth.clientSecret === "object") row.authentication.references.push(auth.clientSecret.reference);
      if (row.authentication.references.some((ref) => typeof ref !== "string" || !ref.trim() || ref.startsWith("fentaris.internal.oauth."))) throw new Error("Credential references must name ordinary nonempty secrets, not OAuth lifecycle records.");
    } catch (error) {
      row.configuration = { valid: false, errors: [error instanceof Error ? error.message : "Invalid connection configuration."] };
      row.status = "Invalid configuration"; row.connectivity = "not-checked";
      row.recovery = [`Correct the configuration for MCP "${server.name}"; then run fentaris mcp get ${server.name}.`];
      return row;
    }
    const cached = options.cache?.[`${server.name}\u0000${account}`];
    if (cached) {
      row.tools = cached.tools; row.toolCount = cached.tools.length;
      row.toolMetadata = { source: "cached", checkedAt: cached.checkedAt, ageMs: Math.max(0, Date.now() - cached.checkedAt) };
    }
    try {
      await bounded(async () => {
        const declaration = server.accountOptions(account);
        const auth = connection!.authentication();
        if (declaration.disconnected) row.authentication.state = "disconnected";
        else if (!auth || auth.type === "none") row.authentication.state = row.authentication.references.length ? "stored" : "none";
        else if (auth.type === "managed") row.authentication.state = "server-managed";
        else if (auth.type === "oauth") {
          const record = await this.dependencies.oauthStore?.get(server.name, `account:${account}`);
          const legacy = !record && (await this.dependencies.oauthStore?.list())?.some((entry) => entry.server === server.name && !entry.session.startsWith("account:") && entry.hasTokens);
          if (record?.tokens?.scope) row.authentication.permissions = record.tokens.scope.split(" ");
          row.authentication.expiresAt = oauthTokensExpireAt(record?.tokens);
          row.authentication.state = legacy ? "migration-required" : oauthState(record, auth.grant === "client_credentials");
        } else row.authentication.state = "stored";
        for (const ref of row.authentication.references) if (!await this.dependencies.secrets(ref)) row.authentication.state = "missing";
      }, remaining(), options.signal);
      if (["missing", "expired", "invalid", "migration-required", "disconnected"].includes(row.authentication.state)) {
        row.status = row.authentication.state === "migration-required" ? "Migration required" : "Login needed";
        row.connectivity = "not-checked";
        row.recovery = row.authentication.state === "migration-required" ? [`fentaris mcp auth migrate ${server.name} --account ${account} --from-session <legacy-session>`] : [next];
        if (!options.offline) row.error = { code: "AUTHENTICATION_REQUIRED", message: "Connect this upstream account before discovery." };
        return row;
      }
      if (options.offline) { row.status = "Unverified"; return row; }
      contactingUpstream = true;
      const tools = await bounded(async () => {
        const result: McpDiscoveredTool[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await connection!.listTools(cursor ? { cursor } : undefined);
          for (const tool of page.tools) result.push({ ...tool, upstreamName: tool.name, name: `${server.name}__${tool.name}` });
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error("Repeated upstream discovery cursor.");
          if (cursor) seen.add(cursor);
        } while (cursor);
        return result;
      }, remaining(), options.signal);
      row.tools = tools; row.toolCount = tools.length; row.toolMetadata = { source: "verified", checkedAt: Date.now() };
      row.connectivity = "reachable"; row.status = "Ready";
      if (row.authentication.method === "oauth" && ["stored", "refresh-needed", "unverified"].includes(row.authentication.state)) { row.authentication.state = "authorized"; row.authentication.verified = true; }
      if (row.authentication.method === "oauth" && Date.now() < deadline) {
        const current = await bounded(() => this.dependencies.oauthStore!.get(server.name, `account:${account}`), remaining(), options.signal).catch(() => undefined);
        row.authentication.expiresAt = oauthTokensExpireAt(current?.tokens);
        row.authentication.permissions = current?.tokens?.scope?.split(" ");
      }
      const inspectIdentity = server.accountOptions(account).inspectIdentity;
      if (inspectIdentity && Date.now() < deadline) {
        // A failed optional provider lookup does not erase successful tool discovery.
        const metadata = await bounded(inspectIdentity, remaining(), options.signal).catch(() => undefined);
        if (metadata?.identity) {
          row.authentication.providerIdentity = metadata.identity;
          if (!["none", "managed"].includes(row.authentication.method)) { row.authentication.state = "authorized"; row.authentication.verified = true; }
        }
        if (metadata?.permissions) row.authentication.permissions = metadata.permissions;
      }
      if (tools.length === 0) row.recovery = [`MCP "${server.name}" account "${account}" exposes no tools.`];
    } catch (error) {
      const timeout = error instanceof DiscoveryTimeout;
      const cancelled = options.signal?.aborted;
      const unauthorized = isAuthorizationFailure(error);
      row.connectivity = !contactingUpstream ? "not-checked" : timeout ? "timeout" : "unreachable";
      if (unauthorized) { row.authentication.state = "invalid"; row.status = "Login needed"; row.recovery = [`${next} --reauth`]; }
      else if (!contactingUpstream) { row.status = "Credentials unavailable"; row.recovery = [`Unlock or repair the project credential vault; then run fentaris mcp auth get ${server.name} --account ${account}.`]; }
      else { row.status = timeout ? "Timed out" : "Unreachable"; row.recovery = [`Check the configured endpoint or upstream process; then run fentaris mcp get ${server.name} --account ${account}.`]; }
      row.error = { code: cancelled ? "CANCELLED" : !contactingUpstream ? "CREDENTIALS_UNAVAILABLE" : timeout ? "TIMEOUT" : unauthorized ? "INVALID_AUTHORIZATION" : "UPSTREAM_UNAVAILABLE", message: cancelled ? "Discovery cancelled." : !contactingUpstream ? "Local credentials could not be resolved; upstream connectivity was not checked." : timeout ? "Connection check exceeded its deadline." : unauthorized ? "Upstream authorization was rejected." : "The upstream connection is unavailable." };
    } finally {
      // Close even while a handshake is pending. Native transports own pending clients too.
      await bounded(() => connection!.close(), Math.min(options.timeoutMs!, 1000)).catch(() => undefined);
    }
    return row;
  }
}

function oauthState(record: OAuthStoreRecord | undefined, clientCredentials: boolean): McpAuthenticationState {
  if (clientCredentials) return "unverified";
  if (!record?.tokens?.access_token) return "missing";
  const expiry = oauthTokensExpireAt(record.tokens);
  return expiry !== undefined && expiry <= Date.now() ? record.tokens.refresh_token ? "refresh-needed" : "expired" : "stored";
}
export class DiscoveryTimeout extends Error {}
export async function bounded<T>(run: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { if (signal?.aborted) throw new Error("Cancelled"); return run(); }), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DiscoveryTimeout()), timeoutMs);
      abort = () => reject(new Error("Cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
function isAuthorizationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; code?: unknown; status?: unknown; message?: string; cause?: unknown };
  return value.name === "UnauthorizedError" || value.name === "OAuthAuthorizationRequiredError" || value.status === 401 || value.status === 403 || /\b(?:401|403|invalid_grant)\b/.test(value.message ?? "") || (value.cause !== error && isAuthorizationFailure(value.cause));
}
export function endpointOf(transport: unknown): string | undefined {
  const value = transport as { upstreamUrl?: string };
  if (typeof value?.upstreamUrl !== "string") return undefined;
  try { const url = new URL(value.upstreamUrl); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "[invalid endpoint]"; }
}
