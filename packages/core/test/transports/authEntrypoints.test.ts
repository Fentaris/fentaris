import { afterEach, describe, expect, it, vi } from "vitest";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { oauthIdentityStrategy } from "../../src/identity/oauthIdentityStrategy.js";
import { headerIdentityStrategy } from "../../src/identity/identity.js";
import { bearer, mcp } from "../../src/server/index.js";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { oauthTokens } from "../../src/auth/oauth/store.js";
import { streamableHttp } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { credential, credentialEnv } from "../../src/credentials/index.js";
import { group, Policy, user } from "../../src/governance.js";
import { startAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";
import { startProtectedMcpServer } from "../fixtures/oauth/protectedMcpServer.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

describe("discoverable authentication entrypoints", () => {
  it("advertises a Fentaris-owned login link without replacing the bearer challenge", async () => {
    const issuer = "https://issuer.example";
    const publicUrl = "https://proxy.example/fentaris";
    const app = fentaris({ port: 0, oauth: { publicUrl }, identity: oauthIdentityStrategy({ issuer, loginUrl: "https://issuer.example/sign-in", verify: () => ({}) }) });
    const server = await app.start(); closes.push(() => app.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const unauthorized = await fetch(`${base}/mcp`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(unauthorized.headers.get("link")).toBe(`<${publicUrl}/_fentaris/login>; rel="login"`);
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    expect(metadata.fentaris_login_uri).toBe(`${publicUrl}/_fentaris/login`);
    const login = await fetch(`${base}/_fentaris/login`, { redirect: "manual" });
    expect(login.status).toBe(302); expect(login.headers.get("location")).toBe("https://issuer.example/sign-in");
    for (const [path, init] of [
      ["/_fentaris/auth", undefined],
      ["/_fentaris/auth/login?server=calendar", { method: "POST" }],
    ] as const) {
      const protectedRoute = await fetch(`${base}${path}`, init);
      expect(protectedRoute.status).toBe(401);
      expect(protectedRoute.headers.get("www-authenticate")).toContain("resource_metadata=");
      expect(protectedRoute.headers.get("link")).toBe(`<${publicUrl}/_fentaris/login>; rel="login"`);
    }
  });

  it("keeps catalog reads inert and starts only the selected visible OAuth server explicitly", async () => {
    process.env.FENTARIS_TEST_API_TOKEN = "test-only-token";
    closes.push(async () => { delete process.env.FENTARIS_TEST_API_TOKEN; });
    const authorization = await startAuthorizationServer(); closes.push(() => authorization.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authorization }); closes.push(() => upstream.close());
    const transport = streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } });
    const calendar = mcp("calendar", { transport, accounts: {
      work: { auth: oauth(), allowedUsers: ["alice"] },
      private: { auth: oauth(), allowedUsers: ["bob"] },
    } });
    const restricted = mcp("restricted", { transport, auth: oauth() });
    const nonBrowser = mcp("api", { transport, auth: bearer(credential("api-token")) });
    const app = fentaris({
      port: 0,
      identity: headerIdentityStrategy({ userIdHeader: "x-user" }),
      oauth: { publicUrl: "https://proxy.example/fentaris", store: oauthTokens.memory() },
      defaults: { credentials: { "api-token": credentialEnv("FENTARIS_TEST_API_TOKEN") } },
      servers: [calendar, nonBrowser],
      groups: [
        group({ id: "alice", users: [user("alice")], policy: Policy.allowAll(), servers: [restricted] }),
        group({ id: "bob", users: [user("bob")], policy: Policy.allowAll() }),
      ],
    });
    const server = await app.start(); closes.push(() => app.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(`${base}/_fentaris/auth`)).status).toBe(401);
    const first = await fetch(`${base}/_fentaris/auth`, { headers: { "x-user": "alice" } });
    const catalog = await first.json() as { servers: Array<{ server: string; status: string; loginUrl: string }> };
    expect(catalog.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ server: "calendar", account: "work", status: "requires-login", loginUrl: "https://proxy.example/fentaris/_fentaris/auth/login?server=calendar&account=work" }),
      expect.objectContaining({ server: "restricted", status: "requires-login" }),
      expect.objectContaining({ server: "api", status: "setup-required", guidance: expect.stringContaining("Bearer") }),
    ]));
    expect(catalog.servers).not.toEqual(expect.arrayContaining([expect.objectContaining({ account: "private" })]));
    const again = await fetch(`${base}/_fentaris/auth`, { headers: { "x-user": "alice" } });
    expect(await again.json()).toEqual(catalog);
    const started = await fetch(`${base}/_fentaris/auth/login?server=calendar&account=work`, { method: "POST", headers: { "x-user": "alice" }, redirect: "manual" });
    expect(started.status).toBe(303); expect(started.headers.get("location")).toContain("/authorize?");
    const other = await fetch(`${base}/_fentaris/auth/login?server=missing`, { method: "POST", headers: { "x-user": "alice" } });
    expect(other.status).toBe(400);
    const anotherCallersAccount = await fetch(`${base}/_fentaris/auth/login?server=calendar&account=private`, { method: "POST", headers: { "x-user": "alice" } });
    expect(anotherCallersAccount.status).toBe(400);
    const forbiddenServer = await fetch(`${base}/_fentaris/auth/login?server=restricted`, { method: "POST", headers: { "x-user": "bob" } });
    expect(forbiddenServer.status).toBe(400);
    const bobCatalog = await (await fetch(`${base}/_fentaris/auth`, { headers: { "x-user": "bob" } })).json() as { servers: Array<{ server: string; account?: string }> };
    expect(bobCatalog.servers).not.toEqual(expect.arrayContaining([expect.objectContaining({ server: "restricted" }), expect.objectContaining({ account: "work" })]));
  });
  it("includes OAuth servers authorized only for resources or prompts", async () => {
    const authorization = await startAuthorizationServer(); closes.push(() => authorization.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authorization }); closes.push(() => upstream.close());
    const policy = new Policy({ name: "capabilities-only" })
      .mcp("documents").allowCapability({ operation: "resource:read", target: "file:///allowed", targetKind: "resource" })
      .mcp("prompts").allowCapability({ operation: "prompt:get", target: "allowed", targetKind: "prompt" });
    const transport = () => streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } });
    const app = fentaris({ port: 0, policy, identity: headerIdentityStrategy({ userIdHeader: "x-user" }), oauth: { store: oauthTokens.memory() }, servers: [
      mcp("documents", { transport: transport(), auth: oauth() }),
      mcp("prompts", { transport: transport(), auth: oauth() }),
    ] });
    const server = await app.start(); closes.push(() => app.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const response = await fetch(`${base}/_fentaris/auth`, { headers: { "x-user": "alice" } });
    const catalog = await response.json() as { servers: Array<{ server: string; status: string }> };
    expect(catalog.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ server: "documents", status: "requires-login" }),
      expect.objectContaining({ server: "prompts", status: "requires-login" }),
    ]));
    expect((await fetch(`${base}/_fentaris/auth/login?server=documents`, { method: "POST", headers: { "x-user": "alice" }, redirect: "manual" })).status).toBe(303);
  });

  it.each([
    { allowTarget: "file:///allowed", denyTarget: "file:///allowed", visible: false },
    { allowTarget: "file:///allowed", denyTarget: "*", visible: false },
    { allowTarget: "file:///allowed", denyTarget: "file:///different", visible: true },
    { allowTarget: "*", denyTarget: "file:///allowed", visible: true },
  ])("uses effective overlapping-group permissions (allow=$allowTarget, deny=$denyTarget)", async ({ allowTarget, denyTarget, visible }) => {
    const authorization = await startAuthorizationServer(); closes.push(() => authorization.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authorization }); closes.push(() => upstream.close());
    const app = fentaris({
      port: 0,
      identity: headerIdentityStrategy({ userIdHeader: "x-user" }),
      oauth: { store: oauthTokens.memory() },
      servers: [mcp("documents", { transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }), accounts: { work: { auth: oauth() } } })],
      groups: [
        group({ id: "reader", users: [user("alice")], policy: new Policy({ name: "reader" }).mcp("documents").allowCapability({ operation: "resource:read", target: allowTarget, targetKind: "resource" }) }),
        group({ id: "restricted", users: [user("alice")], policy: new Policy({ name: "restricted" }).mcp("documents").denyCapability({ operation: "resource:read", target: denyTarget, targetKind: "resource" }) }),
      ],
    });
    const server = await app.start(); closes.push(() => app.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const catalog = await (await fetch(`${base}/_fentaris/auth`, { headers: { "x-user": "alice" } })).json() as { servers: unknown[] };
    expect(catalog.servers).toHaveLength(visible ? 1 : 0);
    const beginLogin = vi.spyOn(app.oauth()!, "beginLogin");
    const started = await fetch(`${base}/_fentaris/auth/login?server=documents&account=work`, { method: "POST", headers: { "x-user": "alice" }, redirect: "manual" });
    expect(started.status).toBe(visible ? 303 : 400);
    expect(beginLogin).toHaveBeenCalledTimes(visible ? 1 : 0);
  });

  it("returns setup guidance without starting OAuth for a visible noninteractive account", async () => {
    const variable = "FENTARIS_AUTH_ENTRYPOINT_TEST_TOKEN";
    process.env[variable] = "secret";
    closes.push(async () => { delete process.env[variable]; });
    const app = fentaris({
      port: 0,
      policy: Policy.allowAll(),
      identity: headerIdentityStrategy({ userIdHeader: "x-user" }),
      defaults: { credentials: { token: credentialEnv(variable) } },
      servers: [mcp("static", { transport: streamableHttp({ url: "https://example.invalid/mcp" }), auth: bearer(credential("token")) })],
    });
    const server = await app.start(); closes.push(() => app.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const response = await fetch(`${base}/_fentaris/auth/login?server=static`, { method: "POST", headers: { "x-user": "alice" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      server: "static",
      status: "setup-required",
      guidance: expect.stringContaining("Bearer"),
    });
  });
});
