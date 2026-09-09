import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { isCredentialReference, type CredentialReference } from "../../credentials/index.js";
import type { UserContext } from "../../types/shared.js";
import type { OAuthSessionKey, OAuthTokenStore } from "./store.js";

/**
 * How the OAuth client identity is established with the authorization server.
 * @pk
 */
export type OAuthRegistrationMode = "dynamic" | "preregistered" | "metadata-url";

/**
 * Whether upstream authorizations are isolated per Fentaris user or shared by all callers.
 * @pk
 */
export type OAuthTokenScope = "per-user" | "shared";

/**
 * OAuth grant used to obtain upstream access tokens.
 * @pk
 */
export type OAuthGrant = "authorization_code" | "client_credentials";

/**
 * Context handed to a custom OAuth client provider factory.
 * @pk
 */
export type OAuthProviderFactoryContext = {
  server: string;
  user: UserContext;
  session: OAuthSessionKey;
  store: OAuthTokenStore;
  redirectUrl?: string;
};

/**
 * Factory producing a low-level MCP SDK OAuth client provider.
 * @pk
 */
export type OAuthProviderFactory = (context: OAuthProviderFactoryContext) => OAuthClientProvider;

/**
 * Upstream OAuth 2.1 auth declaration for an MCP server.
 * @pk
 */
export type OAuthAuth = {
  type: "oauth";
  grant: OAuthGrant;
  registration: OAuthRegistrationMode;
  tokens: OAuthTokenScope;
  clientId?: string;
  clientSecret?: string | CredentialReference;
  scopes?: string[];
  clientMetadataUrl?: string;
  redirectUrl?: string;
  provider?: OAuthProviderFactory;
};

/**
 * Options accepted by {@link oauth}.
 * @pk
 */
export type OAuthAuthOptions = {
  clientId?: string;
  clientSecret?: string | CredentialReference;
  scopes?: string[];
  registration?: OAuthRegistrationMode;
  clientMetadataUrl?: string;
  redirectUrl?: string;
  tokens?: OAuthTokenScope;
  provider?: OAuthProviderFactory;
};

/**
 * Options accepted by {@link oauth.clientCredentials}.
 * @pk
 */
export type OAuthClientCredentialsOptions = {
  clientId: string;
  clientSecret?: string | CredentialReference;
  scopes?: string[];
};

type OAuthFactory = {
  (options?: OAuthAuthOptions): OAuthAuth;
  clientCredentials(options: OAuthClientCredentialsOptions): OAuthAuth;
};

/**
 * Declare that an upstream MCP server is protected by OAuth 2.1 and let Fentaris run the flow.
 * @pk
 */
export const oauth: OAuthFactory = Object.assign(
  (options: OAuthAuthOptions = {}): OAuthAuth => {
    if (options.registration === "metadata-url" && !options.clientMetadataUrl) {
      throw new Error('oauth({ registration: "metadata-url" }) requires clientMetadataUrl');
    }

    if (options.registration === "preregistered" && !options.clientId) {
      throw new Error('oauth({ registration: "preregistered" }) requires clientId');
    }

    return {
      type: "oauth",
      grant: "authorization_code",
      registration: inferRegistration(options),
      tokens: options.tokens ?? "per-user",
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      scopes: options.scopes,
      clientMetadataUrl: options.clientMetadataUrl,
      redirectUrl: options.redirectUrl,
      provider: options.provider,
    };
  },
  {
    clientCredentials(options: OAuthClientCredentialsOptions): OAuthAuth {
      if (!options.clientId?.trim()) {
        throw new Error("oauth.clientCredentials() requires clientId");
      }

      return {
        type: "oauth",
        grant: "client_credentials",
        registration: "preregistered",
        tokens: "shared",
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        scopes: options.scopes,
      };
    },
  },
);

/**
 * Type guard for the OAuth upstream auth declaration.
 * @pk
 */
export function isOAuthAuth(value: unknown): value is OAuthAuth {
  return Boolean(value) && typeof value === "object" && (value as OAuthAuth).type === "oauth";
}

/**
 * Resolve the authorization session key for a caller and declaration.
 * @pk
 */
export function oauthSessionKeyFor(auth: OAuthAuth, user: UserContext): OAuthSessionKey {
  if (auth.tokens === "shared" || !user.id) {
    return "shared";
  }

  return `user:${user.id}`;
}

/**
 * Whether the declared client secret is a credential reference needing resolution.
 * @pk
 */
export function oauthClientSecretReference(auth: OAuthAuth): CredentialReference | undefined {
  return isCredentialReference(auth.clientSecret) ? auth.clientSecret : undefined;
}

function inferRegistration(options: OAuthAuthOptions): OAuthRegistrationMode {
  if (options.registration) {
    return options.registration;
  }

  if (options.clientMetadataUrl) {
    return "metadata-url";
  }

  return options.clientId ? "preregistered" : "dynamic";
}
