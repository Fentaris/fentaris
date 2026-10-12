import { afterEach, describe, expect, it } from "vitest";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { oauthIdentityStrategy } from "../../src/identity/oauthIdentityStrategy.js";
import { headerIdentityStrategy } from "../../src/identity/identity.js";
import { mcp } from "../../src/server/index.js";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { oauthTokens } from "../../src/auth/oauth/store.js";
import { streamableHttp } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { Policy } from "../../src/governance.js";
import { startAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";
import { startProtectedMcpServer } from "../fixtures/oauth/protectedMcpServer.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

describe("discoverable authentication entrypoints", () => {
  it("advertises a Fentaris-owned login link without replacing the bearer challenge", async () => {
    const issuer = "https://issuer.example";
    const app = fentaris({ port: 0, identity: oauthIdentityStrategy({ issuer, loginUrl: "https://issuer.example/sign-in", verify: () => ({}) }) });
    const server = await app.start(); closes.push(() => app.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const unauthorized = await fetch(`${base}/mcp`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(unauthorized.headers.get("link")).toBe('</_fentaris/login>; rel="login"');
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    expect(metadata.fentaris_login_uri).toBe(`${base}/_fentaris/login`);
    const login = await fetch(`${base}/_fentaris/login`, { redirect: "manual" });
    expect(login.status).toBe(302); expect(login.headers.get("location")).toBe("https://issuer.example/sign-in");
  });

  it("keeps catalog reads inert and starts only the selected visible OAuth server explicitly", async () => {
    const authorization = await startAuthorizationServer(); closes.push(() => authorization.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authorization }); closes.push(() => upstream.close());
    const app = fentaris({ port: 0, policy: Policy.allowAll(), identity: headerIdentityStrategy({ userIdHeader: "x-user" }), oauth: { store: oauthTokens.memory() }, servers: [mcp("calendar", { transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }), auth: oauth() })] });
    const server = await app.start(); closes.push(() => app.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(`${base}/_fentaris/auth`)).status).toBe(401);
    const first = await fetch(`${base}/_fentaris/auth`, { headers: { "x-user": "alice" } });
    const catalog = await first.json() as { servers: Array<{ server: string; status: string; loginUrl: string }> };
    expect(catalog.servers).toEqual([expect.objectContaining({ server: "calendar", status: "requires-login", loginUrl: `${base}/_fentaris/auth/login?server=calendar` })]);
    const again = await fetch(`${base}/_fentaris/auth`, { headers: { "x-user": "alice" } });
    expect(await again.json()).toEqual(catalog);
    const started = await fetch(`${base}/_fentaris/auth/login?server=calendar`, { method: "POST", headers: { "x-user": "alice" }, redirect: "manual" });
    expect(started.status).toBe(303); expect(started.headers.get("location")).toContain("/authorize?");
    const other = await fetch(`${base}/_fentaris/auth/login?server=missing`, { method: "POST", headers: { "x-user": "alice" } });
    expect(other.status).toBe(400);
  });
});
