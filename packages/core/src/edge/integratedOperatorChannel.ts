/**
 * Protected local operator channel for Edge approval and administrative
 * commands. Public Edge routes never expose these operations.
 * @pk
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { edgeError, isEdgeError } from "./errors.js";
import type { EdgeDeviceApprovalDecision } from "./integratedConfig.js";
import type { EdgeInventoryListOptions, EdgeInventoryUpdate } from "./controlPlane.js";
import type { EdgeControlPlaneService, EdgeManagementContext } from "./management.js";
import type {
  EdgeApprovalService,
  EdgeAuthorizationSession,
  EdgeLocalOperatorChannel,
} from "./integratedServices.js";

export type EdgeLocalOperatorCommand =
  | "approve" | "deny" | "status"
  | "device-list" | "device-get" | "device-update" | "device-disconnect" | "device-revoke";

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
    }
  | {
      readonly credential: string;
      readonly command: "device-list";
      readonly context: EdgeManagementContext;
      readonly options?: EdgeInventoryListOptions;
    }
  | {
      readonly credential: string;
      readonly command: "device-get" | "device-disconnect" | "device-revoke";
      readonly context: EdgeManagementContext;
      readonly deviceName: string;
    }
  | {
      readonly credential: string;
      readonly command: "device-update";
      readonly context: EdgeManagementContext;
      readonly deviceName: string;
      readonly update: EdgeInventoryUpdate;
    };

export type EdgeLocalOperatorResponse = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
};

export type EdgeLocalOperatorClientRequest = EdgeLocalOperatorRequest extends infer Request
  ? Request extends { readonly credential: string }
    ? Omit<Request, "credential"> & { readonly credential?: string }
    : never
  : never;

export type EdgeLocalOperatorEndpoint = {
  readonly address: string;
  readonly credential: string;
  readonly descriptorPath?: string;
};

export type EdgeLocalOperatorServerOptions = {
  readonly endpoint: EdgeLocalOperatorEndpoint;
  readonly approval: EdgeApprovalService;
  readonly management?: EdgeControlPlaneService;
  readonly status: () => Promise<{
    readonly mode: "local";
    readonly multiInstance: false;
    readonly pendingApprovals: number;
    readonly enrolledDevices: number;
  }>;
  readonly maxRequestBytes?: number;
};

/** Create a short Unix-socket endpoint path and random credential. @pk */
export function createEdgeLocalOperatorEndpoint(stateDirectory: string): EdgeLocalOperatorEndpoint {
  const identity = createHash("sha256").update(path.resolve(stateDirectory)).digest("hex").slice(0, 12);
  return {
    address: path.join(tmpdir(), `fe-op-${identity}.sock`),
    credential: randomBytes(32).toString("base64url"),
    descriptorPath: path.join(stateDirectory, "operator.json"),
  };
}

/** Read the running owner-protected operator endpoint without opening authority state. @pk */
export async function readEdgeLocalOperatorEndpoint(stateDirectory: string): Promise<EdgeLocalOperatorEndpoint> {
  const descriptorPath = path.join(stateDirectory, "operator.json");
  const value = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>;
  if (typeof value.address !== "string" || typeof value.credential !== "string") {
    throw edgeError("EDGE_UNAVAILABLE", "Local Edge operator endpoint is malformed.");
  }
  return { address: value.address, credential: value.credential, descriptorPath };
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
    if (this.options.endpoint.descriptorPath) {
      await mkdir(path.dirname(this.options.endpoint.descriptorPath), { recursive: true, mode: 0o700 });
      await writeFile(this.options.endpoint.descriptorPath, `${JSON.stringify({
        address: this.options.endpoint.address,
        credential: this.options.endpoint.credential,
      })}\n`, { mode: 0o600 });
      if (process.platform !== "win32") await chmod(this.options.endpoint.descriptorPath, 0o600);
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
    if (this.options.endpoint.descriptorPath) {
      await rm(this.options.endpoint.descriptorPath, { force: true });
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
    let handling = false;
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
      if (newline === -1 || handling) {
        return;
      }
      const frame = body.slice(0, newline);
      body = body.slice(newline + 1);
      handling = true;
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
      if (
        request.command === "device-list"
        || request.command === "device-get"
        || request.command === "device-update"
        || request.command === "device-disconnect"
        || request.command === "device-revoke"
      ) {
        if (!this.options.management) {
          this.respond(socket, { ok: false, error: { code: "unavailable", message: "Local device management is unavailable." } });
          return;
        }
        if (!request.context || typeof request.context.tenantId !== "string" || !request.context.tenantId.trim()) {
          this.respond(socket, { ok: false, error: { code: "invalid_request", message: "Device management requires a tenant context." } });
          return;
        }
        const management = this.options.management;
        if (request.command === "device-list") {
          this.respond(socket, { ok: true, data: await management.list(request.context, request.options) });
          return;
        }
        if (typeof request.deviceName !== "string" || !request.deviceName.trim()) {
          this.respond(socket, { ok: false, error: { code: "invalid_request", message: "Device management requires a device name." } });
          return;
        }
        if (request.command === "device-get") {
          this.respond(socket, { ok: true, data: await management.get(request.context, request.deviceName) });
          return;
        }
        if (request.command === "device-update") {
          this.respond(socket, { ok: true, data: await management.update(request.context, request.deviceName, request.update) });
          return;
        }
        if (request.command === "device-disconnect") {
          this.respond(socket, { ok: true, data: await management.disconnect(request.context, request.deviceName) });
          return;
        }
        this.respond(socket, { ok: true, data: await management.revoke(request.context, request.deviceName) });
        return;
      }
      if (request.command === "approve") {
        if (
          typeof request.userCode !== "string"
          || !request.userCode.trim()
          || !request.decision
          || typeof request.decision.tenantId !== "string"
          || !request.decision.tenantId.trim()
          || typeof request.decision.subjectId !== "string"
          || !request.decision.subjectId.trim()
          || typeof request.decision.actorId !== "string"
          || !request.decision.actorId.trim()
          || typeof request.decision.approvedAt !== "number"
        ) {
          this.respond(socket, {
            ok: false,
            error: { code: "invalid_request", message: "Approve requires userCode and a complete decision." },
          });
          return;
        }
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
          code: isEdgeError(error) ? error.code : "server_error",
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

  async request(request: EdgeLocalOperatorClientRequest): Promise<EdgeLocalOperatorResponse> {
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
