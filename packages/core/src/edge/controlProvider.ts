/** Governed local MCP provider for agent-native Edge discovery and orchestration. @pk */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyLocalHandle } from "../local/declarations.js";
import type { ProxyContext } from "../types/proxy.js";
import { edgeError, isEdgeError } from "./errors.js";
import type {
  EdgeInventoryQuery,
  EdgeInventoryService,
  EdgePublicDeviceView,
  EdgeSelectionRequest,
} from "./inventoryService.js";
import type { EdgeSessionSelectionService } from "./sessionSelection.js";

export const EDGE_CONTROL_NAMESPACE = "edge" as const;
export const EDGE_CONTROL_TOOL_NAMES = Object.freeze(["list", "get", "select", "call", "call_many"] as const);

export interface EdgeControlListResult {
  readonly devices: readonly EdgeControlDeviceSummary[];
  readonly nextCursor?: string;
  readonly warnings: readonly string[];
  readonly nextActions: readonly string[];
}

export interface EdgeControlDeviceSummary {
  readonly device: { readonly name: string; readonly inventoryVersion: number };
  readonly description?: string;
  readonly status: string;
  readonly heartbeatFresh: boolean;
  readonly tags?: readonly string[];
  readonly platform?: string;
  readonly executionFeatures?: readonly string[];
  readonly pools?: readonly string[];
  readonly readiness?: EdgePublicDeviceView["readiness"];
  readonly metadata?: {
    readonly user: readonly string[];
    readonly agent: readonly string[];
    readonly controlPlane: readonly string[];
  };
  readonly warnings: readonly string[];
}

export interface EdgeControlGetResult {
  readonly device: EdgeControlDeviceSummary;
  readonly nextActions: readonly string[];
}

export interface EdgeControlSelectResult {
  readonly target: string;
  readonly device: { readonly name: string; readonly inventoryVersion: number };
  readonly expiresAt: number;
  readonly explanation?: unknown;
  readonly nextActions: readonly string[];
}

export interface EdgeControlInvocationRequest {
  readonly context: ProxyContext;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface EdgeControlInvoker {
  call(request: EdgeControlInvocationRequest): Promise<CallToolResult>;
  callMany(request: EdgeControlInvocationRequest): Promise<CallToolResult>;
}

export interface EdgeControlProviderOptions {
  readonly inventory: EdgeInventoryService;
  readonly selections: EdgeSessionSelectionService;
  readonly invoker?: EdgeControlInvoker;
  readonly defaultTargetName?: string;
}

const stringArray = { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 80 } } as const;
const publicDeviceRefSchema: Tool["inputSchema"] = {
  type: "object",
  additionalProperties: false,
  required: ["name", "inventoryVersion"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    inventoryVersion: { type: "integer", minimum: 1 },
  },
};
const selectorSchema: Tool["inputSchema"] = {
  type: "object",
  additionalProperties: false,
  properties: {
    requires: {
      type: "object",
      additionalProperties: false,
      properties: {
        tags: stringArray,
        features: stringArray,
        platforms: stringArray,
        pool: { type: "string", minLength: 1, maxLength: 80 },
        deploymentId: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
    prefer: {
      type: "array", maxItems: 8, uniqueItems: true,
      items: { type: "string", enum: ["lowest-load", "highest-capacity", "user-default", "name"] },
    },
    strategy: { type: "string", enum: ["least-loaded", "highest-capacity", "name"] },
    userDefaultDeviceName: { type: "string", minLength: 1, maxLength: 80 },
    maxCandidates: { type: "integer", minimum: 1, maximum: 1000 },
  },
};

export const EDGE_CONTROL_TOOL_SCHEMAS = Object.freeze({
  list: {
    type: "object", additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 80 }, tags: stringArray, features: stringArray,
      platforms: stringArray, pool: { type: "string", maxLength: 80 },
      statuses: { type: "array", maxItems: 4, items: { type: "string", enum: ["online", "stale", "offline", "revoked"] } },
      deploymentId: { type: "string", maxLength: 120 },
      readiness: { type: "array", maxItems: 5, items: { type: "string", enum: ["ready", "setup-required", "blocked", "stale", "unavailable"] } },
      include: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["description", "tags", "observed", "pools", "readiness"] } },
      limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 2048 },
    },
  },
  get: {
    type: "object", additionalProperties: false, required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      include: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["description", "tags", "observed", "pools", "readiness"] } },
    },
  },
  select: {
    type: "object", additionalProperties: false,
    properties: {
      target: { type: "string", minLength: 1, maxLength: 63 },
      device: publicDeviceRefSchema,
      selector: selectorSchema,
      deploymentId: { type: "string", maxLength: 120 },
      ttlMs: { type: "integer", minimum: 1, maximum: 86400000 },
    },
    oneOf: [{ required: ["device"] }, { required: ["selector"] }],
  },
  call: {
    type: "object", additionalProperties: false, required: ["device", "tool", "arguments"],
    properties: {
      device: publicDeviceRefSchema,
      tool: { type: "string", minLength: 3, maxLength: 200 },
      arguments: { type: "object" },
      deadlineMs: { type: "integer", minimum: 1, maximum: 300000 },
    },
  },
  call_many: {
    type: "object", additionalProperties: false, required: ["tool", "arguments"],
    properties: {
      devices: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: publicDeviceRefSchema },
      selector: selectorSchema,
      tool: { type: "string", minLength: 3, maxLength: 200 }, arguments: { type: "object" },
      failurePolicy: { type: "string", enum: ["collect", "fail-fast"] },
      concurrency: { type: "integer", minimum: 1, maximum: 100 },
      deadlineMs: { type: "integer", minimum: 1, maximum: 300000 },
    },
    oneOf: [{ required: ["devices"] }, { required: ["selector"] }],
  },
} satisfies Record<(typeof EDGE_CONTROL_TOOL_NAMES)[number], Tool["inputSchema"]>);

