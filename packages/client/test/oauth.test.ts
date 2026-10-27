import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fentaris, mcp, McpServer, oauth, oauthIdentityStrategy, oauthTokens, Policy, streamableHttp } from "@fentaris/core";
import { startAuthorizationServer, type FixtureAuthorizationServer } from "../../core/test/fixtures/oauth/authorizationServer.js";
import { startProtectedMcpServer } from "../../core/test/fixtures/oauth/protectedMcpServer.js";
import { alicePolicy, DemoTransport, run, tempDirectory, testRuntime, type TestRuntime } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Act as the human in the browser: follow the authorization redirect to its callback. */
function approveInBrowser(runtime: TestRuntime) {
  runtime.interactive = true;
  runtime.openUrl = async (url) => {
    runtime.opened.push(url);
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    if (location) await fetch(location);
  };
}

async function oauthProxy(as: FixtureAuthorizationServer, cli?: { clientId: string; audience?: string }) {
  const upstream = new DemoTransport();
  const app = fentaris({
    port: 0,
    identity: {
      strategy: oauthIdentityStrategy({
        issuer: as.url,
        ...(cli ? { cli } : {}),
        verify: async (token) => {
          const response = await fetch(`${as.url}/introspect`, { method: "POST", body: new URLSearchParams({ token }) });
          const claims = await response.json() as { active: boolean } & Record<string, unknown>;
          if (!claims.active) throw new Error("inactive");
          return claims as never;
        },
      }),
      required: true,
    },
    groups: [alicePolicy("demo-user")],
    servers: [new McpServer({ name: "demo", transport: upstream })],
  });
  const server = await app.start();
  cleanup.push(() => app.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

describe("OAuth login", () => {
  it("signs in with the proxy-advertised client, PKCE, and resource indicator", async () => {
    const as = await startAuthorizationServer();
    cleanup.push(() => as.close());
    const port = await freePort();
    as.preregister({ client_id: "frs-cli", redirect_uris: [`http://127.0.0.1:${port}/callback`] });
    const url = await oauthProxy(as, { clientId: "frs-cli", audience: "https://api.example" });
    const runtime = testRuntime(await tempDirectory(cleanup));
    approveInBrowser(runtime);

    const login = await run(runtime, "auth", "login", url, "--port", String(port), "--json");
    expect(login.code).toBe(0);
    expect(login.json.data).toMatchObject({ profile: "default", url, method: "oauth" });
    const authorize = new URL(runtime.opened[0]!);
    expect(authorize.searchParams.get("client_id")).toBe("frs-cli");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe(url);
    expect(authorize.searchParams.get("audience")).toBe("https://api.example");
    expect(as.issuedTokens.at(-1)).toMatchObject({ clientId: "frs-cli", subject: "demo-user", resource: url });

    const status = await run(runtime, "auth", "status", "--json");
    expect(status.json.data).toMatchObject({ method: "oauth", verified: true });
    const call = await run(runtime, "tools", "call", "demo__echo", "--arg", "text=oauth", "--json");
    expect(call.json.data.structuredContent).toEqual({ echoed: "oauth" });
    for (const secret of as.sensitiveValues) expect(login.stdout + login.stderr + status.stdout).not.toContain(secret);
  });

  it("registers a client dynamically and refreshes a rejected access token once", async () => {
    const as = await startAuthorizationServer();
    cleanup.push(() => as.close());
    const url = await oauthProxy(as);
    const runtime = testRuntime(await tempDirectory(cleanup));
    approveInBrowser(runtime);

    expect((await run(runtime, "auth", "login", url, "--json")).code).toBe(0);
    expect(as.registrations).toHaveLength(1);
    expect(as.registrations[0]!.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const requests = as.tokenRequests;
    as.expireAccessTokens();
    const list = await run(runtime, "tools", "list", "--json");
    expect(list.code).toBe(0);
    expect(as.tokenRequests).toBe(requests + 1);

    as.toggles.rejectRefresh = true;
    as.expireAccessTokens();
    const rejected = await run(runtime, "tools", "list", "--json");
    expect(rejected.code).toBe(3);
    expect(rejected.json.error.code).toBe("AUTH_REQUIRED");
    expect(rejected.json.nextActions[0].command).toBe(`frs auth login ${url}`);
  });

  it("refreshes proactively when the stored token is about to expire", async () => {
    const as = await startAuthorizationServer({ accessTokenTtlSeconds: 1 });
    cleanup.push(() => as.close());
    const url = await oauthProxy(as);
    const runtime = testRuntime(await tempDirectory(cleanup));
    approveInBrowser(runtime);
    expect((await run(runtime, "auth", "login", url, "--json")).code).toBe(0);
    const requests = as.tokenRequests;
    expect((await run(runtime, "tools", "list", "--json")).code).toBe(0);
    expect(as.tokenRequests).toBe(requests + 1);
  });

  it("fails before opening a browser when no client can be selected", async () => {
    const as = await startAuthorizationServer({ withoutRegistrationEndpoint: true });
    cleanup.push(() => as.close());
    const url = await oauthProxy(as);
    const runtime = testRuntime(await tempDirectory(cleanup));
    const login = await run(runtime, "auth", "login", url, "--json");
    expect(login.code).toBe(3);
    expect(login.json.error.code).toBe("OAUTH_CLIENT_REQUIRED");
    expect(runtime.opened).toEqual([]);
  });

  it("suggests API key login when the proxy has no OAuth metadata", async () => {
    const app = fentaris({ port: 0, policy: Policy.allowAll(), servers: [new McpServer({ name: "demo", transport: new DemoTransport() })] });
    const server = await app.start();
    cleanup.push(() => app.close());
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const login = await run(testRuntime(await tempDirectory(cleanup)), "auth", "login", url, "--json");
    expect(login.json.error.code).toBe("LOGIN_FAILED");
    expect(login.json.nextActions[0].command).toBe(`frs auth login ${url} --with-api-key`);
  });
});

describe("upstream authorization during a call", () => {
  async function protectedSetup() {
    const authServer = await startAuthorizationServer();
    cleanup.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanup.push(() => upstream.close());
    const port = await freePort();
    const app = fentaris({
      policy: Policy.allowAll(), port, host: "127.0.0.1",
      oauth: { store: oauthTokens.memory() },
      servers: [mcp("protected", { transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }), auth: oauth() })],
    });
    await app.start();
    cleanup.push(() => app.close());
    return `http://127.0.0.1:${port}/mcp`;
  }

  it("completes URL elicitation in the browser and returns the original result", async () => {
    const url = await protectedSetup();
    const runtime = testRuntime(await tempDirectory(cleanup), { env: { FENTARIS_URL: url } });
    approveInBrowser(runtime);
    const call = await run(runtime, "tools", "call", "protected__echo", "--arg", "message=elicited", "--json");
    expect(call.code).toBe(0);
    expect(JSON.stringify(call.json.data.content)).toContain("elicited");
    expect(runtime.opened).toHaveLength(1);
    expect(call.stderr).toContain("Open this URL to continue");
  });

  it("declines non-interactively and reports the authorization URL", async () => {
    const url = await protectedSetup();
    const runtime = testRuntime(await tempDirectory(cleanup), { env: { FENTARIS_URL: url } });
    const call = await run(runtime, "tools", "call", "protected__echo", "--arg", "message=x", "--json");
    expect(call.code).toBe(3);
    expect(call.json.error).toMatchObject({ code: "UPSTREAM_AUTH_REQUIRED", details: { server: "protected", authorizationUrl: expect.stringContaining("/authorize") } });
    expect(runtime.opened).toEqual([]);
  });
});
