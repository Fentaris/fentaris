/** Explicit single-device Edge invocation coordinator. @pk */

import { randomUUID } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { IdentityMetadata, UserContext } from "../types/shared.js";
import type { ProxyContext } from "../types/proxy.js";
import { fromProxyToolName } from "../nameMapping.js";
import { edgeError } from "./errors.js";
import type { EdgeChildBindingManager } from "./sessionSelection.js";
import type { EdgeInventoryService } from "./inventoryService.js";
import type { EdgePublicDeviceRef } from "./inventory.js";

export interface EdgeTrustedChildRoute {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly childBindingId: string;
  readonly childRequestId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly targetName: string;
  readonly edgeNodeId: string;
  readonly connectionGeneration: number;
  readonly deploymentId: string;
  readonly deadline?: number;
  readonly signal: AbortSignal;
}

export interface EdgeSingleCallCoordinatorOptions {
  readonly inventory: EdgeInventoryService;
  readonly children: EdgeChildBindingManager;
  readonly listTools: (
    user: UserContext,
    identity: IdentityMetadata | undefined,
    subject: ProxyContext["subject"],
  ) => Promise<readonly Tool[]>;
  readonly dispatch: (
    route: EdgeTrustedChildRoute,
    toolName: string,
    args: Record<string, unknown>,
    context: ProxyContext,
  ) => Promise<CallToolResult>;
  readonly createId?: () => string;
  readonly now?: () => number;
  readonly defaultDeadlineMs?: number;
  readonly maxDeadlineMs?: number;
}

export interface EdgeSingleCallStructuredResult {
  readonly status: "succeeded" | "failed";
  readonly device: EdgePublicDeviceRef;
  readonly correlationId: string;
  readonly result: CallToolResult;
  readonly warnings: readonly string[];
  readonly nextActions: readonly string[];
}

/** Resolve, validate, isolate, dispatch, and clean up one explicit Edge call. @pk */
export class EdgeSingleCallCoordinator {
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly defaultDeadlineMs: number;
  private readonly maxDeadlineMs: number;

  constructor(private readonly options: EdgeSingleCallCoordinatorOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000;
    this.maxDeadlineMs = options.maxDeadlineMs ?? 300_000;
  }

  async call(context: ProxyContext, raw: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    const parentSessionId = context.transport.sessionId;
    const tenantId = metadataString(context, "tenantId");
    const subjectId = context.subject?.id ?? context.user.id;
    if (!parentSessionId || !tenantId || !subjectId) {
      throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Explicit Edge calls require an authenticated tenant session.");
    }
    const toolName = requiredString(raw.tool, "tool");
    if (toolName.startsWith("edge__")) {
      throw edgeError("EDGE_PROTOCOL", "Edge Control tools cannot invoke Edge Control recursively.", {
        details: { nextActions: ["Choose a non-edge effective MCP tool."] },
      });
    }
    const device = publicDeviceRef(raw.device);
    const args = record(raw.arguments, "arguments");
    const visibleTools = await this.options.listTools(context.user, context.identity, context.subject);
    const effective = visibleTools.find((tool) => tool.name === toolName);
    if (!effective) {
      throw edgeError("EDGE_UNAUTHORIZED_TARGET", "The requested effective tool is unavailable for this subject.");
    }
    const issues = validateJsonSchema(effective.inputSchema, args);
    if (issues.length > 0) {
      throw edgeError("EDGE_INPUT_INVALID", "Tool arguments do not satisfy the current effective input schema.", {
        details: {
          issues: issues.slice(0, 20),
          nextActions: ["Call tools/list and inspect this effective tool's inputSchema before retrying."],
        },
      });
    }
    const { serverName: deploymentId } = fromProxyToolName(toolName);
    if (deploymentId === "edge") {
      throw edgeError("EDGE_PROTOCOL", "Edge Control recursion is not allowed.");
    }
    const resolved = await this.options.inventory.revalidateForDispatch({ tenantId, subjectId }, device, deploymentId);
    const correlationId = this.createId();
    const deadlineMs = Math.max(1, Math.min(this.maxDeadlineMs,
      typeof raw.deadlineMs === "number" ? raw.deadlineMs : this.defaultDeadlineMs));
    const deadline = Math.min(
      this.now() + deadlineMs,
      context.transport.deadline ?? Number.POSITIVE_INFINITY,
    );
    const allocated = await this.options.children.allocate({
      parentSessionId,
      parentRequestId: context.requestId ?? context.transport.requestId ?? correlationId,
      childRequestId: correlationId,
      tenantId,
      subjectId,
      targetName: "edge-control",
      edgeNodeId: resolved.edgeNodeId,
      connectionGeneration: resolved.connectionGeneration,
      ttlMs: Math.max(1, deadline - this.now()),
    });
    const route: EdgeTrustedChildRoute = Object.freeze({
      parentSessionId,
      childSessionId: `${parentSessionId}:edge:${allocated.binding.childBindingId}`,
      childBindingId: allocated.binding.childBindingId,
      childRequestId: correlationId,
      tenantId,
      subjectId,
      targetName: "edge-control",
      edgeNodeId: resolved.edgeNodeId,
      connectionGeneration: resolved.connectionGeneration,
      deploymentId,
      deadline,
      signal: linkedSignal(context.transport.signal, allocated.signal),
    });
    try {
      const childResult = sanitizeToolResult(await this.options.dispatch(route, toolName, args, context));
      const structured: EdgeSingleCallStructuredResult = Object.freeze({
        status: childResult.isError ? "failed" : "succeeded",
        device,
        correlationId,
        result: childResult,
        warnings: Object.freeze([]),
        nextActions: Object.freeze([]),
      });
      await this.options.children.finish(allocated.binding.childBindingId, childResult.isError ? "failed" : "succeeded");
      return { content: childResult.content, structuredContent: structured as unknown as Record<string, unknown>, ...(childResult.isError ? { isError: true } : {}) };
    } catch (error) {
      await this.options.children.finish(allocated.binding.childBindingId, "failed");
      throw error;
    }
  }
}