/** Register the reserved provider through the normal local capability machinery. @pk */
export function registerEdgeControlProvider(handle: ProxyLocalHandle, options: EdgeControlProviderOptions): void {
  handle.tool("list", {
    title: "List eligible Edge devices",
    description: "List authorized Edge devices with bounded filters and cursor pagination.",
    inputSchema: EDGE_CONTROL_TOOL_SCHEMAS.list,
  }, (context, params) => guard(async () => result(await listDevices(context, params.arguments, options))));
  handle.tool("get", {
    title: "Inspect an Edge device",
    description: "Inspect one authorized Edge device by stable public name.",
    inputSchema: EDGE_CONTROL_TOOL_SCHEMAS.get,
  }, (context, params) => guard(async () => result(await getDevice(context, params.arguments, options))));
  handle.tool("select", {
    title: "Select an Edge device",
    description: "Select an eligible device for a logical target before the session target is pinned.",
    inputSchema: EDGE_CONTROL_TOOL_SCHEMAS.select,
  }, (context, params) => guard(async () => result(await selectDevice(context, params.arguments, options))));
  handle.tool("call", {
    title: "Call a tool on one Edge device",
    description: "Invoke one effective MCP tool in an isolated child context on one device.",
    inputSchema: EDGE_CONTROL_TOOL_SCHEMAS.call,
  }, (context, params) => guard(() => invoke("call", context, params.arguments, options)));
  handle.tool("call_many", {
    title: "Call a tool on many Edge devices",
    description: "Invoke one effective MCP tool over a bounded set of devices.",
    inputSchema: EDGE_CONTROL_TOOL_SCHEMAS.call_many,
  }, (context, params) => guard(() => invoke("callMany", context, params.arguments, options)));
}

async function listDevices(context: ProxyContext, raw: unknown, options: EdgeControlProviderOptions): Promise<EdgeControlListResult> {
  const args = object(raw);
  const include = new Set(array(args.include));
  const page = await options.inventory.list(inventoryContext(context), args as EdgeInventoryQuery);
  return Object.freeze({
    devices: Object.freeze(page.devices.map((device) => summarize(device, include))),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    warnings: page.warnings,
    nextActions: Object.freeze(page.nextCursor ? ["Call edge__list again with nextCursor as cursor."] : []),
  });
}

