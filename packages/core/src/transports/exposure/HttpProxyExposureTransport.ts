import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
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
import { attachDownstreamSessionId, ensureIdentityWithMetadata } from "./downstreamSession.js";
import type { ProxyExposureHttpRoute, ProxyExposureUpgradeRoute } from "./routeRegistry.js";
import { exposurePathsConflict, normalizeExposurePath } from "./routeRegistry.js";

/**
 * Options for HTTP downstream proxy exposure.
 * @pk
 */
export type HttpProxyExposureTransportOptions = {
  port?: number;
  host?: string;
  path?: string;
  onStarted?: () => void;
  /** Additional owned HTTP routes co-located with the MCP endpoint. @pk */
  httpRoutes?: readonly ProxyExposureHttpRoute[];
  /** Additional WebSocket upgrade routes co-located with the MCP endpoint. @pk */
  upgradeRoutes?: readonly ProxyExposureUpgradeRoute[];
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
    Pick<HttpProxyExposureTransportOptions, "onStarted" | "httpRoutes" | "upgradeRoutes">;

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
      httpRoutes: options.httpRoutes ?? [],
      upgradeRoutes: options.upgradeRoutes ?? [],
    };
    this.assertNoRouteConflicts();
  }

  async listen(runtime: ProxyRuntime): Promise<HttpProxyExposureHandle> {
    const sessions = new Map<string, HttpSessionState>();
    const server = createServer(async (req, res) => {
      const pathname = normalizeExposurePath((req.url ?? "/").split("?")[0] ?? "/");
      const method = (req.method ?? "GET").toUpperCase();
      const extra = this.options.httpRoutes?.find(
        (route) => route.method === method && normalizeExposurePath(route.path) === pathname,
      );
      if (extra) {
        try {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
          await extra.handler(req, res, url);
        } catch (error) {
          runtime.logger.error("Error handling exposure route", { error: safeErrorMessage(error), path: pathname });
          if (!res.headersSent) {
            sendText(res, 500, "Internal server error");
          }
        }
        return;
      }

      if (pathname !== normalizeExposurePath(this.options.path)) {
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

    server.on?.("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = normalizeExposurePath((req.url ?? "/").split("?")[0] ?? "/");
      const upgrade = this.options.upgradeRoutes?.find(
        (route) => normalizeExposurePath(route.path) === pathname,
      );
      if (!upgrade) {
        socket.destroy();
        return;
      }
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
          await upgrade.handler(req, socket, head, url);
        } catch (error) {
          runtime.logger.error("Error handling exposure upgrade", { error: safeErrorMessage(error), path: pathname });
          socket.destroy();
        }
      })();
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

  private assertNoRouteConflicts(): void {
    const mcpPath = normalizeExposurePath(this.options.path);
    for (const route of this.options.httpRoutes ?? []) {
      if (exposurePathsConflict(route.path, mcpPath)) {
        throw new FentarisTransportError(`Exposure HTTP route "${route.path}" conflicts with MCP path "${mcpPath}"`);
      }
    }
    for (const route of this.options.upgradeRoutes ?? []) {
      if (exposurePathsConflict(route.path, mcpPath)) {
        throw new FentarisTransportError(`Exposure upgrade route "${route.path}" conflicts with MCP path "${mcpPath}"`);
      }
    }
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

  // Ensure a mutable identity so the downstream session id can be attached
  // once it is known and observed by the SDK-server handlers. @pk
  const sessionIdentity = ensureIdentityWithMetadata(identity);
  const sdkServer = runtime.createSdkServer(user, sessionIdentity, subject) as McpSdkServer;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      attachDownstreamSessionId(sessionIdentity, newSessionId);
      sessions.set(newSessionId, { transport, server: sdkServer, user, identity: sessionIdentity, subject, binding: createSessionBinding(user, identity, subject) });
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
  const requestBinding = createSessionBinding(user, identity, subject);
  if (session.binding.authenticated) {
    return (
      requestBinding.authenticated &&
      Boolean(requestBinding.userId) &&
      requestBinding.userId === session.binding.userId &&
      requestBinding.strategy === session.binding.strategy
    );
  }

  return (
    !requestBinding.authenticated &&
    requestBinding.userId === session.binding.userId &&
    requestBinding.strategy === session.binding.strategy
  );
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
