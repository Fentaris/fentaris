import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyRuntime } from "../../src/types.js";

const fakes = vi.hoisted(() => {
  type RequestHandler = (req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, res: FakeResponse) => void | Promise<void>;

  class FakeServer {
    listenPort?: number;
    listenHost?: string;

    constructor(readonly handler: RequestHandler) {}

    listen(port: number, host: string, callback: () => void): void {
      this.listenPort = port;
      this.listenHost = host;
      callback();
    }

    address(): { address: string; port: number } {
      return { address: this.listenHost ?? "", port: this.listenPort ?? 0 };
    }

    close(callback: (error?: Error) => void): void {
      callback();
    }
  }

  class FakeResponse {
    headersSent = false;
    status = 0;
    headers: Record<string, string> = {};
    body = "";

    writeHead(status: number, headers: Record<string, string> = {}): void {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    }

    end(body = ""): void {
      this.body = body;
      this.headersSent = true;
    }
  }

  const httpServers: FakeServer[] = [];
  const streamableTransports: FakeStreamableServerTransport[] = [];
  const sseTransports: FakeSseServerTransport[] = [];
  const stdioTransports: FakeStdioServerTransport[] = [];
  let nextSessionId = 1;

  class FakeStreamableServerTransport {
    onclose?: () => void;
    sessionId?: string;

    constructor(readonly options: { onsessioninitialized?: (sessionId: string) => void }) {
      streamableTransports.push(this);
    }

    async handleRequest(req: { headers: Record<string, string | string[] | undefined> }, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }): Promise<void> {
      const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      if (!sessionId) {
        this.sessionId = `http-session-${nextSessionId++}`;
        this.options.onsessioninitialized?.(this.sessionId);
        res.writeHead(200, { "mcp-session-id": this.sessionId });
        res.end("initialized");
        return;
      }

      res.writeHead(200);
      res.end("continued");
    }

    async close(): Promise<void> {
      this.onclose?.();
    }
  }

  class FakeSseServerTransport {
    onclose?: () => void;
    readonly sessionId = `sse-session-${nextSessionId++}`;

    constructor(
      readonly messagePath: string,
      readonly res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void },
    ) {
      sseTransports.push(this);
    }

    async start(): Promise<void> {
      this.res.writeHead(200, { "content-type": "text/event-stream" });
      this.res.end("started");
    }

    async handlePostMessage(_req: unknown, res: { writeHead(status: number): void; end(body?: string): void }): Promise<void> {
      res.writeHead(200);
      res.end("posted");
    }

    async close(): Promise<void> {
      this.onclose?.();
    }
  }

  class FakeStdioServerTransport {
    readonly close = vi.fn(async () => undefined);

    constructor() {
      stdioTransports.push(this);
    }
  }

  return {
    FakeResponse,
    createServer: (handler: RequestHandler) => {
      const server = new FakeServer(handler);
      httpServers.push(server);
      return server;
    },
    FakeStreamableServerTransport,
    FakeSseServerTransport,
    FakeStdioServerTransport,
    httpServers,
    streamableTransports,
    sseTransports,
    stdioTransports,
  };
});

vi.mock("node:http", () => ({
  createServer: fakes.createServer,
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: fakes.FakeStreamableServerTransport,
}));

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: fakes.FakeSseServerTransport,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: fakes.FakeStdioServerTransport,
}));

import { HttpProxyExposureTransport } from "../../src/transports/exposure/HttpProxyExposureTransport.js";
import { SseProxyExposureTransport } from "../../src/transports/exposure/SseProxyExposureTransport.js";
import { StdioProxyExposureTransport } from "../../src/transports/exposure/StdioProxyExposureTransport.js";