async function getDevice(context: ProxyContext, raw: unknown, options: EdgeControlProviderOptions): Promise<EdgeControlGetResult> {
  const args = object(raw);
  const include = new Set(array(args.include));
  const device = await options.inventory.get(inventoryContext(context), requiredString(args.name, "name"));
  return Object.freeze({ device: summarize(device, include), nextActions: Object.freeze([]) });
}

async function selectDevice(context: ProxyContext, raw: unknown, options: EdgeControlProviderOptions): Promise<EdgeControlSelectResult> {
  const args = object(raw);
  const identity = inventoryContext(context);
  const sessionId = context.transport.sessionId;
  if (!sessionId) throw edgeError("EDGE_PROTOCOL", "Edge selection requires a downstream session.");
  let device = isRecord(args.device) ? args.device as { name: string; inventoryVersion: number } : undefined;
  let explanation: unknown;
  if (!device && isRecord(args.selector)) {
    const selected = await options.inventory.select(identity, args.selector as EdgeSelectionRequest);
    device = selected.device.device;
    explanation = selected.explanation;
  }
  if (!device) throw edgeError("EDGE_PROTOCOL", "Exactly one device or selector is required.");
  const target = typeof args.target === "string" ? args.target : options.defaultTargetName ?? "edge";
  const selected = await options.selections.select({
    sessionId, subjectId: identity.subjectId, tenantId: identity.tenantId, targetName: target, device,
    ...(typeof args.deploymentId === "string" ? { deploymentId: args.deploymentId } : {}),
    ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}),
  });
  return Object.freeze({
    target,
    device: Object.freeze({ ...device }),
    expiresAt: selected.expiresAt,
    ...(explanation ? { explanation } : {}),
    nextActions: Object.freeze([`Call the effective tool normally; target ${target} will pin to this device.`]),
  });
}

async function invoke(
  method: "call" | "callMany",
  context: ProxyContext,
  raw: unknown,
  options: EdgeControlProviderOptions,
): Promise<CallToolResult> {
  if (!options.invoker) {
    throw edgeError("EDGE_UNAVAILABLE", "Explicit Edge orchestration is not configured.", {
      details: { nextActions: ["Configure the Edge Control invocation adapter."] },
    });
  }
  return options.invoker[method]({ context, arguments: object(raw) });
}

function summarize(device: EdgePublicDeviceView, include: ReadonlySet<unknown>): EdgeControlDeviceSummary {
  return Object.freeze({
    device: device.device,
    status: device.status,
    heartbeatFresh: device.heartbeatFresh,
    ...(include.has("description") && device.description ? { description: device.description } : {}),
    ...(include.has("tags") ? { tags: device.tags } : {}),
    ...(include.has("observed") ? { platform: device.platform, executionFeatures: device.executionFeatures } : {}),
    ...(include.has("pools") ? { pools: device.pools } : {}),
    ...(include.has("readiness") ? { readiness: device.readiness } : {}),
    ...(include.size > 0 ? { metadata: {
      user: Object.freeze(["description", "tags"].filter((field) => include.has(field))),
      agent: Object.freeze(["platform", "executionFeatures"].filter(() => include.has("observed"))),
      controlPlane: Object.freeze(["pools"].filter(() => include.has("pools"))),
    } } : {}),
    warnings: device.warnings,
  });
}

function inventoryContext(context: ProxyContext): { tenantId: string; subjectId: string; groups?: readonly string[] } {
  const tenantId = context.auth.metadata?.tenantId;
  const subjectId = context.subject?.id ?? context.user.id;
  if (typeof tenantId !== "string" || !subjectId) {
    throw edgeError("EDGE_UNAUTHORIZED_TARGET", "Authenticated tenant and subject are required for Edge inventory.");
  }
  return { tenantId, subjectId, groups: context.policy.matchedGroups };
}

function result(value: object): CallToolResult {
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (!isEdgeError(error)) throw error;
    const structured = Object.freeze({
      error: Object.freeze({ code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }),
    });
    return {
      isError: true,
      structuredContent: structured,
      content: [{ type: "text", text: JSON.stringify(structured) }],
    };
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw edgeError("EDGE_PROTOCOL", "Edge Control arguments must be an object.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw edgeError("EDGE_PROTOCOL", `Edge Control ${field} is required.`);
  return value;
}
