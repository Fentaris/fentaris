import { describe, expect, it } from "vitest";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { OAuthAuthorizationRequiredError } from "../../src/auth/oauth/errors.js";
import { PendingAuthorizations } from "../../src/auth/oauth/pending.js";
import { FentarisOAuthClientProvider } from "../../src/auth/oauth/provider.js";
import { MemoryOAuthTokenStore } from "../../src/auth/oauth/store.js";
import { createHash } from "node:crypto";
import type { OAuthAuth } from "../../src/auth/oauth/dsl.js";

const redirectUrl = "http://127.0.0.1:4000/_fentaris/oauth/callback";

function build(auth: OAuthAuth, overrides: { redirectUrl?: string; resolveClientSecret?: () => Promise<string | undefined> } = {}) {
  const store = new MemoryOAuthTokenStore();
  const pending = new PendingAuthorizations();
  const provider = new FentarisOAuthClientProvider({
    server: "linear",
    session: "user:alice",
    auth,
    store,
    pending,
    redirectUrl: overrides.redirectUrl ?? redirectUrl,
    resolveClientSecret: overrides.resolveClientSecret,
  });

  return { provider, store, pending };
}

/** Drive redirectToAuthorization() for one state with the challenge of a known verifier. */
function expectRedirect(provider: FentarisOAuthClientProvider, state: string, verifier: string): void {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  expect(() =>
    provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}&code_challenge=${challenge}`)),
  ).toThrow(OAuthAuthorizationRequiredError);
}

describe("FentarisOAuthClientProvider client information", () => {
  it("uses dynamic registration when no client id is declared", async () => {
    const { provider, store } = build(oauth());

    expect(await provider.clientInformation()).toBeUndefined();
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });

    await provider.saveClientInformation({ client_id: "dcr-1", redirect_uris: [redirectUrl] });
    expect(await provider.clientInformation()).toMatchObject({ client_id: "dcr-1" });
    expect((await store.get("linear", "user:alice"))?.clientInformation?.client_id).toBe("dcr-1");
  });

  it("returns pre-registered client information with a resolved secret", async () => {
    const { provider } = build(oauth({ clientId: "app-1", clientSecret: "s3cret", scopes: ["repo"] }), {
      resolveClientSecret: async () => "resolved-secret",
    });

    expect(await provider.clientInformation()).toEqual({ client_id: "app-1", client_secret: "resolved-secret" });
    expect(provider.clientMetadata.scope).toBe("repo");
    expect(provider.clientMetadataUrl).toBeUndefined();
  });

  it("exposes the client metadata url for url-based client identifiers", async () => {
    const { provider } = build(oauth({ registration: "metadata-url", clientMetadataUrl: "https://apps.example.com/fentaris.json" }));

    expect(provider.clientMetadataUrl).toBe("https://apps.example.com/fentaris.json");
    expect(await provider.clientInformation()).toBeUndefined();
  });

  it("registers a second client for a new callback without discarding the first", async () => {
    const { provider, store } = build(oauth());
    const cliRedirect = "http://127.0.0.1:9999/callback";
    await provider.saveClientInformation({ client_id: "cli-client", redirect_uris: [cliRedirect] });

    // The proxy uses its hosted callback, so the CLI registration cannot serve it.
    expect(await provider.clientInformation()).toBeUndefined();
    // ...but it must stay stored, otherwise tokens it issued can never be refreshed.
    expect((await store.get("linear", "user:alice"))?.clientRegistrations?.[cliRedirect]?.client_id).toBe("cli-client");
  });

  it("refreshes with the client the tokens were issued to", async () => {
    const cliRedirect = "http://127.0.0.1:9999/callback";
    const store = new MemoryOAuthTokenStore();
    const pending = new PendingAuthorizations();
    const cli = new FentarisOAuthClientProvider({
      server: "linear",
      session: "user:alice",
      auth: oauth(),
      store,
      pending,
      redirectUrl: cliRedirect,
    });

    await cli.saveClientInformation({ client_id: "cli-client", redirect_uris: [cliRedirect] });
    await cli.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt" });

    const proxy = new FentarisOAuthClientProvider({
      server: "linear",
      session: "user:alice",
      auth: oauth(),
      store,
      pending,
      redirectUrl,
    });

    // A refresh must reuse cli-client; the authorization server would reject the
    // refresh token if it were presented by a freshly registered client.
    expect(await proxy.clientInformation()).toMatchObject({ client_id: "cli-client" });

    await proxy.invalidateCredentials("tokens");
    expect(await proxy.clientInformation()).toBeUndefined();
  });
});

describe("FentarisOAuthClientProvider authorization flow", () => {
  it("throws a typed error carrying the authorization url and state", () => {
    const { provider, pending } = build(oauth());
    const state = provider.state();
    const url = new URL(`https://auth.example.com/authorize?state=${state}&client_id=abc`);

    let thrown: unknown;
    try {
      provider.redirectToAuthorization(url);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OAuthAuthorizationRequiredError);
    const error = thrown as OAuthAuthorizationRequiredError;
    expect(error.server).toBe("linear");
    expect(error.session).toBe("user:alice");
    expect(error.state).toBe(state);
    expect(error.authorizationUrl).toBe(url.toString());
    expect(error.expiresAt).toBeGreaterThan(Date.now());
    expect(pending.get(state)?.authorizationUrl).toBe(url.toString());
  });

  it("keeps verifiers isolated across concurrent logins", () => {
    const { provider, pending } = build(oauth());

    // Two overlapping flows: the SDK interleaves state() and saveCodeVerifier(), so the
    // verifier is matched to its authorization URL by code_challenge, not by order.
    const first = provider.state();
    const second = provider.state();
    provider.saveCodeVerifier("verifier-1");
    provider.saveCodeVerifier("verifier-2");

    expectRedirect(provider, second, "verifier-2");
    expectRedirect(provider, first, "verifier-1");

    expect(pending.codeVerifier(first)).toBe("verifier-1");
    expect(pending.codeVerifier(second)).toBe("verifier-2");

    provider.bindExchange(first);
    expect(provider.codeVerifier()).toBe("verifier-1");
    provider.bindExchange(second);
    expect(provider.codeVerifier()).toBe("verifier-2");
  });

  it("fails clearly when no verifier is available", () => {
    const { provider } = build(oauth());
    expect(() => provider.codeVerifier()).toThrow(/No PKCE code verifier/);
  });
});

