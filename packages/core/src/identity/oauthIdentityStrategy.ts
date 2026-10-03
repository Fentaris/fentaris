import type { IdentityStrategy } from "../types/policy.js";
import type { UserContext } from "../types/shared.js";
import { secureOAuthUrl, createJwtVerifier, OAuthVerificationError, validateOAuthClaims, type OAuthClaims } from "./jwks.js";

/** RFC 9728 protected resource metadata. @pk */
export type ProtectedResourceMetadata = { resource: string; authorization_servers: string[]; bearer_methods_supported: string[]; scopes_supported?: string[] };
/** Reason for a bearer challenge. @pk */
export type OAuthChallengeReason = "missing_token" | "invalid_token" | "insufficient_scope";
/** OAuth resource-server identity options. @pk */
export type OAuthIdentityStrategyOptions = {
  issuer: string;
  /** Exact audience; defaults to oauth.publicUrl + MCP path or a loopback listener. @pk */
  resource?: string;
  scopes?: string[];
  jwks?: { url: string; cacheTtlMs?: number };
  /** Obtain verified claims (for example from authenticated introspection). Claim checks still apply. @pk */
  verify?: (token: string) => OAuthClaims | Promise<OAuthClaims>;
  mapUser?: (claims: OAuthClaims) => UserContext | null | Promise<UserContext | null>;
};
/** OAuth identity strategy with metadata and challenge support. @pk */
export type OAuthIdentityStrategy = IdentityStrategy & { challenge(reason?: OAuthChallengeReason): string; metadata(): ProtectedResourceMetadata };

const configurations = new WeakMap<IdentityStrategy, OAuthIdentityStrategyOptions>();
const binders = new WeakMap<IdentityStrategy, (resource: string) => void>();
/** @internal */
export function oauthIdentityOptions(strategy: IdentityStrategy): OAuthIdentityStrategyOptions | undefined { return configurations.get(strategy); }
/** @internal */
export function bindOAuthResource(strategy: IdentityStrategy, resource: string): void { binders.get(strategy)?.(resource); }

/** Authenticate MCP clients using access tokens from an external OAuth issuer. @pk */
export function oauthIdentityStrategy(options: OAuthIdentityStrategyOptions): OAuthIdentityStrategy {
  const config = { ...options, ...(options.scopes ? { scopes: [...options.scopes] } : {}) };
  let resource = config.resource;
  const verify = config.verify ?? createJwtVerifier(config);
  const reasons = new WeakMap<object, OAuthChallengeReason>();
  const strategy: OAuthIdentityStrategy = {
    name: "oauth",
    async resolve(request) {
      const key = request.request && typeof request.request === "object" ? request.request : request;
      reasons.delete(key);
      const header = request.headers?.authorization;
      if (!header) { reasons.set(key, "missing_token"); return null; }
      try {
        const match = /^Bearer ([^\s,]+)$/i.exec(header);
        if (!match || !resource) throw new OAuthVerificationError();
        const claims = await verify(match[1]!);
        const scopes = validateOAuthClaims(claims, { ...config, resource });
        const mapped = config.mapUser ? await config.mapUser(claims) : typeof claims.sub === "string" && claims.sub ? { id: claims.sub } : null;
        if (!mapped?.id) throw new OAuthVerificationError();
        return { ...mapped, metadata: { ...(mapped.metadata && typeof mapped.metadata === "object" ? mapped.metadata : {}), scopes } };
      } catch (error) {
        reasons.set(key, error instanceof OAuthVerificationError ? error.reason : "invalid_token");
        return null;
      }
    },
    challenge(reason = "missing_token") {
      if (!resource) throw new Error("OAuth resource is not configured");
      const url = new URL(resource);
      const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
      const quote = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, "");
      return `Bearer resource_metadata="${quote(metadata)}"${reason === "missing_token" ? "" : `, error="${reason}"`}${reason === "insufficient_scope" ? `, scope="${quote(config.scopes?.join(" ") ?? "")}"` : ""}`;
    },
    challengeReason(request) { return reasons.get(request) ?? "missing_token"; },
    metadata() {
      if (!resource) throw new Error("OAuth resource is not configured");
      return { resource, authorization_servers: [config.issuer], bearer_methods_supported: ["header"], ...(config.scopes ? { scopes_supported: [...config.scopes] } : {}) };
    },
  };
  configurations.set(strategy, config);
  binders.set(strategy, (value) => { secureOAuthUrl(config.resource ?? value); resource = config.resource ?? value; });
  return strategy;
}
