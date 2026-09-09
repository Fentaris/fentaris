import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type ElicitingClient = {
  client: Client;
  /** Authorization URLs the client was asked to open, in order. */
  elicitedUrls: string[];
  /** Elicitation ids the server reported as complete. */
  completed: string[];
  close(): Promise<void>;
};

/**
 * MCP client that advertises URL-mode elicitation and approves any authorization URL
 * by following it, the way a human clicking the link in a browser would.
 */
export async function connectElicitingClient(options: {
  url: string;
  headers?: Record<string, string>;
  approve?: boolean;
}): Promise<ElicitingClient> {
  const elicitedUrls: string[] = [];
  const completed: string[] = [];

  const client = new Client(
    { name: "fixture-eliciting-client", version: "1.0.0" },
    { capabilities: { elicitation: { url: {} } } },
  );

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = request.params as { mode?: string; url?: string; elicitationId?: string };
    if (params.mode !== "url" || !params.url) {
      return { action: "decline" as const };
    }

    elicitedUrls.push(params.url);
    if (options.approve === false) {
      return { action: "decline" as const };
    }

    // Follow the authorization URL and then the redirect to the Fentaris callback.
    const authorizeResponse = await fetch(params.url, { redirect: "manual" });
    const location = authorizeResponse.headers.get("location");
    if (location) {
      await fetch(location);
    }

    return { action: "accept" as const };
  });

  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === "notifications/elicitation/complete") {
      const params = notification.params as { elicitationId?: string } | undefined;
      if (params?.elicitationId) {
        completed.push(params.elicitationId);
      }
    }
  };

  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: options.headers ? { headers: options.headers } : undefined,
  });
  await client.connect(transport);

  return {
    client,
    elicitedUrls,
    completed,
    async close(): Promise<void> {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}
