import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { Connection } from "./connection.js";
import { ClientError, toClientError } from "./errors.js";
import type { GlobalOptions } from "./framework.js";
import type { Runtime } from "./runtime.js";

export const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export type Session = {
  client: Client;
  options: RequestOptions;
  url: string;
  close(): Promise<void>;
};

/** Open one governed MCP session against the proxy; every operation runs through it. */
export async function openSession(runtime: Runtime, connection: Connection, global: GlobalOptions): Promise<Session> {
  const attempt = async () => {
    const client = new Client({ name: "frs", version: VERSION }, { capabilities: { elicitation: { url: {} } } });
    client.setRequestHandler(ElicitRequestSchema, (request) => handleElicitation(runtime, global, request.params));
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers() }, fetch: runtime.fetch });
    await client.connect(transport, { timeout: global.timeoutMs });
    return { client, transport };
  };
  let opened: Awaited<ReturnType<typeof attempt>>;
  try {
    opened = await attempt();
  } catch (error) {
    if (!isUnauthorized(error) || !connection.refresh) throw authError(error, connection);
    if (!await connection.refresh().catch((cause: unknown) => { throw authError(cause, connection); })) throw authError(error, connection);
    opened = await attempt().catch((cause: unknown) => { throw authError(cause, connection); });
  }
  const { client, transport } = opened;
  return {
    client,
    url: connection.url,
    options: { timeout: global.timeoutMs, resetTimeoutOnProgress: true },
    async close() {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

export async function withSession<T>(runtime: Runtime, connection: Connection, global: GlobalOptions, run: (session: Session) => Promise<T>): Promise<T> {
  const session = await openSession(runtime, connection, global);
  try {
    return await run(session);
  } catch (error) {
    throw toClientError(error, { url: connection.url });
  } finally {
    await session.close();
  }
}

async function handleElicitation(runtime: Runtime, global: GlobalOptions, params: ElicitRequest["params"]): Promise<ElicitResult> {
  if (params.mode !== "url") return { action: "decline" };
  runtime.error(`${params.message}\nOpen this URL to continue:\n  ${params.url}\n`);
  if (global.nonInteractive) return { action: "decline" };
  await runtime.openUrl(params.url);
  runtime.error("Waiting for the authorization to complete…\n");
  return { action: "accept" };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401;
}

function authError(error: unknown, connection: Connection): ClientError {
  if (error instanceof ClientError) return error.code === "AUTH_REQUIRED" ? new ClientError(error.code, error.message, error.details, [connection.loginAction()]) : error;
  if (!isUnauthorized(error)) return toClientError(error, { url: connection.url });
  if (connection.method === "api-key") return new ClientError("UNAUTHORIZED", "The proxy rejected the API key.", { url: connection.url }, connection.source === "environment" ? [] : [connection.loginAction()]);
  if (connection.method === "access-token") return new ClientError("UNAUTHORIZED", "The proxy rejected FENTARIS_ACCESS_TOKEN.", { url: connection.url });
  return new ClientError("AUTH_REQUIRED", connection.method === "none" ? "The proxy requires authentication." : "The proxy rejected the stored credentials.", { url: connection.url }, [connection.loginAction()]);
}
