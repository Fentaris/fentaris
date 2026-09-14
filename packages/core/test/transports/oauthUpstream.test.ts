import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../../src/auth/oauth/manager.js";
import { OAuthAuthorizationRequiredError } from "../../src/auth/oauth/errors.js";
import { MemoryOAuthTokenStore } from "../../src/auth/oauth/store.js";
import { oauth, type OAuthAuth } from "../../src/auth/oauth/dsl.js";
import { mcp, type McpServer } from "../../src/server/index.js";
import { StreamableHttpMcpTransport } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { startAuthorizationServer, type FixtureAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";
import { approveAuthorization, startProtectedMcpServer, type FixtureProtectedMcpServer } from "../fixtures/oauth/protectedMcpServer.js";

const callbackUrl = "http://127.0.0.1:4599/_fentaris/oauth/callback";
const network = { allowPrivateNetworkUrls: true };

type Harness = {
  authServer: FixtureAuthorizationServer;
  upstream: FixtureProtectedMcpServer;
  server: McpServer;
  manager: OAuthManager;
  transport: StreamableHttpMcpTransport;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function harness(options: { auth?: OAuthAuth; toggles?: Parameters<typeof startAuthorizationServer>[0] } = {}): Promise<Harness> {
  const authServer = await startAuthorizationServer(options.toggles ?? {});
  cleanups.push(() => authServer.close());
  const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
  cleanups.push(() => upstream.close());

  const auth = options.auth ?? oauth();
  const transport = new StreamableHttpMcpTransport({ url: upstream.url, network });
  const server = mcp("protected", { transport, auth });
  cleanups.push(() => server.close());

  const manager = new OAuthManager({ store: new MemoryOAuthTokenStore(), callbackUrl });
  manager.register("protected", { auth, serverUrl: upstream.url, fetchFn: transport.createGuardedFetch() });
  server.attachOAuth((user) => manager.providerFor("protected", user));

  return { authServer, upstream, server, manager, transport };
}

async function completeLogin(manager: OAuthManager, error: OAuthAuthorizationRequiredError): Promise<void> {
  const callback = await approveAuthorization(error.authorizationUrl);
  expect(callback.state).toBe(error.state);
  await manager.completeCallback({ state: callback.state as string, code: callback.code });
}

async function callExpectingAuthorization(server: McpServer, user: { id?: string }): Promise<OAuthAuthorizationRequiredError> {
  try {
    await server.callTool({ name: "echo", arguments: { message: "hi" } }, user);
  } catch (error: unknown) {
    if (error instanceof OAuthAuthorizationRequiredError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected an authorization-required error");
}

describe("OAuth-protected upstream over Streamable HTTP", () => {
  it("requires authorization, then succeeds after the callback completes", async () => {
    const { server, manager, upstream } = await harness();

    const error = await callExpectingAuthorization(server, { id: "alice" });
    expect(error.server).toBe("protected");
    expect(error.session).toBe("user:alice");
    expect(error.authorizationUrl).toContain("code_challenge_method=S256");
    expect(await manager.status("protected", "user:alice")).toBe("requires-login");

    await completeLogin(manager, error);
    expect(await manager.status("protected", "user:alice")).toBe("authenticated");

    const result = await server.callTool({ name: "echo", arguments: { message: "hi" } }, { id: "alice" });
    expect(result.content).toEqual([{ type: "text", text: "demo-user:hi" }]);
    expect(upstream.callers).toEqual(["demo-user"]);
  });

  it("refreshes an expired access token without user interaction", async () => {
    const { server, manager, authServer } = await harness({ toggles: { accessTokenTtlSeconds: 1 } });

    await completeLogin(manager, await callExpectingAuthorization(server, { id: "alice" }));
    await server.callTool({ name: "echo", arguments: { message: "first" } }, { id: "alice" });

    const tokensBefore = await manager.store.get("protected", "user:alice");
    authServer.expireAccessTokens();
    await server.evictTransport({ id: "alice" });

    const result = await server.callTool({ name: "echo", arguments: { message: "second" } }, { id: "alice" });
    expect(result.content).toEqual([{ type: "text", text: "demo-user:second" }]);

    const tokensAfter = await manager.store.get("protected", "user:alice");
    expect(tokensAfter?.tokens?.access_token).not.toBe(tokensBefore?.tokens?.access_token);
    expect(await manager.status("protected", "user:alice")).toBe("authenticated");
  });

  it("refreshes CLI-issued tokens without a redirect URL in a headless exposure", async () => {
    const auth = oauth({ tokens: "shared" });
    const { server, manager, authServer, upstream, transport } = await harness({
      auth,
      toggles: { accessTokenTtlSeconds: 1 },
    });

    await completeLogin(manager, await callExpectingAuthorization(server, { id: "cli" }));
    const tokensBefore = await manager.store.get("protected", "shared");
    authServer.expireAccessTokens();

    const headlessManager = new OAuthManager({ store: manager.store });
    headlessManager.register("protected", {
      auth,
      serverUrl: upstream.url,
      fetchFn: transport.createGuardedFetch(),
    });
    server.attachOAuth((user) => headlessManager.providerFor("protected", user));
    await server.evictTransport({ id: "agent" });

    const result = await server.callTool({ name: "echo", arguments: { message: "headless" } }, { id: "agent" });
    expect(result.content).toEqual([{ type: "text", text: "demo-user:headless" }]);

    const tokensAfter = await headlessManager.store.get("protected", "shared");
    expect(tokensAfter?.tokens?.access_token).not.toBe(tokensBefore?.tokens?.access_token);
    expect(headlessManager.getCallbackUrl()).toBeUndefined();
  });

  it("returns to requires-login when the refresh is rejected", async () => {
    const { server, manager, authServer } = await harness({ toggles: { accessTokenTtlSeconds: 1 } });

    await completeLogin(manager, await callExpectingAuthorization(server, { id: "alice" }));
    await server.callTool({ name: "echo", arguments: { message: "first" } }, { id: "alice" });

    authServer.expireAccessTokens();
    authServer.toggles.rejectRefresh = true;
    await server.evictTransport({ id: "alice" });

    const error = await callExpectingAuthorization(server, { id: "alice" });
    expect(error.state).toBeTruthy();
  });

  it("keeps two users on two upstream identities", async () => {
    const subjects = new Map<string, string>();
    const { server, manager, upstream } = await harness({
      toggles: {
        subjectFor: ({ state }) => subjects.get(state ?? "") ?? "demo-user",
      },
    });

    const aliceError = await callExpectingAuthorization(server, { id: "alice" });
    subjects.set(aliceError.state, "alice@example.com");
    await completeLogin(manager, aliceError);

    const bobError = await callExpectingAuthorization(server, { id: "bob" });
    subjects.set(bobError.state, "bob@example.com");
    await completeLogin(manager, bobError);

    await server.callTool({ name: "echo", arguments: { message: "x" } }, { id: "alice" });
    await server.callTool({ name: "echo", arguments: { message: "x" } }, { id: "bob" });

    expect(upstream.callers).toEqual(["alice@example.com", "bob@example.com"]);
    const aliceToken = (await manager.store.get("protected", "user:alice"))?.tokens?.access_token;
    const bobToken = (await manager.store.get("protected", "user:bob"))?.tokens?.access_token;
    expect(aliceToken).toBeTruthy();
    expect(bobToken).toBeTruthy();
    expect(aliceToken).not.toBe(bobToken);
  });

  it("reuses one authorization for every caller with tokens: shared", async () => {
    const { server, manager } = await harness({ auth: oauth({ tokens: "shared" }) });

    await completeLogin(manager, await callExpectingAuthorization(server, { id: "alice" }));

    const result = await server.callTool({ name: "echo", arguments: { message: "y" } }, { id: "bob" });
    expect(result.content).toEqual([{ type: "text", text: "demo-user:y" }]);
    expect(await manager.store.get("protected", "user:bob")).toBeUndefined();
    expect(await manager.status("protected", "shared")).toBe("authenticated");
  });

  it("obtains a client credentials token without any redirect", async () => {
    const authServer = await startAuthorizationServer();
    cleanups.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanups.push(() => upstream.close());
    authServer.preregister({ client_id: "svc-1", client_secret: "svc-secret", redirect_uris: [], grant_types: ["client_credentials"] });

    const auth = oauth.clientCredentials({ clientId: "svc-1", clientSecret: "svc-secret", scopes: ["mcp:tools"] });
    const transport = new StreamableHttpMcpTransport({ url: upstream.url, network });
    const server = mcp("protected", { transport, auth });
    cleanups.push(() => server.close());
    const manager = new OAuthManager({ store: new MemoryOAuthTokenStore(), callbackUrl });
    manager.register("protected", { auth, serverUrl: upstream.url, fetchFn: transport.createGuardedFetch() });
    server.attachOAuth((user) => manager.providerFor("protected", user));

    const result = await server.callTool({ name: "echo", arguments: { message: "m2m" } }, {});
    expect(result.content).toEqual([{ type: "text", text: "service:svc-1:m2m" }]);
    expect(await manager.status("protected", "shared")).toBe("authenticated");
  });

  it("blocks a private authorization server unless private URLs are allowed", async () => {
    const authServer = await startAuthorizationServer();
    cleanups.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanups.push(() => upstream.close());

    const auth = oauth();
    // No network override: 127.0.0.1 is a loopback address and must be refused.
    const transport = new StreamableHttpMcpTransport({ url: upstream.url });
    const server = mcp("protected", { transport, auth });
    cleanups.push(() => server.close());
    const manager = new OAuthManager({ store: new MemoryOAuthTokenStore(), callbackUrl });
    manager.register("protected", { auth, serverUrl: upstream.url, fetchFn: transport.createGuardedFetch() });
    server.attachOAuth((user) => manager.providerFor("protected", user));

    await expect(server.callTool({ name: "echo", arguments: { message: "x" } }, { id: "alice" })).rejects.toThrow(
      /Blocked upstream URL/,
    );
  });

  it("propagates the typed authorization error out of the SDK transport", async () => {
    const { server } = await harness();

    await expect(server.listTools(undefined, { id: "alice" })).rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
  });
});
