import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Behavior toggles for negative-path testing.
 */
export type AuthorizationServerToggles = {
  /** Reject dynamic client registration. */
  rejectRegistration?: boolean;
  /** Reject every refresh_token grant. */
  rejectRefresh?: boolean;
  /** Treat the next token request's client as unknown. */
  rejectClient?: boolean;
  /** Lifetime of issued access tokens in seconds. */
  accessTokenTtlSeconds?: number;
  /** Issue no refresh token. */
  withoutRefreshToken?: boolean;
  /** Do not advertise dynamic client registration. */
  withoutRegistrationEndpoint?: boolean;
  /** Advertise URL-based client identifiers. */
  clientIdMetadataDocumentSupported?: boolean;
  /** Issue ES256 JWT access tokens instead of opaque ones. */
  jwtAccessTokens?: boolean;
  /** Subject of the simulated logged-in user; per authorization request when a function. */
  subjectFor?: (params: { clientId: string; state?: string }) => string;
};

export type IssuedToken = {
  token: string;
  clientId: string;
  subject: string;
  scope: string;
  expiresAt: number;
};

type RegisteredClient = {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types: string[];
  scope?: string;
};

type PendingCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  subject: string;
  resource?: string;
};

export type FixtureAuthorizationServer = {
  url: string;
  close(): Promise<void>;
  toggles: AuthorizationServerToggles;
  registrations: RegisteredClient[];
  issuedTokens: IssuedToken[];
  /** Number of times the token endpoint was called. */
  tokenRequests: number;
  /** Expire every issued access token immediately. */
  expireAccessTokens(): void;
  /** Register a client up front (pre-registered client tests). */
  preregister(client: Omit<RegisteredClient, "grant_types"> & { grant_types?: string[] }): RegisteredClient;
};

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signingKey = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
const verifyingKey = createPublicKey(publicKey.export({ type: "spki", format: "pem" }));

/**
 * Start a small OAuth 2.1 authorization server for tests: RFC 8414 metadata, RFC 7591
 * dynamic client registration, S256 PKCE with auto-consent, and a token endpoint
 * supporting authorization_code, refresh_token, and client_credentials.
 */
