import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { discoverAuthorizationServerMetadata, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthProfile } from "./config.js";
import type { CredentialRecord } from "./credentials.js";
import { ClientError, toClientError } from "./errors.js";
import type { Runtime } from "./runtime.js";

/** RFC 9728 metadata plus the optional Fentaris CLI login hint. */
export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  fentaris_cli?: { client_id?: string; audience?: string; scopes?: string[] };
};

export type LoginOptions = { url: string; clientId?: string; scopes?: string[]; port?: number; printUrl: boolean; timeoutMs: number };

export async function discoverProtectedResource(runtime: Runtime, url: string): Promise<ProtectedResourceMetadata | undefined> {
  const candidates: string[] = [];
  try {
    const probe = await runtime.fetch(url, { headers: { accept: "application/json, text/event-stream" } });
    await probe.body?.cancel();
    const advertised = probe.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
    if (advertised) candidates.push(new URL(advertised, url).href);
  } catch (error) { throw toClientError(error, { url }); }
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/$/, "");
  candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource${path}`, `${parsed.origin}/.well-known/oauth-protected-resource`);
  for (const candidate of [...new Set(candidates)]) {
    const response = await runtime.fetch(candidate, { headers: { accept: "application/json" } }).catch((error: unknown) => { throw toClientError(error, { url }); });
    if (!response.ok) { await response.body?.cancel(); continue; }
    const body = await response.json().catch(() => undefined) as ProtectedResourceMetadata | undefined;
    if (body && typeof body.resource === "string") return body;
  }
  return undefined;
}

/** Interactive OAuth 2.1 authorization code + PKCE login with a loopback redirect. */
export async function oauthLogin(runtime: Runtime, options: LoginOptions): Promise<{ oauth: OAuthProfile; record: CredentialRecord }> {
  const metadata = await discoverProtectedResource(runtime, options.url);
  if (!metadata) throw new ClientError("LOGIN_FAILED", "The proxy does not advertise OAuth protected resource metadata.", { url: options.url }, [{ description: "Sign in with an API key instead", command: `frs auth login ${options.url} --with-api-key` }]);
  if (new URL(metadata.resource).origin !== new URL(options.url).origin) {
    // RFC 9728: never obtain tokens for a resource other than the one being contacted.
    throw new ClientError("LOGIN_FAILED", `The proxy advertises resource ${metadata.resource}, which does not match ${options.url}. Log in with the proxy's public URL.`, { url: options.url, advertisedResource: metadata.resource }, [{ description: "Log in with the advertised URL", command: `frs auth login ${metadata.resource}` }]);
  }
  const issuer = metadata.authorization_servers?.[0];
  if (!issuer) throw new ClientError("LOGIN_FAILED", "The proxy metadata names no authorization server.");
  const serverMetadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: runtime.fetch }).catch((error: unknown) => { throw toClientError(error, { url: issuer }); });
  if (!serverMetadata) throw new ClientError("LOGIN_FAILED", `Cannot discover authorization server metadata for ${issuer}.`, { authorizationServer: issuer });
  const hint = metadata.fentaris_cli ?? {};
  const scopes = options.scopes ?? hint.scopes ?? metadata.scopes_supported;
  const scope = scopes?.length ? scopes.join(" ") : undefined;

  const listener = await startLoopback(options.port);
  try {
    const { client, source } = await selectClient(runtime, issuer, serverMetadata, listener.redirectUri, scope, options.clientId ?? undefined, hint.client_id);
    const state = randomBytes(24).toString("base64url");
    const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, { metadata: serverMetadata, clientInformation: client, redirectUrl: listener.redirectUri, scope, state, resource: new URL(metadata.resource) });
    if (hint.audience) authorizationUrl.searchParams.set("audience", hint.audience);
    runtime.error(`Open this URL to sign in to Fentaris:\n  ${authorizationUrl.href}\n`);
    if (!options.printUrl) await runtime.openUrl(authorizationUrl.href);
    const callback = await listener.wait(options.timeoutMs);
    if (callback.get("state") !== state) throw new ClientError("LOGIN_FAILED", "The authorization response state does not match this login attempt.");
    const error = callback.get("error");
    if (error) throw new ClientError("LOGIN_FAILED", `The authorization server returned ${error}${callback.get("error_description") ? `: ${callback.get("error_description")}` : ""}.`, { error });
    const code = callback.get("code");
    if (!code) throw new ClientError("LOGIN_FAILED", "The authorization response contains no code.");
    const tokens = await exchangeAuthorization(issuer, { metadata: serverMetadata, clientInformation: client, authorizationCode: code, codeVerifier, redirectUri: listener.redirectUri, resource: new URL(metadata.resource), fetchFn: runtime.fetch })
      .catch((cause: unknown) => { throw new ClientError("LOGIN_FAILED", `The token exchange failed: ${(cause as Error).message}`); });
    return {
      oauth: { authorizationServer: issuer, clientId: client.client_id, clientSource: source, resource: metadata.resource, ...(scopes?.length ? { scopes } : {}), ...(hint.audience ? { audience: hint.audience } : {}) },
      record: tokenRecord(tokens, client.client_secret),
    };
  } finally {
    await listener.close();
  }
}

