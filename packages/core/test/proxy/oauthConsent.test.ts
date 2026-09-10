import { afterEach, describe, expect, it, vi } from "vitest";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { Policy } from "../../src/governance.js";
import { mcp } from "../../src/server/index.js";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { oauthTokens } from "../../src/auth/oauth/store.js";
import { streamableHttp } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { createOAuthCallbackRoutes } from "../../src/transports/exposure/oauthCallbackRoutes.js";
import { OAUTH_AUTHORIZATION_REQUIRED_CODE } from "../../src/proxy/oauthInteraction.js";
import { startAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";
import { approveAuthorization, startProtectedMcpServer } from "../fixtures/oauth/protectedMcpServer.js";
import type { McpProxy } from "../../src/proxy/McpProxy.js";
import type { ProxySessionInteraction } from "../../src/types/proxy.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function proxyHarness(): Promise<{ app: McpProxy; upstreamUrl: string }> {
  const authServer = await startAuthorizationServer();
  cleanups.push(() => authServer.close());
  const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
  cleanups.push(() => upstream.close());

  const app = fentaris({
    policy: Policy.allowAll(),
    oauth: { store: oauthTokens.memory() },
    servers: [
      mcp("protected", {
        transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }),
        auth: oauth(),
      }),
    ],
  });
  app.oauth()?.setCallbackUrl("http://127.0.0.1:4599/_fentaris/oauth/callback");
  cleanups.push(() => app.close());

  return { app, upstreamUrl: upstream.url };
}

function interactionStub(options: {
  supportsUrl: boolean;
  action?: "accept" | "decline" | "cancel";
  onElicit?: (params: { url: string; elicitationId: string }) => Promise<void> | void;
}): ProxySessionInteraction & { completions: string[] } {
  const completions: string[] = [];
  return {
    completions,
    supportsUrlElicitation: () => options.supportsUrl,
    async elicitUrl(params) {
      await options.onElicit?.(params);
      return { action: options.action ?? "accept" };
    },
    async notifyElicitationComplete(elicitationId) {
      completions.push(elicitationId);
    },
  };
}

describe("OAuth consent through URL elicitation", () => {
  it("elicits the URL, waits for the callback, notifies completion, and retries the call", async () => {
    const { app } = await proxyHarness();
    const manager = app.oauth();
    const interaction = interactionStub({
      supportsUrl: true,
      onElicit: async ({ url, elicitationId }) => {
        const callback = await approveAuthorization(url);
        expect(callback.state).toBe(elicitationId);
        await manager?.completeCallback({ state: callback.state as string, code: callback.code });
      },
    });

    const result = await app.callTool(
      { name: "protected__echo", arguments: { message: "hello" } },
      { id: "alice" },
      undefined,
      undefined,
      interaction,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "demo-user:hello" }]);
    expect(interaction.completions).toHaveLength(1);
  });

  it("returns a structured pending result when the client cannot elicit a URL", async () => {
    const { app } = await proxyHarness();
    const interaction = interactionStub({ supportsUrl: false });

    const result = await app.callTool(
      { name: "protected__echo", arguments: { message: "hello" } },
      { id: "alice" },
      undefined,
      undefined,
      interaction,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: OAUTH_AUTHORIZATION_REQUIRED_CODE, server: "protected" });
    expect(String(result.structuredContent?.authorizationUrl)).toContain("code_challenge_method=S256");
  });

  it("returns the pending result when the human declines", async () => {
    const { app } = await proxyHarness();
    const interaction = interactionStub({ supportsUrl: true, action: "decline" });

    const result = await app.callTool(
      { name: "protected__echo", arguments: { message: "hello" } },
      { id: "alice" },
      undefined,
      undefined,
      interaction,
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toMatchObject({ text: expect.stringContaining("declined") });
  });

  it("returns the pending result when consent times out", async () => {
    const { app } = await proxyHarness();
    const manager = app.oauth();
    vi.spyOn(manager!, "waitForCompletion").mockResolvedValue({ status: "timeout" });
    const interaction = interactionStub({ supportsUrl: true });

    const result = await app.callTool(
      { name: "protected__echo", arguments: { message: "hello" } },
      { id: "alice" },
      undefined,
      undefined,
      interaction,
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toMatchObject({ text: expect.stringContaining("still pending") });
  });
});

