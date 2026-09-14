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
import { createHash } from "node:crypto";
import { updateOAuthRecord, type OAuthSessionKey, type OAuthStoreRecord, type OAuthTokenStore, type StoredOAuthTokens } from "./store.js";

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
  /** PKCE verifiers saved by the SDK but not yet matched to an authorization URL. */
  private unboundVerifiers: string[] = [];
  /** Client id used by the most recent clientInformation() answer, for token attribution. */
  private lastClientId?: string;

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

    const record = await this.record();
    const registrations = allRegistrations(record);
    if (registrations.length === 0) {
      this.lastClientId = undefined;
      return undefined;
    }

    // A refresh must use the exact client the tokens were issued to, even when another
    // process (the CLI with its loopback redirect) registered a different one.
    const tokens = record?.tokens;
    if (tokens?.refresh_token && tokens.clientId) {
      const issuer = registrations.find((client) => client.client_id === tokens.clientId);
      if (issuer) {
        this.lastClientId = issuer.client_id;
        return issuer;
      }
    }

    const usable = this.redirect
      ? registrations.find((client) => (client.redirect_uris ?? []).includes(this.redirect as string))
      : registrations[0];

    if (!usable) {
      // No registration covers the current callback; register a new one and keep the
      // existing ones so their tokens stay refreshable.
      this.lastClientId = undefined;
      return undefined;
    }

    this.lastClientId = usable.client_id;
    return usable;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const full = clientInformation as OAuthClientInformationFull;
    this.lastClientId = full.client_id;
    await this.update((record) => ({
      ...record,
      clientInformation: full,
      clientRegistrations: {
        ...(record.clientRegistrations ?? {}),
        ...Object.fromEntries((full.redirect_uris ?? [this.redirect ?? "none"]).map((uri) => [uri, full])),
      },
    }));
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
    await this.update((record) => ({
      ...record,
      tokens: {
        ...tokens,
        obtainedAt: Date.now(),
        ...(this.lastClientId ?? record.tokens?.clientId ? { clientId: this.lastClientId ?? record.tokens?.clientId } : {}),
      } satisfies StoredOAuthTokens,
    }));
  }

  redirectToAuthorization(authorizationUrl: URL): never {
    const state = authorizationUrl.searchParams.get("state") ?? this.issuedStates.at(-1);
    if (!state) {
      throw new Error(`OAuth authorization URL for server "${this.server}" is missing a state parameter`);
    }

    this.bindVerifierFor(state, authorizationUrl.searchParams.get("code_challenge"));
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
    if (this.issuedStates.length === 0) {
      throw new Error(`No pending OAuth authorization to attach a code verifier for server "${this.server}"`);
    }

    // The SDK gives no correlation between state() and saveCodeVerifier(), so hold the
    // verifier until redirectToAuthorization() can match it to a code_challenge. Two
    // concurrent logins on the same session would otherwise swap verifiers.
    this.unboundVerifiers.push(codeVerifier);
    this.issuedStates = this.issuedStates.filter((state) => Boolean(this.pending.get(state)));
  }

  private bindVerifierFor(state: string, codeChallenge: string | null): void {
    if (this.unboundVerifiers.length === 0) {
      return;
    }

    const index = codeChallenge
      ? this.unboundVerifiers.findIndex((verifier) => pkceChallenge(verifier) === codeChallenge)
      : this.unboundVerifiers.length - 1;
    const [verifier] = this.unboundVerifiers.splice(index >= 0 ? index : this.unboundVerifiers.length - 1, 1);
    if (verifier) {
      this.pending.attachVerifier(state, verifier);
    }
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
    if (this.auth.grant === "client_credentials") {
      const params = new URLSearchParams({ grant_type: "client_credentials" });
      const requestedScope = scope ?? this.auth.scopes?.join(" ");
      if (requestedScope) {
        params.set("scope", requestedScope);
      }

      return params;
    }

    // The MCP SDK classifies providers without a redirect URL as non-interactive
    // before it checks their stored tokens. Refresh the existing authorization-code
    // grant through that hook so headless exposures can reuse CLI-issued tokens.
    if (this.redirect) {
      return undefined;
    }

    const refreshToken = (await this.record())?.tokens?.refresh_token;
    return refreshToken ? new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }) : undefined;
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
        delete next.clientRegistrations;
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
    // Read-modify-write through the store so concurrent writers cannot drop each
    // other's fields.
    await updateOAuthRecord(this.store, this.server, this.session, apply);
  }
}

function allRegistrations(record: OAuthStoreRecord | undefined): OAuthClientInformationFull[] {
  const byRedirect = Object.values(record?.clientRegistrations ?? {});
  const legacy = record?.clientInformation;
  if (legacy && !byRedirect.some((client) => client.client_id === legacy.client_id)) {
    return [legacy, ...byRedirect];
  }

  return byRedirect;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
