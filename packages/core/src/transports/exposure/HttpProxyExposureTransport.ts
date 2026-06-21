import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { FentarisErrorCode } from "../../errors.js";
import { FentarisTransportError, createRuntimeEvent, runtimeErrorToEventPayload } from "../../profiler/index.js";
import type { ProxyExposureHandle, ProxyExposureTransport, ProxyRuntime } from "../../types/proxy.js";
import type {
  IdentityMetadata,
  ResolvedSubject,
  UserContext,
} from "../../types/shared.js";

/**
 * Options for HTTP downstream proxy exposure.
 * @pk
 */
export type HttpProxyExposureTransportOptions = {
  port?: number;
  host?: string;
  path?: string;
  onStarted?: () => void;
};

/**
 * Active HTTP proxy exposure handle.
 * @pk
 */
export type HttpProxyExposureHandle = ProxyExposureHandle & {
  server: HttpServer;
};

type HttpSessionState = {
  transport: StreamableHTTPServerTransport;
  server: McpSdkServer;
  user: UserContext;
  identity?: IdentityMetadata;
  subject?: ResolvedSubject;
  binding: SessionBinding;
};

type SessionBinding = {
  authenticated: boolean;
  strategy?: string;
  userId?: string;
};

/**
 * HTTP Streamable MCP downstream proxy exposure.
 * @pk
 */
export class HttpProxyExposureTransport implements ProxyExposureTransport<HttpProxyExposureHandle> {
  private readonly options: Required<Pick<HttpProxyExposureTransportOptions, "port" | "host" | "path">> &
    Pick<HttpProxyExposureTransportOptions, "onStarted">;

  /**
   * Create an HTTP proxy exposure transport.
   * @pk
   */
  constructor(options: HttpProxyExposureTransportOptions = {}) {
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? "127.0.0.1",
      path: options.path ?? "/mcp",
      onStarted: options.onStarted,
    };
  }

  async listen(runtime: ProxyRuntime): Promise<HttpProxyExposureHandle> {
    const sessions = new Map<string, HttpSessionState>();
    const server = createServer(async (req, res) => {
      if (req.url?.split("?")[0] !== this.options.path) {
        sendText(res, 404, "Not Found");
        return;
      }

      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST, DELETE" });
        return;
      }

      try {
        const { user, identity, subject } = await runtime.resolveHttpUser(req);
        if (runtime.identityRequired && !identity?.authenticated) {
          sendJsonRpcError(res, 401, FentarisErrorCode.Unauthorized, "Unauthorized");
          return;
        }

        await handleMcpRequest(req, res, sessions, runtime, user, identity, subject);
      } catch (error) {
        runtime.logger.error("Error handling MCP proxy request", { error: safeErrorMessage(error) });
        await runtime.emitRuntimeEvent(createRuntimeEvent({
          name: "transport.error",
          category: "errors",
          level: "error",
          transport: "http",
          requestId: req.headers["x-request-id"] as string | undefined,
          error: runtimeErrorToEventPayload(new FentarisTransportError("HTTP MCP proxy request failed", {
            cause: error,
            context: {
              method: req.method,
              url: req.url,
            },
          })),
        }));
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(this.options.port, this.options.host, () => {
        this.options.onStarted?.();
        resolve();
      });
    });

    return {
      server,
      close: () =>
        new Promise<void>((resolve, reject) => {
          for (const session of sessions.values()) {
            void session.transport.close();
            void session.server.close();
          }
          sessions.clear();
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    };
  }
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, HttpSessionState>,
  runtime: ProxyRuntime,
  user: UserContext,
  identity: IdentityMetadata | undefined,
  subject: ResolvedSubject | undefined,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }

    if (!isBoundSessionRequest(session, user, identity, subject)) {
      sendJsonRpcError(res, 401, FentarisErrorCode.Unauthorized, "Unauthorized");
      return;
    }

    await session.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    sendJsonRpcError(res, 400, -32000, "A new MCP session must start with POST initialize");
    return;
  }

  const sdkServer = runtime.createSdkServer(user, identity, subject) as McpSdkServer;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, { transport, server: sdkServer, user, identity, subject, binding: createSessionBinding(user, identity, subject) });
      runtime.logger.debug("MCP proxy session initialized", { sessionId: newSessionId, userId: user.id });
      void runtime.emitSessionStart({
        user,
        identity,
        sessionId: newSessionId,
        log: runtime.logger.child({ userId: user.id, sessionId: newSessionId }),
      });
    },
  });

  transport.onclose = async () => {
    const initializedSessionId = transport.sessionId;
    if (initializedSessionId) {
      sessions.delete(initializedSessionId);
    }
    await runtime.emitSessionEnd({
      user,
      identity,
      sessionId: initializedSessionId,
      log: runtime.logger.child({ userId: user.id, sessionId: initializedSessionId }),
    });
    await sdkServer.close();
  };

  await sdkServer.connect(transport);
  await transport.handleRequest(req, res);
}

function createSessionBinding(user: UserContext, identity: IdentityMetadata | undefined, subject: ResolvedSubject | undefined): SessionBinding {
  return {
    authenticated: Boolean(identity?.authenticated),
    strategy: identity?.strategy,
    userId: identity?.userId ?? subject?.id ?? user.id,
  };
}

function isBoundSessionRequest(
  session: HttpSessionState,
  user: UserContext,
  identity: IdentityMetadata | undefined,
  subject: ResolvedSubject | undefined,
): boolean {
  if (!identity?.authenticated) {
    return false;
  }

  const requestBinding = createSessionBinding(user, identity, subject);
  if (!requestBinding.authenticated) {
    return false;
  }

  return Boolean(requestBinding.userId) && requestBinding.userId === session.binding.userId && requestBinding.strategy === session.binding.strategy;
}

function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.writeHead(httpStatus, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