function sanitizeToolResult(value: CallToolResult): CallToolResult {
  if (!value || typeof value !== "object" || !Array.isArray(value.content)) {
    throw edgeError("EDGE_PROTOCOL", "Edge tool returned a malformed MCP result.");
  }
  return {
    content: [...value.content],
    ...(value.structuredContent && typeof value.structuredContent === "object"
      ? { structuredContent: { ...value.structuredContent } }
      : {}),
    ...(value.isError ? { isError: true } : {}),
  };
}

function validateJsonSchema(schema: Tool["inputSchema"], value: unknown, path = "$", depth = 0): string[] {
  if (depth > 32 || !schema || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((branch) => validateJsonSchema(branch as Tool["inputSchema"], value, path, depth + 1).length === 0);
    if (matches.length !== 1) return [`${path} must match exactly one allowed schema`];
  }
  if (Array.isArray(node.anyOf) && !node.anyOf.some((branch) => validateJsonSchema(branch as Tool["inputSchema"], value, path, depth + 1).length === 0)) {
    return [`${path} must match an allowed schema`];
  }
  if (Array.isArray(node.enum) && !node.enum.some((candidate) => Object.is(candidate, value))) return [`${path} is not an allowed value`];
  const type = node.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    const object = value as Record<string, unknown>;
    const required = Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === "string") : [];
    const issues = required.filter((key) => !(key in object)).map((key) => `${path}.${key} is required`);
    const properties = node.properties && typeof node.properties === "object" ? node.properties as Record<string, Tool["inputSchema"]> : {};
    for (const [key, child] of Object.entries(object)) {
      if (properties[key]) issues.push(...validateJsonSchema(properties[key], child, `${path}.${key}`, depth + 1));
      else if (node.additionalProperties === false) issues.push(`${path}.${key} is not allowed`);
    }
    return issues;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    const issues: string[] = [];
    if (typeof node.minItems === "number" && value.length < node.minItems) issues.push(`${path} has too few items`);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) issues.push(`${path} has too many items`);
    if (node.items && typeof node.items === "object") value.forEach((item, index) => issues.push(...validateJsonSchema(node.items as Tool["inputSchema"], item, `${path}[${index}]`, depth + 1)));
    return issues;
  }
  if (type === "string" && typeof value !== "string") return [`${path} must be a string`];
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return [`${path} must be a number`];
  if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return [`${path} must be an integer`];
  if (type === "boolean" && typeof value !== "boolean") return [`${path} must be a boolean`];
  return [];
}

function linkedSignal(parent: AbortSignal | undefined, child: AbortSignal): AbortSignal {
  if (!parent) return child;
  if (parent.aborted || child.aborted) return AbortSignal.abort();
  return AbortSignal.any([parent, child]);
}

function metadataString(context: ProxyContext, key: string): string | undefined {
  const value = context.auth.metadata?.[key] ?? context.subject?.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw edgeError("EDGE_PROTOCOL", `${field} must be a non-empty string.`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw edgeError("EDGE_PROTOCOL", `${field} must be an object.`);
  return value as Record<string, unknown>;
}

function publicDeviceRef(value: unknown): EdgePublicDeviceRef {
  const input = record(value, "device");
  if (typeof input.name !== "string" || !input.name || typeof input.inventoryVersion !== "number" || !Number.isInteger(input.inventoryVersion)) {
    throw edgeError("EDGE_PROTOCOL", "device must contain a public name and integer inventoryVersion.");
  }
  return Object.freeze({ name: input.name, inventoryVersion: input.inventoryVersion });
}