describe("proxy exposure transports", () => {
  beforeEach(() => {
    fakes.httpServers.length = 0;
    fakes.streamableTransports.length = 0;
    fakes.sseTransports.length = 0;
    fakes.stdioTransports.length = 0;
  });

  it("binds HTTP sessions to the authenticated identity and defaults to localhost", async () => {
    const runtime = createRuntime({ identityRequired: true });
    const handle = await new HttpProxyExposureTransport({ port: 0 }).listen(runtime);
    const server = fakes.httpServers[0];

    expect(server?.address().address).toBe("127.0.0.1");

    const initialized = await request(server, {
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer alice" },
    });
    const sessionId = initialized.headers["mcp-session-id"];
    expect(sessionId).toBe("http-session-1");

    const unauthenticated = await request(server, {
      method: "POST",
      url: "/mcp",
      headers: { "mcp-session-id": sessionId ?? "" },
    });
    expect(unauthenticated.status).toBe(401);

    const mismatched = await request(server, {
      method: "POST",
      url: "/mcp",
      headers: { "mcp-session-id": sessionId ?? "", authorization: "Bearer bob" },
    });
    expect(mismatched.status).toBe(401);

    const matched = await request(server, {
      method: "POST",
      url: "/mcp",
      headers: { "mcp-session-id": sessionId ?? "", authorization: "Bearer alice" },
    });
    expect(matched.status).toBe(200);

    await handle.close();
  });

  it("requires authenticated SSE /messages requests for the bound session", async () => {
    const runtime = createRuntime({ identityRequired: true });
    const handle = await new SseProxyExposureTransport({ port: 0 }).listen(runtime);
    const server = fakes.httpServers[0];

    expect(server?.address().address).toBe("127.0.0.1");

    await request(server, {
      method: "GET",
      url: "/sse",
      headers: { authorization: "Bearer alice" },
    });
    const sessionId = fakes.sseTransports[0]?.sessionId;

    const unauthenticated = await request(server, {
      method: "POST",
      url: `/messages?sessionId=${sessionId}`,
      headers: {},
    });
    expect(unauthenticated.status).toBe(401);

    const mismatched = await request(server, {
      method: "POST",
      url: `/messages?sessionId=${sessionId}`,
      headers: { authorization: "Bearer bob" },
    });
    expect(mismatched.status).toBe(401);

    const matched = await request(server, {
      method: "POST",
      url: `/messages?sessionId=${sessionId}`,
      headers: { authorization: "Bearer alice" },
    });
    expect(matched.status).toBe(200);

    await handle.close();
  });

  it("fails stdio startup when identity is required but no identity is authenticated", async () => {
    const runtime = createRuntime({ identityRequired: true });

    await expect(new StdioProxyExposureTransport().listen(runtime)).rejects.toThrow(/requires an authenticated identity/);
    expect(fakes.stdioTransports).toHaveLength(0);
  });
});

async function request(
  server: { handler: (req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, res: InstanceType<typeof fakes.FakeResponse>) => void | Promise<void> } | undefined,
  req: { method: string; url: string; headers: Record<string, string | string[] | undefined> },
): Promise<InstanceType<typeof fakes.FakeResponse>> {
  if (!server) {
    throw new Error("No fake HTTP server was created");
  }

  const res = new fakes.FakeResponse();
  await server.handler(req, res);
  return res;
}

function createRuntime(options: { identityRequired: boolean }): ProxyRuntime {
  return {
    identityRequired: options.identityRequired,
    createSdkServer: () => ({
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }),
    resolveHttpUser: async (request: { headers?: Record<string, string | string[] | undefined> }) => {
      const authorization = request.headers?.authorization;
      if (authorization === "Bearer alice" || authorization === "Bearer bob") {
        const id = authorization.slice("Bearer ".length);
        return {
          user: { id },
          identity: { authenticated: true, strategy: "bearer", userId: id },
          subject: { id, groups: [], hasGroup: () => false },
        };
      }
      return { user: {}, identity: { authenticated: false, strategy: "bearer" } };
    },
    resolveStdioUser: async () => ({ user: {}, identity: { authenticated: false } }),
    emitSessionStart: vi.fn(async () => undefined),
    emitSessionEnd: vi.fn(async () => undefined),
    emitRuntimeEvent: vi.fn(async () => undefined),
    logger: {
      child: () => createLogger(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as ProxyRuntime;
}

function createLogger() {
  return {
    child: () => createLogger(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}
