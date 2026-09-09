import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { findOAuthAuthorizationRequiredError, type OAuthAuthorizationRequiredError } from "../auth/oauth/errors.js";
import type { OAuthManager } from "../auth/oauth/manager.js";
import { redactOAuthUrl } from "../auth/oauth/redaction.js";
import type { McpServer } from "../server/McpServer.js";
import type { ProxySessionInteraction } from "../types/proxy.js";
import type { UserContext } from "../types/shared.js";

/** Structured code returned when a tool call needs an upstream authorization. @pk */
export const OAUTH_AUTHORIZATION_REQUIRED_CODE = "FENTARIS_OAUTH_AUTHORIZATION_REQUIRED";

/**
 * Run a tool call, and when the upstream requires an OAuth authorization, hand the
 * authorization URL to the human through URL elicitation, wait for consent, and retry
 * the call once. Falls back to a structured tool result when the client cannot elicit.
 * @pk
 */
export async function withOAuthConsent(params: {
  manager: OAuthManager | undefined;
  server: McpServer | undefined;
  user: UserContext;
  interaction: ProxySessionInteraction | undefined;
  log?: { info?: (message: string, meta?: Record<string, unknown>) => void; warn?: (message: string, meta?: Record<string, unknown>) => void };
  run: () => Promise<CallToolResult>;
}): Promise<CallToolResult> {
  const { manager, server, interaction, user } = params;
  if (!manager || !server?.getOAuthAuth()) {
    return params.run();
  }

  let authorizationRequired: OAuthAuthorizationRequiredError | undefined;
  try {
    return await params.run();
  } catch (error: unknown) {
    authorizationRequired = findOAuthAuthorizationRequiredError(error);
    if (!authorizationRequired) {
      throw error;
    }
  }

  const pending = authorizationRequired;
  params.log?.info?.("Upstream authorization required", {
    server: pending.server,
    authorizationUrl: redactOAuthUrl(pending.authorizationUrl),
  });

  if (!interaction?.supportsUrlElicitation()) {
    return authorizationRequiredResult(pending, "The connected MCP client cannot open an authorization URL.");
  }

  manager.onCompleted(pending.state, async () => {
    await interaction.notifyElicitationComplete(pending.state).catch(() => undefined);
  });

  let action: "accept" | "decline" | "cancel";
  try {
    ({ action } = await interaction.elicitUrl({
      message: `Sign in to "${pending.server}" to continue.`,
      url: pending.authorizationUrl,
      elicitationId: pending.state,
    }));
  } catch {
    return authorizationRequiredResult(pending, "The authorization prompt could not be delivered to the client.");
  }

  if (action !== "accept") {
    return authorizationRequiredResult(pending, `Authorization was ${action === "decline" ? "declined" : "cancelled"}.`);
  }

  const outcome = await manager.waitForCompletion(pending.state);
  if (outcome.status !== "completed") {
    return authorizationRequiredResult(
      pending,
      outcome.status === "timeout" ? "Authorization is still pending; retry the call after signing in." : `Authorization failed: ${outcome.reason}.`,
    );
  }

  await server.evictTransport(user);
  return params.run();
}

/**
 * Structured result describing a pending upstream authorization.
 * @pk
 */
export function authorizationRequiredResult(pending: OAuthAuthorizationRequiredError, note: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Authorization required for MCP server "${pending.server}". ${note} Open this URL to sign in, then retry:\n${pending.authorizationUrl}`,
      },
    ],
    structuredContent: {
      code: OAUTH_AUTHORIZATION_REQUIRED_CODE,
      server: pending.server,
      authorizationUrl: pending.authorizationUrl,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    },
  };
}
