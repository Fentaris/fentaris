import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { Policy } from "../../src/governance.js";
import { mcp } from "../../src/server/index.js";
import { oauth } from "../../src/auth/oauth/dsl.js";
import { oauthTokens } from "../../src/auth/oauth/store.js";
import { stdio } from "../../src/transports/client/StdioTransport.js";
import { streamableHttp } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { startAuthorizationServer } from "../fixtures/oauth/authorizationServer.js";
import { startProtectedMcpServer } from "../fixtures/oauth/protectedMcpServer.js";
import type { FentarisTransport } from "../../src/types/transport.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function healthyTransport(): FentarisTransport {
  return {
    listTools: async () => ({ tools: [{ name: "status", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content: [] }),
    listResources: async () => ({ resources: [{ uri: "file:///readme.md", name: "readme" }] }),
    listResourceTemplates: async () => ({ resourceTemplates: [{ uriTemplate: "file:///{path}", name: "file" }] }),
    listPrompts: async () => ({ prompts: [{ name: "summarize" }] }),
    close: async () => undefined,
  };
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: "isolation-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  cleanups.push(() => client.close());
  return client;
}

async function listEverything(client: Client) {
  const [tools, resources, resourceTemplates, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
    client.listPrompts(),
  ]);
  return {
    tools: tools.tools.map((tool) => tool.name),
    resources: resources.resources.map((resource) => resource.uri),
    resourceTemplates: resourceTemplates.resourceTemplates.map((template) => template.uriTemplate),
    prompts: prompts.prompts.map((prompt) => prompt.name),
  };
}

describe("aggregated listings through a real MCP client", () => {
  it("initializes and lists every capability of a healthy upstream while others are refused or crash", async () => {
    const port = await freePort();
    const app = fentaris({
      policy: Policy.allowAll().mcp("*").allowCapability({ operation: "*", target: "*" }),
      port,
      host: "127.0.0.1",
      servers: [
        mcp("healthy", { transport: healthyTransport() }),
        mcp("refused", {
          transport: streamableHttp({ url: `http://127.0.0.1:${await freePort()}/mcp`, network: { allowPrivateNetworkUrls: true } }),
        }),
        mcp("crashing", { transport: stdio({ command: process.execPath, args: ["-e", "process.exit(1)"], stderr: "ignore" }) }),
      ],
    });
    await app.start();
    cleanups.push(() => app.close());

    const client = await connectClient(port);
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    await expect(listEverything(client)).resolves.toEqual({
      tools: ["healthy__status"],
      resources: ["fentaris://resources/healthy/file%3A%2F%2F%2Freadme.md"],
      resourceTemplates: ["fentaris://resource-templates/healthy/file%3A%2F%2F%2F%7Bpath%7D"],
      prompts: ["healthy__summarize"],
    });
  });

  it("omits an unauthorized OAuth upstream from every listing without contacting the authorization server", async () => {
    const authServer = await startAuthorizationServer();
    cleanups.push(() => authServer.close());
    const upstream = await startProtectedMcpServer({ authorizationServer: authServer });
    cleanups.push(() => upstream.close());

    const app = fentaris({
      policy: Policy.allowAll().mcp("*").allowCapability({ operation: "*", target: "*" }),
      oauth: { store: oauthTokens.memory() },
      servers: [
        mcp("healthy", { transport: healthyTransport() }),
        mcp("protected", {
          transport: streamableHttp({ url: upstream.url, network: { allowPrivateNetworkUrls: true } }),
          auth: oauth(),
        }),
      ],
    });
    cleanups.push(() => app.close());
    app.oauth()?.setCallbackUrl("http://127.0.0.1:4599/_fentaris/oauth/callback");

    const user = { id: "alice" };
    await expect(app.listResources(undefined, user)).resolves.toEqual({
      resources: [{ uri: "fentaris://resources/healthy/file%3A%2F%2F%2Freadme.md", name: "readme" }],
    });
    await expect(app.listResourceTemplates(undefined, user)).resolves.toMatchObject({
      resourceTemplates: [{ name: "file" }],
    });
    await expect(app.listPrompts(undefined, user)).resolves.toEqual({
      prompts: [{ name: "healthy__summarize" }],
    });
    expect(authServer.registrations).toHaveLength(0);
    expect(authServer.tokenRequests).toBe(0);
    expect(upstream.challenges).toBe(0);
  });
});