export async function startAuthorizationServer(
  toggles: AuthorizationServerToggles = {},
): Promise<FixtureAuthorizationServer> {
  const clients = new Map<string, RegisteredClient>();
  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, { clientId: string; subject: string; scope: string }>();
  const issuedTokens: IssuedToken[] = [];
  const state = { tokenRequests: 0 };
  let baseUrl = "";

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: "server_error", error_description: String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", baseUrl);

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        ...(toggles.withoutRegistrationEndpoint ? {} : { registration_endpoint: `${baseUrl}/register` }),
        revocation_endpoint: `${baseUrl}/revoke`,
        introspection_endpoint: `${baseUrl}/introspect`,
        jwks_uri: `${baseUrl}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
        scopes_supported: ["mcp:tools", "profile"],
        ...(toggles.clientIdMetadataDocumentSupported ? { client_id_metadata_document_supported: true } : {}),
      });
      return;
    }

    if (url.pathname === "/jwks") {
      sendJson(res, 200, { keys: [jwk()] });
      return;
    }

    if (url.pathname === "/register" && req.method === "POST") {
      if (toggles.rejectRegistration) {
        sendJson(res, 400, { error: "invalid_client_metadata" });
        return;
      }

      const body = (await readJson(req)) as Record<string, unknown>;
      const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
      const grantTypes = Array.isArray(body.grant_types) ? (body.grant_types as string[]) : ["authorization_code"];
      if (grantTypes.includes("authorization_code") && redirectUris.length === 0) {
        sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
        return;
      }

      const client: RegisteredClient = {
        client_id: `dcr-${randomUUID()}`,
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      };
      clients.set(client.client_id, client);
      sendJson(res, 201, { ...client, client_id_issued_at: Math.floor(Date.now() / 1000) });
      return;
    }

    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      const method = url.searchParams.get("code_challenge_method");
      const requestState = url.searchParams.get("state") ?? undefined;
      const client = clients.get(clientId);

      if (!client) {
        sendJson(res, 400, { error: "invalid_client" });
        return;
      }

      if (!client.redirect_uris.includes(redirectUri)) {
        sendJson(res, 400, { error: "invalid_request", error_description: "Unregistered redirect_uri" });
        return;
      }

      if (!codeChallenge || method !== "S256") {
        redirect(res, redirectUri, { error: "invalid_request", ...(requestState ? { state: requestState } : {}) });
        return;
      }

      const code = randomUUID();
      codes.set(code, {
        clientId,
        redirectUri,
        codeChallenge,
        scope: url.searchParams.get("scope") ?? "mcp:tools",
        subject: toggles.subjectFor?.({ clientId, state: requestState }) ?? "demo-user",
        ...(url.searchParams.get("resource") ? { resource: url.searchParams.get("resource") as string } : {}),
      });

      redirect(res, redirectUri, { code, ...(requestState ? { state: requestState } : {}) });
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      state.tokenRequests += 1;
      const params = new URLSearchParams(await readBody(req));
      const credentials = clientCredentials(req, params);
      const client = clients.get(credentials.clientId ?? "");

      if (toggles.rejectClient || !client) {
        sendJson(res, 401, { error: "invalid_client" });
        return;
      }

      if (client.client_secret && client.client_secret !== credentials.clientSecret) {
        sendJson(res, 401, { error: "invalid_client", error_description: "client authentication failed" });
        return;
      }

      const grantType = params.get("grant_type");

      if (grantType === "authorization_code") {
        const code = params.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        if (!pending || pending.clientId !== client.client_id) {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }

        const verifier = params.get("code_verifier") ?? "";
        if (pkceChallenge(verifier) !== pending.codeChallenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }

        sendJson(res, 200, issue(client.client_id, pending.subject, pending.scope));
        return;
      }

      if (grantType === "refresh_token") {
        const refresh = params.get("refresh_token") ?? "";
        const stored = refreshTokens.get(refresh);
        if (toggles.rejectRefresh || !stored || stored.clientId !== client.client_id) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "refresh token rejected" });
          return;
        }

        refreshTokens.delete(refresh);
        sendJson(res, 200, issue(client.client_id, stored.subject, stored.scope));
        return;
      }

      if (grantType === "client_credentials") {
        sendJson(res, 200, issue(client.client_id, `service:${client.client_id}`, params.get("scope") ?? client.scope ?? "mcp:tools"));
        return;
      }

      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    if (url.pathname === "/introspect" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      const token = params.get("token") ?? "";
      const found = issuedTokens.find((issued) => issued.token === token);
      if (!found || found.expiresAt <= Date.now()) {
        sendJson(res, 200, { active: false });
        return;
      }

      sendJson(res, 200, {
        active: true,
        client_id: found.clientId,
        sub: found.subject,
        scope: found.scope,
        exp: Math.floor(found.expiresAt / 1000),
      });
      return;
    }

    if (url.pathname === "/revoke" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      const token = params.get("token") ?? "";
      const index = issuedTokens.findIndex((issued) => issued.token === token);
      if (index >= 0) {
        issuedTokens.splice(index, 1);
      }

      refreshTokens.delete(token);
      sendJson(res, 200, {});
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  function issue(clientId: string, subject: string, scope: string): Record<string, unknown> {
    const ttl = toggles.accessTokenTtlSeconds ?? 3600;
    const expiresAt = Date.now() + ttl * 1000;
    const token = toggles.jwtAccessTokens ? jwtAccessToken(baseUrl, clientId, subject, scope, ttl) : `at-${randomUUID()}`;
    issuedTokens.push({ token, clientId, subject, scope, expiresAt });

    const refreshToken = toggles.withoutRefreshToken ? undefined : `rt-${randomUUID()}`;
    if (refreshToken) {
      refreshTokens.set(refreshToken, { clientId, subject, scope });
    }

    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: ttl,
      scope,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,
    toggles,
    registrations: [] as RegisteredClient[],
    issuedTokens,
    get tokenRequests() {
      return state.tokenRequests;
    },
    expireAccessTokens(): void {
      for (const issued of issuedTokens) {
        issued.expiresAt = Date.now() - 1000;
      }
    },
    preregister(client): RegisteredClient {
      const registered: RegisteredClient = { grant_types: ["authorization_code", "refresh_token"], ...client };
      clients.set(registered.client_id, registered);
      return registered;
    },
    async close(): Promise<void> {
      await closeServer(server);
    },
  };
}

/**
 * Verify a token issued by this fixture; used by the protected MCP server.
 */
export function tokenSubject(authorizationServer: FixtureAuthorizationServer, token: string): string | undefined {
  const found = authorizationServer.issuedTokens.find((issued) => issued.token === token);
  if (!found || found.expiresAt <= Date.now()) {
    return undefined;
  }

  return found.subject;
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => {
      resolve();
    });
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function redirect(res: ServerResponse, redirectUri: string, params: Record<string, string>): void {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }

  res.writeHead(302, { location: target.toString() });
  res.end();
}

function clientCredentials(req: IncomingMessage, params: URLSearchParams): { clientId?: string; clientSecret?: string } {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  }

  return {
    clientId: params.get("client_id") ?? undefined,
    clientSecret: params.get("client_secret") ?? undefined,
  };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function jwtAccessToken(issuer: string, clientId: string, subject: string, scope: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "fixture" }));
  const payload = base64url(JSON.stringify({ iss: issuer, sub: subject, aud: clientId, scope, iat: now, exp: now + ttlSeconds }));
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), { key: signingKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function jwk(): Record<string, unknown> {
  return { ...verifyingKey.export({ format: "jwk" }), alg: "ES256", use: "sig", kid: "fixture" };
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
