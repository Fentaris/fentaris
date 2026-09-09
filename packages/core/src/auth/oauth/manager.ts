import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { UserContext } from "../../types/shared.js";
import { oauthSessionKeyFor, type OAuthAuth } from "./dsl.js";
import { findOAuthAuthorizationRequiredError, OAuthAuthorizationRequiredError } from "./errors.js";
import { PendingAuthorizations, type PendingAuthorizationOutcome } from "./pending.js";
import { FentarisOAuthClientProvider } from "./provider.js";
import {
  MemoryOAuthTokenStore,
  oauthTokensExpireAt,
  type OAuthSessionKey,
  type OAuthStoreEntry,
  type OAuthTokenStore,
} from "./store.js";

const defaultConsentTimeoutMs = 90_000;
const tokenExpirySkewMs = 30_000;

/**
 * Registration of one OAuth-protected upstream server with the manager.
 * @pk
 */
export type OAuthServerRegistration = {
  auth: OAuthAuth;
  serverUrl: string;
  fetchFn?: FetchLike;
  resolveClientSecret?: () => Promise<string | undefined>;
};

/**
 * Authorization state of a server for one session.
 * @pk
 */
export type OAuthAuthorizationStatus = "authenticated" | "requires-login" | "not-configured";

/**
 * Result of starting an interactive login.
 * @pk
 */
export type OAuthLoginStart = {
  status: "authorization-required" | "authenticated";
  server: string;
  session: OAuthSessionKey;
  authorizationUrl?: string;
  state?: string;
  expiresAt?: number;
};

/**
 * Options for {@link OAuthManager}.
 * @pk
 */
export type OAuthManagerOptions = {
  store?: OAuthTokenStore;
  callbackUrl?: string;
  pendingTtlMs?: number;
  consentTimeoutMs?: number;
  clientName?: string;
  clientUri?: string;
};

/**
 * Coordinates OAuth providers, pending authorizations, and token persistence for upstream servers.
 * @pk
 */
export class OAuthManager {
  readonly store: OAuthTokenStore;
  readonly pending: PendingAuthorizations;
  readonly consentTimeoutMs: number;
  private readonly registrations = new Map<string, OAuthServerRegistration>();
  private readonly providers = new Map<string, FentarisOAuthClientProvider>();
  private readonly customProviders = new Map<string, OAuthClientProvider>();
  private readonly clientName?: string;
  private readonly clientUri?: string;
  private callbackUrl?: string;

  constructor(options: OAuthManagerOptions = {}) {
    this.store = options.store ?? new MemoryOAuthTokenStore();
    this.pending = new PendingAuthorizations({ ttlMs: options.pendingTtlMs });
    this.consentTimeoutMs = options.consentTimeoutMs ?? defaultConsentTimeoutMs;
    this.callbackUrl = options.callbackUrl;
    this.clientName = options.clientName;
    this.clientUri = options.clientUri;
  }

  /**
   * Register an OAuth-protected upstream server.
   * @pk
   */
  register(server: string, registration: OAuthServerRegistration): void {
    this.registrations.set(server, registration);
  }

  registrationFor(server: string): OAuthServerRegistration | undefined {
    return this.registrations.get(server);
  }

  servers(): string[] {
    return [...this.registrations.keys()];
  }

  /**
   * Set the redirect URL Fentaris hosts for authorization callbacks.
   * @pk
   */
  setCallbackUrl(callbackUrl: string): void {
    if (this.callbackUrl === callbackUrl) {
      return;
    }

    this.callbackUrl = callbackUrl;
    this.providers.clear();
  }

  getCallbackUrl(): string | undefined {
    return this.callbackUrl;
  }

  /**
   * Resolve the authorization session key for a caller.
   * @pk
   */
  sessionKeyFor(server: string, user: UserContext): OAuthSessionKey {
    const registration = this.registrations.get(server);
    return registration ? oauthSessionKeyFor(registration.auth, user) : "shared";
  }

  /**
   * Return the OAuth client provider bound to a server and caller.
   * @pk
   */
  providerFor(server: string, user: UserContext): OAuthClientProvider | undefined {
    const registration = this.registrations.get(server);
    if (!registration) {
      return undefined;
    }

    const session = oauthSessionKeyFor(registration.auth, user);
    const key = `${server}\u0000${session}`;

    if (registration.auth.provider) {
      const existing = this.customProviders.get(key);
      if (existing) {
        return existing;
      }

      const custom = registration.auth.provider({
        server,
        user,
        session,
        store: this.store,
        redirectUrl: this.callbackUrl,
      });
      this.customProviders.set(key, custom);
      return custom;
    }

    return this.fentarisProviderFor(server, session, registration);
  }

