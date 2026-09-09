import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthAuth } from "./dsl.js";
import { OAuthAuthorizationRequiredError } from "./errors.js";
import type { PendingAuthorizations } from "./pending.js";
import type { OAuthSessionKey, OAuthStoreRecord, OAuthTokenStore, StoredOAuthTokens } from "./store.js";

/**
 * Options for {@link FentarisOAuthClientProvider}.
 * @pk
 */
export type FentarisOAuthClientProviderOptions = {
  server: string;
  session: OAuthSessionKey;
  auth: OAuthAuth;
  store: OAuthTokenStore;
  pending: PendingAuthorizations;
  /** Redirect URL for interactive grants; omitted for client credentials. */
  redirectUrl?: string;
  clientName?: string;
  clientUri?: string;
  resolveClientSecret?: () => Promise<string | undefined>;
};

/**
 * Fentaris implementation of the MCP SDK OAuth client provider, backed by the token store.
 * @pk
 */
export class FentarisOAuthClientProvider implements OAuthClientProvider {
  readonly server: string;
  readonly session: OAuthSessionKey;
  private readonly auth: OAuthAuth;
  private readonly store: OAuthTokenStore;
  private readonly pending: PendingAuthorizations;
  private readonly redirect?: string;
  private readonly clientName: string;
  private readonly clientUri?: string;
  private readonly resolveClientSecret?: () => Promise<string | undefined>;
  private issuedStates: string[] = [];
  private exchangeState?: string;

  constructor(options: FentarisOAuthClientProviderOptions) {
    this.server = options.server;
    this.session = options.session;
    this.auth = options.auth;
    this.store = options.store;
    this.pending = options.pending;
    this.redirect = options.auth.grant === "client_credentials" ? undefined : (options.auth.redirectUrl ?? options.redirectUrl);
    this.clientName = options.clientName ?? "Fentaris";
    this.clientUri = options.clientUri;
    this.resolveClientSecret = options.resolveClientSecret;
  }

  get redirectUrl(): string | undefined {
    return this.redirect;
  }

  get clientMetadataUrl(): string | undefined {
    return this.auth.registration === "metadata-url" ? this.auth.clientMetadataUrl : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.auth.scopes?.join(" ");
    if (this.auth.grant === "client_credentials") {
      return {
        client_name: this.clientName,
        client_uri: this.clientUri,
        redirect_uris: [],
        grant_types: ["client_credentials"],
        response_types: [],
        token_endpoint_auth_method: "client_secret_basic",
        ...(scope ? { scope } : {}),
      };
    }

    return {
      client_name: this.clientName,
      client_uri: this.clientUri,
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.auth.clientSecret ? "client_secret_post" : "none",
      ...(scope ? { scope } : {}),
    };
  }

  /**
   * Bind this provider to a specific pending authorization for the code exchange.
   * @pk
   */
  bindExchange(state: string): void {
    this.exchangeState = state;
  }

  state(): string {
    const state = this.pending.register(this.server, this.session);
    this.issuedStates.push(state);
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.auth.registration === "preregistered" && this.auth.clientId) {
      const clientSecret =
        (await this.resolveClientSecret?.()) ?? (typeof this.auth.clientSecret === "string" ? this.auth.clientSecret : undefined);
      return { client_id: this.auth.clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) };
    }

    const stored = (await this.record())?.clientInformation;
    if (!stored) {
      return undefined;
    }

    if (this.auth.registration === "dynamic" && this.redirect && !(stored.redirect_uris ?? []).includes(this.redirect)) {
      // The stored dynamic registration cannot serve the current callback; force a re-registration.
      await this.invalidateCredentials("client");
      return undefined;
    }

    return stored;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update((record) => ({ ...record, clientInformation: clientInformation as OAuthClientInformationFull }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = (await this.record())?.tokens;
    if (!stored) {
      return undefined;
    }

    const tokens: Record<string, unknown> = { ...stored };
    delete tokens.obtainedAt;
    return tokens as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored: StoredOAuthTokens = { ...tokens, obtainedAt: Date.now() };
    await this.update((record) => ({ ...record, tokens: stored }));
  }

  redirectToAuthorization(authorizationUrl: URL): never {
    const state = authorizationUrl.searchParams.get("state") ?? this.issuedStates.at(-1);
    if (!state) {
      throw new Error(`OAuth authorization URL for server "${this.server}" is missing a state parameter`);
    }

    this.pending.attachAuthorizationUrl(state, authorizationUrl.toString());
    const entry = this.pending.get(state);
    throw new OAuthAuthorizationRequiredError({
      server: this.server,
      session: this.session,
      authorizationUrl: authorizationUrl.toString(),
      state,
      expiresAt: entry?.expiresAt ?? Date.now(),
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    const target = this.issuedStates.find((state) => !this.pending.codeVerifier(state)) ?? this.issuedStates.at(-1);
    if (!target) {
      throw new Error(`No pending OAuth authorization to attach a code verifier for server "${this.server}"`);
    }

    this.pending.attachVerifier(target, codeVerifier);
    this.issuedStates = this.issuedStates.filter((state) => Boolean(this.pending.get(state)));
  }

  codeVerifier(): string {
    const state = this.exchangeState ?? this.issuedStates.at(-1);
    const verifier = state ? this.pending.codeVerifier(state) : undefined;
    if (!verifier) {
      throw new Error(`No PKCE code verifier is available for server "${this.server}"`);
    }

    return verifier;
  }

  async prepareTokenRequest(scope?: string): Promise<URLSearchParams | undefined> {
    if (this.auth.grant !== "client_credentials") {
      return undefined;
    }

    const params = new URLSearchParams({ grant_type: "client_credentials" });
    const requestedScope = scope ?? this.auth.scopes?.join(" ");
    if (requestedScope) {
      params.set("scope", requestedScope);
    }

    return params;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") {
      this.pending.clear(this.server, this.session);
      this.issuedStates = [];
      return;
    }

    if (scope === "all") {
      this.pending.clear(this.server, this.session);
      this.issuedStates = [];
      await this.store.delete(this.server, this.session);
      return;
    }

    await this.update((record) => {
      const next = { ...record };
      if (scope === "client") {
        delete next.clientInformation;
      } else if (scope === "tokens") {
        delete next.tokens;
      } else {
        delete next.discovery;
      }

      return next;
    });
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.update((record) => ({ ...record, discovery: state }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.record())?.discovery;
  }

  private async record(): Promise<OAuthStoreRecord | undefined> {
    return this.store.get(this.server, this.session);
  }

  private async update(apply: (record: OAuthStoreRecord) => OAuthStoreRecord): Promise<void> {
    const current = (await this.record()) ?? { updatedAt: 0 };
    await this.store.set(this.server, this.session, { ...apply(current), updatedAt: Date.now() });
  }
}
