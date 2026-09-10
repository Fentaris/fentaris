import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { closeServer, sendJson, tokenSubject, type FixtureAuthorizationServer } from "./authorizationServer.js";

export type FixtureProtectedMcpServer = {
  url: string;
  /** Subjects seen on successful tool calls, in order. */
  callers: string[];
  /** Number of 401 challenges emitted. */
  challenges: number;
  close(): Promise<void>;
};

/**
 * Start an OAuth-protected MCP server: bearer check, RFC 9728 protected resource
 * metadata, `WWW-Authenticate` challenge, and one `echo` tool that reports the
 * authenticated subject.
 */
export async function startProtectedMcpServer(options: {
  authorizationServer: FixtureAuthorizationServer;
  path?: string;
}): Promise<FixtureProtectedMcpServer> {
  const path = options.path ?? "/mcp";
  const state = { challenges: 0 };
  const callers: string[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let baseUrl = "";

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: "server_error", error_description: String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", baseUrl);

    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === `/.well-known/oauth-protected-resource${path}`) {
      sendJson(res, 200, {
        resource: `${baseUrl}${path}`,
        authorization_servers: [options.authorizationServer.url],
        scopes_supported: ["mcp:tools"],
        bearer_methods_supported: ["header"],
      });
      return;
    }

    if (url.pathname !== path) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const header = req.headers.authorization;
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    const subject = token ? tokenSubject(options.authorizationServer, token) : undefined;
    if (!subject) {
      state.challenges += 1;
      sendJson(
        res,
        401,
        { error: "invalid_token", error_description: "A valid access token is required" },
        {
          "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${path}"`,
        },
      );
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const mcp = new SdkMcpServer({ name: "fixture-protected-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.registerTool(
      "echo",
      { description: "Echo a message back with the authenticated subject", inputSchema: { message: z.string() } },
      async ({ message }: { message: string }) => {
        callers.push(subject);
        return { content: [{ type: "text" as const, text: `${subject}:${message}` }] };
      },
    );

    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: `${baseUrl}${path}`,
    callers,
    get challenges() {
      return state.challenges;
    },
    async close(): Promise<void> {
      for (const transport of transports.values()) {
        await transport.close().catch(() => undefined);
      }

      await closeServer(server);
    },
  };
}

/**
 * Follow a fixture authorization URL to completion and return the callback query
 * parameters, simulating a human approving consent in a browser.
 */
export async function approveAuthorization(authorizationUrl: string): Promise<{ code?: string; state?: string; error?: string }> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Authorization endpoint did not redirect (status ${response.status}): ${await response.text()}`);
  }

  const url = new URL(location);
  return {
    ...(url.searchParams.get("code") ? { code: url.searchParams.get("code") as string } : {}),
    ...(url.searchParams.get("state") ? { state: url.searchParams.get("state") as string } : {}),
    ...(url.searchParams.get("error") ? { error: url.searchParams.get("error") as string } : {}),
  };
}
