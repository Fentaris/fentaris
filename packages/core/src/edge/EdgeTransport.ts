import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  CallToolRequest,
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  EmptyResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListToolsRequest,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ProxyContext } from "../types/proxy.js";
import type { FentarisTransport } from "../types/transport.js";
import { EDGE_ERROR_CODES, edgeError } from "./errors.js";
import type { EdgeTelemetry } from "./observability.js";
import {
  EDGE_MCP_ENVELOPE_VERSION,
  isEdgeMcpInboundEnvelope,
  type EdgeMcpCancelEnvelope,
  type EdgeMcpInboundEnvelope,
  type EdgeMcpOperation,
  type EdgeMcpOutboundEnvelope,
  type EdgeMcpRequestEnvelope,
  type EdgeMcpRoute,
} from "./protocol.js";

/** Bidirectional channel used by {@link EdgeTransport}. @pk */
export interface EdgeTransportChannel {
  send(message: EdgeMcpOutboundEnvelope): Promise<void>;
  onMessage(handler: (message: unknown) => void): () => void;
}

/** Configuration for {@link EdgeTransport}. @pk */
export interface EdgeTransportOptions {
  channel: EdgeTransportChannel;
  defaultTimeoutMs?: number;
  requestId?: () => string;
  onLateResult?: (message: EdgeMcpInboundEnvelope) => void;
  telemetry?: EdgeTelemetry;
}

type PendingRequest = {
  readonly operation: EdgeMcpOperation;
  readonly route: EdgeMcpRoute;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
  readonly startedAt: number;
};

/**
 * Virtual MCP transport backed by a correlated edge channel.
 *
 * The selected route is supplied through the explicit proxy-context contract.
 * Requests enforce deadlines, propagate cancellation, reject mismatched or
 * malformed responses, and never allow a late result to satisfy another call.
 * @pk
 */