export async function refreshOAuth(runtime: Runtime, oauth: OAuthProfile, record: Extract<CredentialRecord, { type: "oauth" }>): Promise<Extract<CredentialRecord, { type: "oauth" }>> {
  if (!record.refreshToken) throw new ClientError("AUTH_REQUIRED", "The access token expired and no refresh token is available.");
  try {
    const metadata = await discoverAuthorizationServerMetadata(oauth.authorizationServer, { fetchFn: runtime.fetch });
    const tokens = await refreshAuthorization(oauth.authorizationServer, { metadata, clientInformation: { client_id: oauth.clientId, ...(record.clientSecret ? { client_secret: record.clientSecret } : {}) }, refreshToken: record.refreshToken, resource: new URL(oauth.resource), fetchFn: runtime.fetch });
    return { ...tokenRecord(tokens, record.clientSecret), refreshToken: tokens.refresh_token ?? record.refreshToken };
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError("AUTH_REQUIRED", `The token refresh failed: ${(error as Error).message}`);
  }
}

async function selectClient(runtime: Runtime, issuer: string, metadata: AuthorizationServerMetadata, redirectUri: string, scope: string | undefined, flag: string | undefined, hinted: string | undefined): Promise<{ client: OAuthClientInformationMixed; source: OAuthProfile["clientSource"] }> {
  if (flag) return { client: { client_id: flag }, source: "flag" };
  if (hinted) return { client: { client_id: hinted }, source: "proxy-hint" };
  if (!metadata.registration_endpoint) {
    throw new ClientError("OAUTH_CLIENT_REQUIRED", "The proxy advertises no CLI client and the authorization server does not support dynamic client registration.", { authorizationServer: issuer }, [{ description: "Pass the OAuth client ID registered for the CLI", command: "frs auth login <url> --client-id <CLIENT_ID> --port <PORT>" }]);
  }
  const registered = await registerClient(issuer, {
    metadata,
    clientMetadata: { client_name: "Fentaris CLI (frs)", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}) },
    fetchFn: runtime.fetch,
  }).catch((error: unknown) => { throw new ClientError("LOGIN_FAILED", `Dynamic client registration failed: ${(error as Error).message}`); });
  return { client: registered, source: "dynamic-registration" };
}

function tokenRecord(tokens: OAuthTokens, clientSecret: string | undefined): Extract<CredentialRecord, { type: "oauth" }> {
  return {
    type: "oauth",
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(typeof tokens.expires_in === "number" ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

async function startLoopback(port: number | undefined) {
  let deliver: (params: URLSearchParams) => void = () => undefined;
  const received = new Promise<URLSearchParams>((resolve) => { deliver = resolve; });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const failed = url.searchParams.has("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Fentaris</title><p>${failed ? "Sign-in failed. Return to the terminal for details." : "Signed in to Fentaris. You can close this window."}</p>`);
    deliver(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE" ? new ClientError("INVALID_ARGUMENTS", `Port ${port} is already in use; choose another --port.`) : error));
    server.listen(port ?? 0, "127.0.0.1", () => resolve());
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  return {
    redirectUri,
    async wait(timeoutMs: number): Promise<URLSearchParams> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ClientError("LOGIN_FAILED", `No sign-in completed within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs); });
      try { return await Promise.race([received, timeout]); } finally { clearTimeout(timer); }
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
