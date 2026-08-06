/**
 * Protected local operator channel for Edge approval and administrative
 * commands. Public Edge routes never expose these operations.
 * @pk
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { edgeError } from "./errors.js";
import type { EdgeDeviceApprovalDecision } from "./integratedConfig.js";
import type {
  EdgeApprovalService,
  EdgeAuthorizationSession,
  EdgeLocalOperatorChannel,
} from "./integratedServices.js";

export type EdgeLocalOperatorCommand = "approve" | "deny" | "status";

export type EdgeLocalOperatorRequest =
  | {
      readonly credential: string;
      readonly command: "approve";
      readonly userCode: string;
      readonly decision: EdgeDeviceApprovalDecision;
    }
  | {
      readonly credential: string;
      readonly command: "deny";
      readonly userCode: string;
      readonly decision: Omit<EdgeDeviceApprovalDecision, "subjectId"> & { readonly subjectId?: string };
    }
  | {
      readonly credential: string;
      readonly command: "status";
    };

export type EdgeLocalOperatorResponse = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
};

export type EdgeLocalOperatorEndpoint = {
  readonly address: string;
  readonly credential: string;
};

export type EdgeLocalOperatorServerOptions = {
  readonly endpoint: EdgeLocalOperatorEndpoint;
  readonly approval: EdgeApprovalService;
  readonly status: () => Promise<{
    readonly mode: "local";
    readonly multiInstance: false;
    readonly pendingApprovals: number;
    readonly enrolledDevices: number;
  }>;
  readonly maxRequestBytes?: number;
};

/** Create a Unix-socket endpoint path and random credential under a state directory. @pk */
export function createEdgeLocalOperatorEndpoint(stateDirectory: string): EdgeLocalOperatorEndpoint {
  return {
    address: path.join(stateDirectory, "operator.sock"),
    credential: randomBytes(32).toString("base64url"),
  };
}

/**
 * Owner-protected local operator channel used by `fentaris edge approve`.
 * It never mutates authority files directly from the CLI process.
 * @pk
 */
export class EdgeLocalOperatorServer implements EdgeLocalOperatorChannel {
  private server?: Server;

  constructor(private readonly options: EdgeLocalOperatorServerOptions) {}

  get endpoint(): EdgeLocalOperatorEndpoint {
    return this.options.endpoint;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw edgeError("EDGE_PROTOCOL", "Local Edge operator channel is already running.");
    }
    if (process.platform !== "win32") {
      await rm(this.options.endpoint.address, { force: true });
    }
    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.endpoint.address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      await chmod(this.options.endpoint.address, 0o600);
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
    if (process.platform !== "win32") {
      await rm(this.options.endpoint.address, { force: true });
    }
  }

  async approve(userCode: string, decision: EdgeDeviceApprovalDecision): Promise<EdgeAuthorizationSession> {
    return this.options.approval.approve(userCode, decision);
  }

  async deny(
    userCode: string,
    decision: Omit<EdgeDeviceApprovalDecision, "subjectId"> & { readonly subjectId?: string },
  ): Promise<EdgeAuthorizationSession> {
    if (!this.options.approval.deny) {
      throw edgeError("EDGE_PROTOCOL", "Local Edge approval denial is unavailable.");
    }
    return this.options.approval.deny(userCode, decision);
  }

  async status(): Promise<{
    readonly mode: "local";
    readonly multiInstance: false;
    readonly pendingApprovals: number;
    readonly enrolledDevices: number;
  }> {
    return this.options.status();
  }

  private handleSocket(socket: Socket): void {
    let bytes = 0;
    let body = "";
    const max = this.options.maxRequestBytes ?? 16_384;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > max) {
        this.respond(socket, {
          ok: false,
          error: { code: "payload_too_large", message: "Local operator request is too large." },
        });
        socket.destroy();
        return;
      }
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const frame = body.slice(0, newline);
      void this.handleFrame(socket, frame);
    });
  }

  private async handleFrame(socket: Socket, frame: string): Promise<void> {
    try {
      const request = JSON.parse(frame) as EdgeLocalOperatorRequest;
      if (!request || typeof request !== "object" || typeof request.credential !== "string") {
        this.respond(socket, { ok: false, error: { code: "invalid_request", message: "Malformed operator request." } });
        return;
      }
      if (!credentials.equal(request.credential, this.options.endpoint.credential)) {
        this.respond(socket, { ok: false, error: { code: "unauthorized", message: "Operator credential rejected." } });
        return;
      }
      if (request.command === "status") {
        this.respond(socket, { ok: true, data: await this.status() });
        return;
      }
      if (request.command === "approve") {
        this.respond(socket, {
          ok: true,
          data: await this.approve(request.userCode, request.decision),
        });
        return;
      }
      if (request.command === "deny") {
        this.respond(socket, {
          ok: true,
          data: await this.deny(request.userCode, request.decision),
        });
        return;
      }
      this.respond(socket, { ok: false, error: { code: "invalid_request", message: "Unknown operator command." } });
    } catch (error) {
      this.respond(socket, {
        ok: false,
        error: {
          code: "server_error",
          message: error instanceof Error ? error.message : "Operator request failed.",
        },
      });
    }
  }

  private respond(socket: Socket, response: EdgeLocalOperatorResponse): void {
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

/** Client for the protected local operator channel. @pk */
export class EdgeLocalOperatorClient {
  constructor(private readonly endpoint: EdgeLocalOperatorEndpoint) {}

  async request(request: Omit<EdgeLocalOperatorRequest, "credential"> & { readonly credential?: string }): Promise<EdgeLocalOperatorResponse> {
    const payload: EdgeLocalOperatorRequest = {
      ...request,
      credential: request.credential ?? this.endpoint.credential,
    } as EdgeLocalOperatorRequest;
    return await new Promise<EdgeLocalOperatorResponse>((resolve, reject) => {
      const socket = createConnection(this.endpoint.address);
      let body = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });
      socket.on("data", (chunk: string) => {
        body += chunk;
        if (body.includes("\n")) {
          socket.end();
        }
      });
      socket.once("error", reject);
      socket.once("close", () => {
        try {
          resolve(JSON.parse(body.trim()) as EdgeLocalOperatorResponse);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

const credentials = {
  equal(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  },
};