  /**
   * Authorization state for a server and session, derived from the store only.
   * @pk
   */
  async status(server: string, session: OAuthSessionKey): Promise<OAuthAuthorizationStatus> {
    const registration = this.registrations.get(server);
    if (!registration) {
      return "not-configured";
    }

    if (registration.auth.grant === "client_credentials") {
      return "authenticated";
    }

    const record = await this.store.get(server, session);
    const tokens = record?.tokens;
    if (!tokens?.access_token) {
      return "requires-login";
    }

    const expiresAt = oauthTokensExpireAt(tokens);
    if (expiresAt !== undefined && expiresAt - tokenExpirySkewMs <= Date.now() && !tokens.refresh_token) {
      return "requires-login";
    }

    return "authenticated";
  }

  /**
   * Start an authorization flow, returning the URL a human must visit.
   * @pk
   */
  async beginLogin(server: string, user: UserContext): Promise<OAuthLoginStart> {
    const registration = this.registrations.get(server);
    if (!registration) {
      throw new Error(`MCP server "${server}" is not declared with oauth()`);
    }

    const session = oauthSessionKeyFor(registration.auth, user);
    const provider = this.providerFor(server, user);
    if (!provider) {
      throw new Error(`MCP server "${server}" is not declared with oauth()`);
    }

    try {
      const result = await sdkAuth(provider, { serverUrl: registration.serverUrl, fetchFn: registration.fetchFn });
      return { status: result === "AUTHORIZED" ? "authenticated" : "authorization-required", server, session };
    } catch (error: unknown) {
      const authorizationRequired = findOAuthAuthorizationRequiredError(error);
      if (!authorizationRequired) {
        throw error;
      }

      return {
        status: "authorization-required",
        server,
        session,
        authorizationUrl: authorizationRequired.authorizationUrl,
        state: authorizationRequired.state,
        expiresAt: authorizationRequired.expiresAt,
      };
    }
  }

  /**
   * Complete an authorization callback by exchanging the code for tokens.
   * @pk
   */
  async completeCallback(params: {
    state: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ server: string; session: OAuthSessionKey }> {
    const entry = this.pending.get(params.state);
    if (!entry) {
      throw new Error("Unknown or expired authorization state");
    }

    if (params.error) {
      await this.pending.fail(params.state, params.error);
      throw new Error(`Authorization server reported "${params.error}"`);
    }

    if (!params.code) {
      await this.pending.fail(params.state, "missing authorization code");
      throw new Error("Authorization callback is missing the authorization code");
    }

    const registration = this.registrations.get(entry.server);
    if (!registration) {
      await this.pending.fail(params.state, "server is no longer configured");
      throw new Error(`MCP server "${entry.server}" is not declared with oauth()`);
    }

    const provider = this.fentarisProviderFor(entry.server, entry.session, registration);
    provider.bindExchange(params.state);

    try {
      await sdkAuth(provider, {
        serverUrl: registration.serverUrl,
        authorizationCode: params.code,
        fetchFn: registration.fetchFn,
      });
    } catch (error: unknown) {
      await this.pending.fail(params.state, "token exchange failed");
      throw error;
    }

    await this.pending.resolve(params.state);
    return { server: entry.server, session: entry.session };
  }

  /**
   * Wait for a pending authorization to complete.
   * @pk
   */
  async waitForCompletion(state: string, timeoutMs?: number): Promise<PendingAuthorizationOutcome | { status: "timeout" }> {
    return this.pending.wait(state, timeoutMs ?? this.consentTimeoutMs);
  }

  /**
   * Attach a completion notifier to a pending authorization.
   * @pk
   */
  onCompleted(state: string, notify: () => void | Promise<void>): void {
    this.pending.attachCompletionNotifier(state, notify);
  }

  /**
   * Remove stored authorization state for a server and session.
   * @pk
   */
  async logout(server: string, session: OAuthSessionKey): Promise<void> {
    this.pending.clear(server, session);
    this.providers.delete(`${server}\u0000${session}`);
    this.customProviders.delete(`${server}\u0000${session}`);
    await this.store.delete(server, session);
  }

  /**
   * List stored OAuth records without exposing token values.
   * @pk
   */
  async list(): Promise<OAuthStoreEntry[]> {
    return this.store.list();
  }

  private fentarisProviderFor(
    server: string,
    session: OAuthSessionKey,
    registration: OAuthServerRegistration,
  ): FentarisOAuthClientProvider {
    const key = `${server}\u0000${session}`;
    const existing = this.providers.get(key);
    if (existing) {
      return existing;
    }

    const provider = new FentarisOAuthClientProvider({
      server,
      session,
      auth: registration.auth,
      store: this.store,
      pending: this.pending,
      redirectUrl: this.callbackUrl,
      clientName: this.clientName,
      clientUri: this.clientUri,
      resolveClientSecret: registration.resolveClientSecret,
    });
    this.providers.set(key, provider);
    return provider;
  }
}

export { OAuthAuthorizationRequiredError };
