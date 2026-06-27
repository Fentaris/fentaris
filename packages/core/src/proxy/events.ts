import type { ProxyContext, ProxyEventName, ProxyEventFilter, ProxyEventPayload } from "../types/proxy.js";
import type { ToolCallHookFilter } from "../types/middleware.js";
import type { ToolCallRequest } from "../types/mcp-operation.js";

export function operationEventName(
  operation: ProxyContext["operation"],
  phase: "start" | "success" | "error" | "after",
): ProxyEventName {
  if (operation === "resource:read") {
    return `resource:${phase}`;
  }

  if (operation === "prompt:get") {
    return `prompt:${phase}`;
  }

  if (operation === "completion:complete") {
    return `completion:${phase}`;
  }

  return `tool:${phase}`;
}

/**
 * Match a call hook filter against a request.
 * @pk
 */
export function matchesCallHook(filter: ToolCallHookFilter, request: ToolCallRequest): boolean {
  if (filter.server && filter.server !== request.serverName) {
    return false;
  }

  if (filter.tool && filter.tool !== request.toolName) {
    return false;
  }

  if (filter.proxyTool && filter.proxyTool !== request.proxyToolName) {
    return false;
  }

  return true;
}

export function matchesEventFilter(filter: ProxyEventFilter, context: ProxyContext): boolean {
  if (filter.server && filter.server !== context.server?.name) {
    return false;
  }

  if (filter.group && !context.subject?.hasGroup(filter.group)) {
    return false;
  }

  if (filter.tool && filter.tool !== context.tool?.name) {
    return false;
  }

  if (filter.proxyTool && filter.proxyTool !== context.tool?.proxyName) {
    return false;
  }

  return true;
}

import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyEventHandler } from "../types/proxy.js";
import type { ToolCallHook, MiddlewareContext } from "../types/middleware.js";

export type EventEntry = {
  eventName: ProxyEventName;
  filter: ProxyEventFilter;
  handler: ProxyEventHandler;
};

export async function dispatchCallHooks(
  hooks: Array<{ filter: ToolCallHookFilter; handler: ToolCallHook }>,
  request: ToolCallRequest,
  context: MiddlewareContext,
): Promise<CallToolResult | undefined> {
  for (const hook of hooks) {
    if (!matchesCallHook(hook.filter, request)) {
      continue;
    }

    const result = await hook.handler(request, context);
    if (result) {
      return result;
    }
  }
}

export async function emitProxyEvent(
  handlers: EventEntry[],
  eventName: ProxyEventName,
  payload: Parameters<ProxyEventHandler>[0],
): Promise<ListToolsResult["tools"] | ListToolsResult | void> {
  let transformedTools: ListToolsResult["tools"] | ListToolsResult | undefined = undefined;
  for (const entry of handlers) {
    if (entry.eventName !== eventName || !matchesEventFilter(entry.filter, payload.ctx)) {
      continue;
    }

    const eventPayload: ProxyEventPayload = {
      ...payload,
      tools: transformedTools
        ? Array.isArray(transformedTools)
          ? transformedTools
          : transformedTools.tools
        : payload.tools,
    };
    const result = await entry.handler(eventPayload);

    if (result) {
      transformedTools = result;
    }
  }
  return transformedTools;
}
