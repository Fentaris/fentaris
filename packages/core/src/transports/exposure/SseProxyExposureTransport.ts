import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { FentarisErrorCode } from "../../errors.js";
import { FentarisTransportError, createRuntimeEvent, runtimeErrorToEventPayload } from "../../profiler/index.js";
import type { ProxyExposureHandle, ProxyExposureTransport, ProxyRuntime } from "../../types/proxy.js";
import type {
  IdentityMetadata,
  ResolvedSubject,
  UserContext,
} from "../../types/shared.js";

/**
 * Options for SSE downstream proxy exposure.
 * @pk
 */
export type SseProxyExposureTransportOptions = {
  port?: number;
  host?: string;
  ssePath?: string;
  messagePath?: string;
  onStarted?: () => void;
};

/**
 * Active SSE proxy exposure handle.
 * @pk
 */
export type SseProxyExposureHandle = ProxyExposureHandle & {
  server: HttpServer;
};

type SseSessionState = {
  transport: SSEServerTransport;
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
 * SSE MCP downstream proxy exposure.
 * @pk
 */
export class SseProxyExposureTransport implements ProxyExposureTransport<SseProxyExposureHandle> {
  private readonly options: Required<Pick<SseProxyExposureTransportOptions, "port" | "host" | "ssePath" | "messagePath">> &
    Pick<SseProxyExposureTransportOptions, "onStarted">;

  /**
   * Create an SSE proxy exposure transport.
   * @pk
   */
  constructor(options: SseProxyExposureTransportOptions = {}) {
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? "127.0.0.1",
      ssePath: options.ssePath ?? "/sse",
      messagePath: options.messagePath ?? "/messages",
      onStarted: options.onStarted,
    };
  }

  async listen(runtime: ProxyRuntime): Promise<SseProxyExposureHandle> {
    const sessions = new Map<string, SseSessionState>();
    const server = createServer(async (req, res) => {
      try {
        const path = req.url?.split("?")[0];
        if (req.method === "GET" && path === this.options.ssePath) {
          const { user, identity, subject } = await runtime.resolveHttpUser(req);
          if (runtime.identityRequired && !identity?.authenticated) {
            sendJsonRpcError(res, 401, FentarisErrorCode.Unauthorized, "Unauthorized");
            return;
          }

          await this.startSseSession(req, res, runtime, sessions, user, identity, subject);
          return;
        }

        if (req.method === "POST" && path === this.options.messagePath) {
          const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId");
          const session = sessionId ? sessions.get(sessionId) : undefined;
          if (!session) {
            sendJsonRpcError(res, 404, -32001, "Session not found");
            return;
          }

          const { user, identity, subject } = await runtime.resolveHttpUser(req);
          if (runtime.identityRequired && !identity?.authenticated) {
            sendJsonRpcError(res, 401, FentarisErrorCode.Unauthorized, "Unauthorized");
            return;
          }

          if (!isBoundSessionRequest(session, user, identity, subject)) {
            sendJsonRpcError(res, 401, FentarisErrorCode.Unauthorized, "Unauthorized");
            return;
          }

          await session.transport.handlePostMessage(req, res);
          return;
        }

        sendText(res, 404, "Not Found");
      } catch (error) {
        runtime.logger.error("Error handling SSE MCP proxy request", { error: error instanceof Error ? error.message : String(error) });
        await runtime.emitRuntimeEvent(createRuntimeEvent({
          name: "transport.error",
          category: "errors",
          level: "error",
          transport: "sse",
          error: runtimeErrorToEventPayload(new FentarisTransportError("SSE MCP proxy request failed", {
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

  private async startSseSession(
    req: IncomingMessage,
    res: ServerResponse,
    runtime: ProxyRuntime,
    sessions: Map<string, SseSessionState>,
    user: UserContext,
    identity: IdentityMetadata | undefined,
    subject: ResolvedSubject | undefined,
  ): Promise<void> {
    const sdkServer = runtime.createSdkServer(user, identity, subject) as McpSdkServer;
    const transport = new SSEServerTransport(this.options.messagePath, res);

    sessions.set(transport.sessionId, { transport, server: sdkServer, user, identity, subject, binding: createSessionBinding(user, identity, subject) });
    transport.onclose = async () => {
      sessions.delete(transport.sessionId);
      await runtime.emitSessionEnd({
        user,
        identity,
        sessionId: transport.sessionId,
        log: runtime.logger.child({ userId: user.id, sessionId: transport.sessionId }),
      });
      await sdkServer.close();
    };

    await sdkServer.connect(transport);
    await runtime.emitSessionStart({
      user,
      identity,
      sessionId: transport.sessionId,
      log: runtime.logger.child({ userId: user.id, sessionId: transport.sessionId }),
    });
    await transport.start();
  }
}

function createSessionBinding(user: UserContext, identity: IdentityMetadata | undefined, subject: ResolvedSubject | undefined): SessionBinding {
  return {
    authenticated: Boolean(identity?.authenticated),
    strategy: identity?.strategy,
    userId: identity?.userId ?? subject?.id ?? user.id,
  };
}

function isBoundSessionRequest(
  session: SseSessionState,
  user: UserContext,
  identity: IdentityMetadata | undefined,
  subject: ResolvedSubject | undefined,
): boolean {
  const requestBinding = createSessionBinding(user, identity, subject);
  if (!session.binding.authenticated) {
    return true;
  }

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
