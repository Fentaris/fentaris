import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyLocalHandle } from "../../types/proxy.js";
import type { UserContext } from "../../types/shared.js";
import type { OAuthManager } from "./manager.js";

/** Local namespace hosting the built-in Fentaris agent tools. @pk */
export const FENTARIS_LOCAL_NAMESPACE = "fentaris";

/**
 * Register `fentaris__auth_status` and `fentaris__auth_login` so an agent can see
 * which upstream servers need a login and start one.
 * @pk
 */
export function registerOAuthAgentTools(handle: ProxyLocalHandle, options: { manager: () => OAuthManager | undefined }): void {
  handle.tool(
    "auth_status",
    {
      title: "Upstream authorization status",
      description: "Report which OAuth-protected MCP servers are authorized for the current caller.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async (context) => {
      const manager = options.manager();
      if (!manager) {
        return json({ servers: [] });
      }

      const user = (context.user ?? {}) as UserContext;
      const servers = await Promise.all(
        manager.servers().map(async (server) => ({
          server,
          session: manager.sessionKeyFor(server, user),
          status: await manager.status(server, manager.sessionKeyFor(server, user)),
        })),
      );

      return json({ servers });
    },
  );

  handle.tool(
    "auth_login",
    {
      title: "Start an upstream authorization",
      description: "Start an OAuth login for one MCP server and return the URL the human must open.",
      inputSchema: {
        type: "object",
        properties: { server: { type: "string", description: "Name of the OAuth-protected MCP server." } },
        required: ["server"],
        additionalProperties: false,
      },
    },
    async (context, params) => {
      const manager = options.manager();
      const serverName = (params.arguments as { server?: unknown } | undefined)?.server;
      if (typeof serverName !== "string" || !serverName.trim()) {
        return errorResult("A server name is required.");
      }

      if (!manager?.registrationFor(serverName)) {
        return errorResult(`MCP server "${serverName}" is not declared with oauth().`);
      }

      const user = (context.user ?? {}) as UserContext;
      try {
        const started = await manager.beginLogin(serverName, user);
        if (started.status === "authenticated") {
          return json({ server: serverName, status: "authenticated" });
        }

        return json({
          server: serverName,
          status: "authorization-required",
          loginMode: "browser",
          authorizationUrl: started.authorizationUrl,
          state: started.state,
          expiresAt: started.expiresAt ? new Date(started.expiresAt).toISOString() : undefined,
        });
      } catch (error: unknown) {
        return errorResult(error instanceof Error ? error.message : "Login could not be started.");
      }
    },
  );
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
