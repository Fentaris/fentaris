import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { edgeError } from "@fentaris/core";
import type { EdgePersistentAgent } from "./daemon.js";

export type EdgeLocalControlCommand = "status" | "reconnect" | "stop" | "setup-handoff"
  | "installation-status" | "installation-review" | "installation-approve" | "installation-deny"
  | "installation-retry" | "installation-revoke" | "installation-cleanup";

export interface EdgeLocalControlRequest {
  readonly credential: string;
  readonly command: EdgeLocalControlCommand;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface EdgeLocalControlResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface EdgeLocalControlEndpoint {
  readonly address: string;
  readonly credential: string;
}

export interface EdgeLocalControlServerOptions {
  readonly endpoint: EdgeLocalControlEndpoint;
  readonly agent: EdgePersistentAgent;
  readonly onSetupHandoff?: () => unknown | Promise<unknown>;
  readonly installation?: {
    status(parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
    review(parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
    approve(parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
    deny(parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
    retry(parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
    revoke(parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
    cleanup(parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  };
  readonly maxRequestBytes?: number;
}

/** Owner-protected local supervisor channel. It exposes no arbitrary execution. */
export class EdgeLocalControlServer {
  private server?: Server;

  constructor(private readonly options: EdgeLocalControlServerOptions) {}

  async start(): Promise<void> {
    if (this.server) throw edgeError("EDGE_WORKLOAD", "Edge local control server is already running.");
    if (process.platform !== "win32") await rm(this.options.endpoint.address, { force: true });
    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.endpoint.address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(this.options.endpoint.address, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (!error || isServerNotRunning(error)) resolve();
        else reject(error);
      }));
    }
    if (process.platform !== "win32") await rm(this.options.endpoint.address, { force: true });
  }

  private handleSocket(socket: Socket): void {
    let bytes = 0;
    let body = "";
    const max = this.options.maxRequestBytes ?? 16_384;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > max) {
        this.respond(socket, { ok: false, error: { code: "EDGE_CAPACITY", message: "Local control request is too large." } });
        socket.destroy();
        return;
      }
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      const frame = body.slice(0, newline);
      body = "";
      void this.handleFrame(frame).then((response) => this.respond(socket, response));
    });
  }

  private async handleFrame(frame: string): Promise<EdgeLocalControlResponse> {
    let request: EdgeLocalControlRequest;
    try {
      request = JSON.parse(frame) as EdgeLocalControlRequest;
    } catch {
      return { ok: false, error: { code: "EDGE_PROTOCOL", message: "Malformed local control request." } };
    }
    if (!validCredential(request.credential, this.options.endpoint.credential)) {
      return { ok: false, error: { code: "EDGE_UNAUTHORIZED_TARGET", message: "Local control authorization failed." } };
    }
    switch (request.command) {
      case "status":
        return { ok: true, data: await this.options.agent.status() };
      case "reconnect":
        await this.options.agent.reconnectNow();
        return { ok: true, data: { status: "reconnecting" } };
      case "stop":
        void this.options.agent.stop();
        return { ok: true, data: { status: "stopping" } };
      case "setup-handoff":
        return { ok: true, data: await this.options.onSetupHandoff?.() ?? { status: "unavailable" } };
      case "installation-status":
      case "installation-review":
      case "installation-approve":
      case "installation-deny":
      case "installation-retry":
      case "installation-revoke":
      case "installation-cleanup": {
        const installation = this.options.installation;
        if (!installation) return { ok: false, error: { code: "EDGE_SETUP_REQUIRED", message: "Managed installation control is unavailable." } };
        const operation = request.command.slice("installation-".length) as "status" | "review" | "approve" | "deny" | "retry" | "revoke" | "cleanup";
        return { ok: true, data: await installation[operation](request.parameters ?? {}) };
      }
      default:
        return { ok: false, error: { code: "EDGE_PROTOCOL", message: "Unsupported local control command." } };
    }
  }

  private respond(socket: Socket, response: EdgeLocalControlResponse): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }
}

/** Small client used by service-aware CLI commands. */
export async function callEdgeLocalControl(
  endpoint: EdgeLocalControlEndpoint,
  command: EdgeLocalControlCommand,
  parameters?: Readonly<Record<string, unknown>>,
): Promise<EdgeLocalControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.address);
    let body = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline !== -1) {
        socket.destroy();
        resolve(JSON.parse(body.slice(0, newline)) as EdgeLocalControlResponse);
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ credential: endpoint.credential, command, ...(parameters ? { parameters } : {}) })}\n`);
    });
  });
}

export function createEdgeLocalControlCredential(): string {
  return randomBytes(32).toString("base64url");
}

export function edgeLocalControlAddress(dataDirectory: string, platform: NodeJS.Platform = process.platform): string {
  const suffix = createHash("sha256").update(path.resolve(dataDirectory)).digest("hex").slice(0, 20);
  if (platform === "win32") {
    return `\\\\.\\pipe\\fentaris-edge-${suffix}`;
  }
  return path.join(tmpdir(), `fe-${suffix}.sock`);
}

function validCredential(actual: string, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isServerNotRunning(error: Error): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING";
}
