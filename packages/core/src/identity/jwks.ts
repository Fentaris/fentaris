import { constants, createPublicKey, verify as cryptoVerify, type webcrypto } from "node:crypto";

/** Verified OAuth access-token claims. @pk */
export type OAuthClaims = { iss?: string; sub?: string; aud?: string | string[]; exp?: number; nbf?: number; scope?: string; scp?: string[]; [key: string]: unknown };

export class OAuthVerificationError extends Error {
  constructor(readonly reason: "invalid_token" | "insufficient_scope" = "invalid_token") {
    super("OAuth token verification failed");
  }
}

export function secureOAuthUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("Invalid OAuth URL");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("OAuth requires HTTPS outside loopback");
  return url;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  secureOAuthUrl(url);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new OAuthVerificationError();
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new OAuthVerificationError();
  return data as Record<string, unknown>;
}

type SigningJwk = webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string; key_ops?: string[] };

/** Lazily discover and cache an issuer's signing keys; unknown kids refresh once. */
export function createJwtVerifier(options: { issuer: string; jwks?: { url: string; cacheTtlMs?: number } }) {
  let keys: SigningJwk[] | undefined;
  let expiresAt = 0;
  let pending: Promise<void> | undefined;
  let jwksUrl = options.jwks?.url;
  async function refresh(): Promise<void> {
    pending ??= (async () => {
      if (!jwksUrl) {
        const issuer = secureOAuthUrl(options.issuer);
        const issuerPath = issuer.pathname.replace(/\/$/, "");
        const candidates = [
          `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
          `${options.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
        ];
        for (const url of candidates) {
          try {
            const metadata = await fetchJson(url);
            if (metadata.issuer !== options.issuer || typeof metadata.jwks_uri !== "string") continue;
            secureOAuthUrl(metadata.jwks_uri);
            jwksUrl = metadata.jwks_uri;
            break;
          } catch { /* Try the OIDC discovery route before failing closed. */ }
        }
      }
      if (!jwksUrl) throw new OAuthVerificationError();
      const document = await fetchJson(jwksUrl);
      if (!Array.isArray(document.keys)) throw new OAuthVerificationError();
      keys = document.keys.filter((key): key is SigningJwk => Boolean(key && typeof key === "object"));
      expiresAt = Date.now() + (options.jwks?.cacheTtlMs ?? 300_000);
    })();
    try { await pending; } finally { pending = undefined; }
  }
  return async (token: string): Promise<OAuthClaims> => {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)) || token.length > 65_536) throw new OAuthVerificationError();
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg?: string; kid?: string; crit?: unknown };
    if (!header || !["RS256", "PS256", "ES256", "EdDSA"].includes(header.alg ?? "") || typeof header.kid !== "string" || header.crit !== undefined) throw new OAuthVerificationError();
    let refreshed = false;
    if (!keys || Date.now() >= expiresAt) {
      try { await refresh(); refreshed = true; } catch { if (!keys) throw new OAuthVerificationError(); }
    }
    const eligible = (key: SigningJwk) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === "sig") && (!key.key_ops || key.key_ops.includes("verify"));
    let candidates = keys?.filter(eligible) ?? [];
    if (candidates.length === 0 && !refreshed) { await refresh(); candidates = keys?.filter(eligible) ?? []; }
    if (candidates.length !== 1) throw new OAuthVerificationError();
    const jwk = candidates[0]!;
    if (jwk.d || jwk.k || ((header.alg === "RS256" || header.alg === "PS256") && jwk.kty !== "RSA") || (header.alg === "ES256" && (jwk.kty !== "EC" || jwk.crv !== "P-256")) || (header.alg === "EdDSA" && (jwk.kty !== "OKP" || jwk.crv !== "Ed25519"))) throw new OAuthVerificationError();
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (jwk.kty === "RSA" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new OAuthVerificationError();
    const valid = cryptoVerify(header.alg === "EdDSA" ? null : "sha256", Buffer.from(`${parts[0]}.${parts[1]}`), {
      key,
      ...(header.alg === "PS256" ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : {}),
      ...(header.alg === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}),
    }, Buffer.from(parts[2]!, "base64url"));
    if (!valid) throw new OAuthVerificationError();
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as OAuthClaims;
  };
}

export function validateOAuthClaims(claims: OAuthClaims, options: { issuer: string; resource: string; scopes?: readonly string[] }): string[] {
  const now = Date.now() / 1000;
  if (!claims || typeof claims !== "object" || claims.iss !== options.issuer || !(typeof claims.aud === "string" ? claims.aud === options.resource : Array.isArray(claims.aud) && claims.aud.includes(options.resource)) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + 60 <= now || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf - 60 > now))) throw new OAuthVerificationError();
  const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : Array.isArray(claims.scp) && claims.scp.every((scope) => typeof scope === "string") ? claims.scp : [];
  if (options.scopes?.some((scope) => !scopes.includes(scope))) throw new OAuthVerificationError("insufficient_scope");
  return scopes;
}