describe("FentarisOAuthClientProvider grants and invalidation", () => {
  it("prepares a client credentials token request without a redirect", async () => {
    const { provider } = build(oauth.clientCredentials({ clientId: "svc", clientSecret: "shh", scopes: ["billing.read"] }));

    expect(provider.redirectUrl).toBeUndefined();
    expect(provider.clientMetadata.grant_types).toEqual(["client_credentials"]);

    const params = await provider.prepareTokenRequest();
    expect(params?.get("grant_type")).toBe("client_credentials");
    expect(params?.get("scope")).toBe("billing.read");
  });

  it("returns undefined token request params for the authorization code grant", async () => {
    const { provider } = build(oauth());
    expect(await provider.prepareTokenRequest()).toBeUndefined();
  });

  it("stores tokens with an acquisition timestamp and strips it when read back", async () => {
    const { provider, store } = build(oauth());
    await provider.saveTokens({ access_token: "at", token_type: "Bearer", expires_in: 60 });

    expect((await store.get("linear", "user:alice"))?.tokens?.obtainedAt).toBeGreaterThan(0);
    expect(await provider.tokens()).toEqual({ access_token: "at", token_type: "Bearer", expires_in: 60 });
  });

  it("invalidates only the requested scope", async () => {
    const { provider, store } = build(oauth());
    await provider.saveClientInformation({ client_id: "dcr-1", redirect_uris: [redirectUrl] });
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example.com" });

    await provider.invalidateCredentials("tokens");
    expect((await store.get("linear", "user:alice"))?.tokens).toBeUndefined();
    expect((await store.get("linear", "user:alice"))?.clientInformation?.client_id).toBe("dcr-1");

    await provider.invalidateCredentials("discovery");
    expect((await store.get("linear", "user:alice"))?.discovery).toBeUndefined();

    await provider.invalidateCredentials("all");
    expect(await store.get("linear", "user:alice")).toBeUndefined();
  });

  it("clears pending state for the verifier scope", async () => {
    const { provider, pending } = build(oauth());
    const state = provider.state();
    provider.saveCodeVerifier("v");

    await provider.invalidateCredentials("verifier");
    expect(pending.get(state)).toBeUndefined();
  });
});

describe("oauth() declaration defaults", () => {
  it("infers registration mode and token scope", () => {
    expect(oauth()).toMatchObject({ registration: "dynamic", tokens: "per-user", grant: "authorization_code" });
    expect(oauth({ clientId: "abc" })).toMatchObject({ registration: "preregistered" });
    expect(oauth({ clientMetadataUrl: "https://apps.example.com/c.json" })).toMatchObject({ registration: "metadata-url" });
    expect(oauth({ tokens: "shared" })).toMatchObject({ tokens: "shared" });
    expect(oauth.clientCredentials({ clientId: "svc" })).toMatchObject({ grant: "client_credentials", tokens: "shared" });
  });

  it("rejects incomplete declarations", () => {
    expect(() => oauth({ registration: "metadata-url" })).toThrow(/clientMetadataUrl/);
    expect(() => oauth({ registration: "preregistered" })).toThrow(/clientId/);
    expect(() => oauth.clientCredentials({ clientId: "  " })).toThrow(/clientId/);
  });
});
