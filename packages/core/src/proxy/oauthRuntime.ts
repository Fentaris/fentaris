import path from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OAuthManager } from "../auth/oauth/manager.js";
import { LocalOAuthTokenStore, MemoryOAuthTokenStore, type OAuthTokenStore } from "../auth/oauth/store.js";
import type { McpServer } from "../server/McpServer.js";
import type { FentarisTransport } from "../types/transport.js";

/** Default path of the Fentaris-hosted OAuth redirect callback. @pk */
export const DEFAULT_OAUTH_CALLBACK_PATH = "/_fentaris/oauth/callback";

/** Default directory holding local Fentaris auth state. @pk */
export const DEFAULT_AUTH_DIR = ".fentaris";

/**
 * Proxy-level OAuth options.
 * @pk
 */
export type ProxyOAuthOptions = {
  /** Externally reachable base URL of this proxy, required behind a reverse proxy. @pk */
  publicUrl?: string;
  /** Path of the hosted redirect callback. @pk */
  callbackPath?: string;
  /** Token store; defaults to the encrypted local store when a key is available. @pk */
  store?: OAuthTokenStore;
  /** Directory of the encrypted local token store. @pk */
  authDir?: string;
  /** How long a tool call waits for the human to finish consent. @pk */
  consentTimeoutMs?: number;
  /** How long a pending authorization stays valid. @pk */
  pendingTtlMs?: number;
  /** Register the built-in `fentaris__auth_*` agent tools. @pk */
  agentTools?: boolean;
};

/**
 * Transport surface required to drive OAuth against an upstream MCP server.
 * @pk
 */
export type OAuthCapableTransport = FentarisTransport & {
  readonly upstreamUrl: string;
  createGuardedFetch(): FetchLike;
  withAuthProvider(provider: unknown): FentarisTransport;
};

/**
 * Whether a transport can carry an OAuth client provider to an upstream MCP server.
 * @pk
 */
export function isOAuthCapableTransport(transport: FentarisTransport): transport is OAuthCapableTransport {
  return (
    "withAuthProvider" in transport &&
    typeof (transport as OAuthCapableTransport).withAuthProvider === "function" &&
    typeof (transport as OAuthCapableTransport).upstreamUrl === "string" &&
    typeof (transport as OAuthCapableTransport).createGuardedFetch === "function"
  );
}

/**
 * Servers declared with `oauth()`.
 * @pk
 */
export function oauthServers(servers: readonly McpServer[]): McpServer[] {
  return servers.filter((server) => Boolean(server.getOAuthAuth()));
}

/**
 * Resolve the token store for a proxy: explicit store, encrypted local store when
 * a key is available, otherwise an ephemeral in-memory store.
 * @pk
 */
export function resolveOAuthStore(options: ProxyOAuthOptions | undefined): {
  store: OAuthTokenStore;
  ephemeral: boolean;
} {
  if (options?.store) {
    return { store: options.store, ephemeral: false };
  }

  const key = process.env.FENTARIS_AUTH_KEY;
  if (!key) {
    return { store: new MemoryOAuthTokenStore(), ephemeral: true };
  }

  return { store: new LocalOAuthTokenStore({ dir: path.resolve(options?.authDir ?? DEFAULT_AUTH_DIR), key }), ephemeral: false };
}

/**
 * Normalized callback path for the hosted OAuth redirect route.
 * @pk
 */
export function oauthCallbackPath(options: ProxyOAuthOptions | undefined): string {
  const configured = options?.callbackPath?.trim();
  if (!configured) {
    return DEFAULT_OAUTH_CALLBACK_PATH;
  }

  return configured.startsWith("/") ? configured.replace(/\/+$/, "") || "/" : `/${configured}`;
}

/**
 * Derive the absolute callback URL from the configured public URL or the bound listener.
 * @pk
 */
export function deriveOAuthCallbackUrl(
  options: ProxyOAuthOptions | undefined,
  listener: { host?: string; port: number; secure?: boolean },
): string {
  const callbackPath = oauthCallbackPath(options);
  const publicUrl = options?.publicUrl?.trim();
  if (publicUrl) {
    // Keep any path prefix on publicUrl: behind a reverse proxy that mounts Fentaris
    // under a subpath, dropping it would advertise a callback nobody serves.
    const base = new URL(publicUrl);
    const prefix = base.pathname.replace(/\/+$/, "");
    base.pathname = `${prefix}${callbackPath}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  }

  const host = !listener.host || listener.host === "0.0.0.0" || listener.host === "::" ? "localhost" : listener.host;
  const hostPart = host.includes(":") ? `[${host}]` : host;
  return `${listener.secure ? "https" : "http"}://${hostPart}:${listener.port}${callbackPath}`;
}

/**
 * Build a manager and register every OAuth-declared server on it.
 * @pk
 */
export function createOAuthManager(params: {
  servers: readonly McpServer[];
  options: ProxyOAuthOptions | undefined;
  store: OAuthTokenStore;
  clientName?: string;
  clientUri?: string;
  resolveClientSecret?: (server: McpServer) => (() => Promise<string | undefined>) | undefined;
}): OAuthManager | undefined {
  const declared = oauthServers(params.servers);
  if (declared.length === 0) {
    return undefined;
  }

  const manager = new OAuthManager({
    store: params.store,
    consentTimeoutMs: params.options?.consentTimeoutMs,
    pendingTtlMs: params.options?.pendingTtlMs,
    clientName: params.clientName,
    clientUri: params.clientUri,
  });

  for (const server of declared) {
    const auth = server.getOAuthAuth();
    const transport = server.transport;
    if (!auth || !isOAuthCapableTransport(transport)) {
      continue;
    }

    manager.register(server.name, {
      auth,
      serverUrl: transport.upstreamUrl,
      fetchFn: transport.createGuardedFetch(),
      ...(params.resolveClientSecret?.(server) ? { resolveClientSecret: params.resolveClientSecret(server) } : {}),
    });
    server.attachOAuth((user) => manager.providerFor(server.name, user));
  }

  return manager;
}