describe("OAuth tool listing degradation and agent tools", () => {
  it("omits an unauthorized server, keeps listing, and never contacts the authorization server", async () => {
    const authServer = await startAuthorizationServer();
    cleanups.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanups.push(() => upstream.close());

    const app = fentaris({
      policy: Policy.allowAll(),
      oauth: { store: oauthTokens.memory() },
      servers: [
        mcp("protected", {
          transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }),
          auth: oauth(),
        }),
      ],
    });
    cleanups.push(() => app.close());
    app.oauth()?.setCallbackUrl("http://127.0.0.1:4599/_fentaris/oauth/callback");

    const tools = await app.listTools(undefined, { id: "alice" });
    const names = tools.tools.map((tool) => tool.name);

    expect(names).not.toContain("protected__echo");
    expect(names).toContain("fentaris__auth_status");
    expect(names).toContain("fentaris__auth_login");
    expect(authServer.tokenRequests).toBe(0);
    expect(upstream.challenges).toBe(0);
  });

  it("reports status and starts a login through the built-in agent tools", async () => {
    const { app } = await proxyHarness();

    const status = await app.callTool({ name: "fentaris__auth_status", arguments: {} }, { id: "alice" });
    expect(status.structuredContent).toMatchObject({
      servers: [{ server: "protected", session: "user:alice", status: "requires-login" }],
    });

    const login = await app.callTool({ name: "fentaris__auth_login", arguments: { server: "protected" } }, { id: "alice" });
    expect(login.structuredContent).toMatchObject({ server: "protected", status: "authorization-required", loginMode: "browser" });
    expect(String((login.structuredContent as { authorizationUrl?: string }).authorizationUrl)).toContain("/authorize?");

    const unknown = await app.callTool({ name: "fentaris__auth_login", arguments: { server: "nope" } }, { id: "alice" });
    expect(unknown.isError).toBe(true);
  });

  it("lists the upstream tools once the caller is authorized", async () => {
    const { app } = await proxyHarness();
    const manager = app.oauth();
    const started = await manager!.beginLogin("protected", { id: "alice" });
    const callback = await approveAuthorization(started.authorizationUrl as string);
    await manager!.completeCallback({ state: callback.state as string, code: callback.code });

    const tools = await app.listTools(undefined, { id: "alice" });
    expect(tools.tools.map((tool) => tool.name)).toContain("protected__echo");
  });
});

describe("hosted OAuth callback route", () => {
  it("completes an authorization and reports unknown or failed states without leaking the code", async () => {
    const { app } = await proxyHarness();
    const manager = app.oauth();
    const [route] = createOAuthCallbackRoutes({ manager: manager!, path: "/_fentaris/oauth/callback" }).httpRoutes;

    const started = await manager!.beginLogin("protected", { id: "alice" });
    const callback = await approveAuthorization(started.authorizationUrl as string);

    const success = await invokeRoute(route.handler, `http://127.0.0.1/_fentaris/oauth/callback?code=${callback.code}&state=${callback.state}`);
    expect(success.status).toBe(200);
    expect(success.body).toContain("Signed in");
    expect(success.body).not.toContain(callback.code as string);
    expect(await manager!.status("protected", "user:alice")).toBe("authenticated");

    const unknown = await invokeRoute(route.handler, "http://127.0.0.1/_fentaris/oauth/callback?code=x&state=nope");
    expect(unknown.status).toBe(410);

    const missingState = await invokeRoute(route.handler, "http://127.0.0.1/_fentaris/oauth/callback?code=x");
    expect(missingState.status).toBe(400);

    const started2 = await manager!.beginLogin("protected", { id: "bob" });
    const denied = await invokeRoute(
      route.handler,
      `http://127.0.0.1/_fentaris/oauth/callback?error=access_denied&state=${started2.state}`,
    );
    expect(denied.status).toBe(400);
    expect(denied.body).toContain("access_denied");
  });
});

async function invokeRoute(
  handler: (req: never, res: never, url: URL) => void | Promise<void>,
  url: string,
): Promise<{ status: number; body: string }> {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  };

  await handler({} as never, res as never, new URL(url));
  return { status, body };
}