export class EdgeTransport implements FentarisTransport {
  private readonly channel: EdgeTransportChannel;
  private readonly defaultTimeoutMs: number;
  private readonly requestId: () => string;
  private readonly onLateResult?: (message: EdgeMcpInboundEnvelope) => void;
  private readonly telemetry?: EdgeTelemetry;
  private readonly context = new AsyncLocalStorage<ProxyContext>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(options: EdgeTransportOptions) {
    this.channel = options.channel;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
      throw new TypeError("EdgeTransport defaultTimeoutMs must be a positive number");
    }
    this.requestId = options.requestId ?? randomUUID;
    this.onLateResult = options.onLateResult;
    this.telemetry = options.telemetry;
    this.unsubscribe = this.channel.onMessage((message) => this.receive(message));
  }

  async withProxyContext<T>(context: ProxyContext, run: () => Promise<T>): Promise<T> {
    return this.context.run(context, run);
  }

  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    return this.request("tools/list", params);
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.request("tools/call", params);
  }

  async listResources(params?: ListResourcesRequest["params"]): Promise<ListResourcesResult> {
    return this.request("resources/list", params);
  }

  async readResource(params: ReadResourceRequest["params"]): Promise<ReadResourceResult> {
    return this.request("resources/read", params);
  }

  async listResourceTemplates(params?: ListResourceTemplatesRequest["params"]): Promise<ListResourceTemplatesResult> {
    return this.request("resources/templates/list", params);
  }

  async listPrompts(params?: ListPromptsRequest["params"]): Promise<ListPromptsResult> {
    return this.request("prompts/list", params);
  }

  async getPrompt(params: GetPromptRequest["params"]): Promise<GetPromptResult> {
    return this.request("prompts/get", params);
  }

  async complete(params: CompleteRequest["params"]): Promise<CompleteResult> {
    return this.request("completion/complete", params);
  }

  async ping(): Promise<EmptyResult> {
    return this.request("ping");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const [requestId, pending] of this.pending) {
      this.finish(requestId);
      void this.sendCancel(requestId, pending.route, "shutdown");
      pending.reject(edgeError("EDGE_UNAVAILABLE", "Edge transport closed while the request was in flight."));
    }
  }

  private async request<Result>(operation: EdgeMcpOperation, params?: unknown): Promise<Result> {
    if (this.closed) {
      throw edgeError("EDGE_UNAVAILABLE", "Edge transport is closed.");
    }
    const proxyContext = this.context.getStore();
    const execution = proxyContext?.execution;
    const sessionId = proxyContext?.transport.sessionId;
    if (!proxyContext || !execution || execution.kind !== "edge" || !sessionId) {
      throw edgeError("EDGE_PROTOCOL", "Edge transport requires a pinned edge execution context.");
    }
    const route: EdgeMcpRoute = {
      edgeNodeId: execution.edgeNodeId,
      connectionGeneration: execution.connectionGeneration,
      deploymentId: execution.deploymentId,
      downstreamSessionId: sessionId,
      subjectId: proxyContext.subject?.id ?? proxyContext.user.id,
      targetName: execution.targetName,
    };
    const requestId = this.requestId();
    const deadline = this.deadline(proxyContext);
    const envelope: EdgeMcpRequestEnvelope = {
      version: EDGE_MCP_ENVELOPE_VERSION,
      kind: "mcp.request",
      requestId,
      operation,
      route,
      deadline,
      ...(params === undefined ? {} : { params }),
      ...(proxyContext.requestId ?? proxyContext.transport.requestId
        ? { trace: { downstreamRequestId: proxyContext.requestId ?? proxyContext.transport.requestId! } }
        : {}),
    };

    return new Promise<Result>((resolve, reject) => {
      const timeoutMs = Math.max(0, deadline - Date.now());
      const startedAt = Date.now();
      this.emit("edge.request.started", envelope, { outcome: "started" });
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.finish(requestId);
        void this.sendCancel(requestId, route, "deadline");
        this.emit("edge.request.timeout", envelope, { durationMs: Date.now() - startedAt, outcome: "timeout" });
        reject(edgeError("EDGE_WORKLOAD", `Edge MCP ${operation} exceeded its deadline.`, {
          details: { operation, requestId },
        }));
      }, timeoutMs);
      const signal = proxyContext.transport.signal;
      const abort = signal
        ? () => {
            if (!this.pending.has(requestId)) return;
            this.finish(requestId);
            void this.sendCancel(requestId, route, "aborted");
            this.emit("edge.request.cancelled", envelope, { durationMs: Date.now() - startedAt, outcome: "cancelled" });
            reject(edgeError("EDGE_WORKLOAD", `Edge MCP ${operation} was cancelled.`, {
              details: { operation, requestId },
            }));
          }
        : undefined;
      if (signal?.aborted) {
        clearTimeout(timer);
        void this.sendCancel(requestId, route, "aborted");
        reject(edgeError("EDGE_WORKLOAD", `Edge MCP ${operation} was cancelled.`, {
          details: { operation, requestId },
        }));
        return;
      }
      signal?.addEventListener("abort", abort!, { once: true });
      this.pending.set(requestId, {
        operation,
        route,
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
        signal,
        abort,
        startedAt,
      });
      void this.channel.send(envelope).catch((cause) => {
        if (!this.pending.has(requestId)) return;
        this.finish(requestId);
        this.emit("edge.request.failed", envelope, { durationMs: Date.now() - startedAt, outcome: "unavailable" });
        reject(edgeError("EDGE_UNAVAILABLE", "Unable to send the edge MCP request.", {
          details: { operation, requestId },
          cause,
        }));
      });
    });
  }

  private receive(value: unknown): void {
    if (!isEdgeMcpInboundEnvelope(value)) {
      const requestId = requestIdFromUnknown(value);
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (requestId && pending) {
        this.finish(requestId);
        pending.reject(edgeError("EDGE_PROTOCOL", "Malformed edge MCP response.", {
          details: { requestId },
        }));
      }
      return;
    }
    const pending = this.pending.get(value.requestId);
    if (!pending) {
      this.onLateResult?.(value);
      return;
    }
    if (value.operation !== pending.operation || !sameRoute(value.route, pending.route)) {
      this.finish(value.requestId);
      this.emit("edge.request.failed", value, { durationMs: Date.now() - pending.startedAt, outcome: "protocol-error" });
      pending.reject(edgeError("EDGE_PROTOCOL", "Edge MCP response routing did not match its request.", {
        details: { requestId: value.requestId, operation: pending.operation },
      }));
      return;
    }
    this.finish(value.requestId);
    if (value.kind === "mcp.error") {
      const code = EDGE_ERROR_CODES.includes(value.error.code) ? value.error.code : "EDGE_PROTOCOL";
      pending.reject(edgeError(code, value.error.message, {
        details: value.error.details ? { ...value.error.details, requestId: value.requestId } : { requestId: value.requestId },
      }));
      this.emit("edge.request.failed", value, { durationMs: Date.now() - pending.startedAt, outcome: code });
      return;
    }
    if (!value.result || typeof value.result !== "object") {
      pending.reject(edgeError("EDGE_PROTOCOL", "Edge MCP result payload is malformed.", {
        details: { requestId: value.requestId, operation: value.operation },
      }));
      return;
    }
    pending.resolve(value.result);
    this.emit("edge.request.completed", value, { durationMs: Date.now() - pending.startedAt, outcome: "success" });
  }

  private finish(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    this.pending.delete(requestId);
  }

  private deadline(context: ProxyContext): number {
    const configured = context.transport.deadline;
    if (configured !== undefined && Number.isFinite(configured)) {
      return configured;
    }
    return Date.now() + this.defaultTimeoutMs;
  }

  private async sendCancel(
    requestId: string,
    route: EdgeMcpRoute,
    reason: EdgeMcpCancelEnvelope["reason"],
  ): Promise<void> {
    const message: EdgeMcpCancelEnvelope = {
      version: EDGE_MCP_ENVELOPE_VERSION,
      kind: "mcp.cancel",
      requestId,
      route,
      reason,
    };
    await this.channel.send(message).catch(() => undefined);
  }

  private emit(
    name: "edge.request.started" | "edge.request.completed" | "edge.request.timeout" | "edge.request.cancelled" | "edge.request.failed",
    request: Pick<EdgeMcpRequestEnvelope, "requestId" | "operation" | "route">,
    extra: { durationMs?: number; outcome?: string },
  ): void {
    void this.telemetry?.emit({
      name,
      durationMs: extra.durationMs,
      outcome: extra.outcome,
      subjectId: request.route.subjectId,
      targetName: request.route.targetName,
      deploymentId: request.route.deploymentId,
      edgeNodeId: request.route.edgeNodeId,
      connectionGeneration: request.route.connectionGeneration,
      downstreamSessionId: request.route.downstreamSessionId,
      requestId: request.requestId,
      metadata: { operation: request.operation },
    }).catch(() => undefined);
  }
}

function requestIdFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function sameRoute(left: EdgeMcpRoute, right: EdgeMcpRoute): boolean {
  return left.edgeNodeId === right.edgeNodeId
    && left.connectionGeneration === right.connectionGeneration
    && left.deploymentId === right.deploymentId
    && left.downstreamSessionId === right.downstreamSessionId
    && left.targetName === right.targetName;
}
