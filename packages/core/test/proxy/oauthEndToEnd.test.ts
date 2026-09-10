import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { Policy } from "../../src/governance.js";
import { mcp } from "../../src/server/index.js";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { oauthTokens } from "../../src/auth/oauth/store.js";
import { streamableHttp } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { group, user } from "../../src/governance.js";
import { credentialEnv } from "../../src/credentials/index.js";
import { oauthTokens as tokenStores } from "../../src/auth/oauth/store.js";
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

  it("keeps two API-key identities on two upstream subjects and persists tokens across a restart", async () => {
    let issued = 0;
    const authServer = await startAuthorizationServer({ subjectFor: () => `person-${++issued}@example.com` });
    cleanups.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanups.push(() => upstream.close());

    const storeDir = await mkdtemp(join(tmpdir(), "fentaris-oauth-e2e-"));
    cleanups.push(() => rm(storeDir, { recursive: true, force: true }));
    process.env.OAUTH_E2E_ALICE_KEY = "alice-key";
    process.env.OAUTH_E2E_BOB_KEY = "bob-key";
    cleanups.push(async () => {
      delete process.env.OAUTH_E2E_ALICE_KEY;
      delete process.env.OAUTH_E2E_BOB_KEY;
    });

    const port = await freePort();
    const config = () => ({
      policy: Policy.allowAll(),
      port,
      host: "127.0.0.1" as const,
      oauth: { store: tokenStores.local({ dir: storeDir, key: "e2e-key" }) },
      groups: [
        group({
          id: "team",
          policy: Policy.allowAll(),
          users: [
            user("alice", { apiKeys: [credentialEnv("OAUTH_E2E_ALICE_KEY")] }),
            user("bob", { apiKeys: [credentialEnv("OAUTH_E2E_BOB_KEY")] }),
          ],
          servers: [
            mcp("protected", {
              transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }),
              auth: oauth(),
            }),
          ],
        }),
      ],
    });

    const app = fentaris(config());
    await app.start();
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) {
        await app.close();
      }
    });

    const callAs = async (apiKey: string, message: string): Promise<CallToolResult> => {
      const connected = await connectElicitingClient({
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "x-fentaris-api-key": apiKey },
      });
      try {
        return (await connected.client.callTool(
          { name: "protected__echo", arguments: { message } },
          CallToolResultSchema,
          { timeout: 20_000 },
        )) as CallToolResult;
      } finally {
        await connected.close();
      }
    };

    const aliceResult = await callAs("alice-key", "a");
    const bobResult = await callAs("bob-key", "b");

    expect(aliceResult.content).toEqual([{ type: "text", text: "person-1@example.com:a" }]);
    expect(bobResult.content).toEqual([{ type: "text", text: "person-2@example.com:b" }]);
    expect(upstream.callers).toEqual(["person-1@example.com", "person-2@example.com"]);

    await app.close();
    stopped = true;

    // A fresh proxy over the same encrypted store must reuse the stored authorizations.
    const restarted = fentaris(config());
    await restarted.start();
    cleanups.push(() => restarted.close());

    const afterRestart = await callAs("alice-key", "again");
    expect(afterRestart.isError).toBeFalsy();
    expect(afterRestart.content).toEqual([{ type: "text", text: "person-1@example.com:again" }]);
    expect(issued).toBe(2);
  }, 40_000);
});
