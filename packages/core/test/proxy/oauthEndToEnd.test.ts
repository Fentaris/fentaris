import { afterEach, describe, expect, it } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { Policy } from "../../src/governance.js";
import { mcp } from "../../src/server/index.js";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { oauthTokens } from "../../src/auth/oauth/store.js";
import { streamableHttp } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { startAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";
import { startProtectedMcpServer } from "../fixtures/oauth/protectedMcpServer.js";
import { connectElicitingClient } from "../fixtures/oauth/elicitingClient.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function freePort(): Promise<number> {
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("OAuth end to end through a real MCP client", () => {
  it("elicits the URL, completes on the hosted callback, and returns the tool result", async () => {
    const authServer = await startAuthorizationServer();
    cleanups.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanups.push(() => upstream.close());

    const port = await freePort();
    const app = fentaris({
      policy: Policy.allowAll(),
      port,
      host: "127.0.0.1",
      oauth: { store: oauthTokens.memory() },
      servers: [
        mcp("protected", {
          transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }),
          auth: oauth(),
        }),
      ],
    });
    await app.start();
    cleanups.push(() => app.close());

    const connected = await connectElicitingClient({ url: `http://127.0.0.1:${port}/mcp` });
    cleanups.push(() => connected.close());

    const before = await connected.client.listTools();
    expect(before.tools.map((tool) => tool.name)).not.toContain("protected__echo");
    expect(before.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["fentaris__auth_status", "fentaris__auth_login"]));

    const result = (await connected.client.callTool(
      { name: "protected__echo", arguments: { message: "through-the-proxy" } },
      CallToolResultSchema,
      { timeout: 20_000 },
    )) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "demo-user:through-the-proxy" }]);
    expect(connected.elicitedUrls).toHaveLength(1);
    expect(connected.elicitedUrls[0]).toContain("/authorize?");

    const after = await connected.client.listTools();
    expect(after.tools.map((tool) => tool.name)).toContain("protected__echo");
  }, 30_000);

  it("returns the structured pending result when the human declines", async () => {
    const authServer = await startAuthorizationServer();
    cleanups.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanups.push(() => upstream.close());

    const port = await freePort();
    const app = fentaris({
      policy: Policy.allowAll(),
      port,
      host: "127.0.0.1",
      oauth: { store: oauthTokens.memory() },
      servers: [
        mcp("protected", {
          transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }),
          auth: oauth(),
        }),
      ],
    });
    await app.start();
    cleanups.push(() => app.close());

    const connected = await connectElicitingClient({ url: `http://127.0.0.1:${port}/mcp`, approve: false });
    cleanups.push(() => connected.close());

    const result = (await connected.client.callTool(
      { name: "protected__echo", arguments: { message: "no" } },
      CallToolResultSchema,
      { timeout: 20_000 },
    )) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "FENTARIS_OAUTH_AUTHORIZATION_REQUIRED", server: "protected" });
  }, 30_000);
});
