import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logging/index.js";
import type { ToolCallRequest, ProxyOperationResult } from "./mcp-operation.js";
import type {
  ApprovalDecisionController,
  CredentialSourceMetadata,
  IdentityMetadata,
  MaybePromise,
  ResolvedSubject,
  UserContext,
} from "./shared.js";
import type { Policy, PolicyDecision, RateLimiter, Registry } from "./policy.js";
import type { ProxyPolicyContext } from "./proxy.js";

/**
 * Filter for proxy call hooks.
 * @pk
 */
export type ToolCallHookFilter = {
  server?: string;
  tool?: string;
  proxyTool?: string;
};

/**
 * Event names supported by the proxy hook system.
 * @pk
 */
export type ProxyHookEvent = "call";

/**
 * Lifecycle event names emitted by the proxy.
 * @pk
 */
export type LifecycleHookEvent = "sessionStart" | "sessionEnd" | "toolFailure";

/**
 * Lifecycle hook context.
 * @pk
 */
export type LifecycleHookContext = {
  user: UserContext;
  subject?: ResolvedSubject;
  identity?: IdentityMetadata;
  sessionId?: string;
  request?: ToolCallRequest;
  error?: Error;
  log: Logger;
};

/**
 * Hook invoked for proxy lifecycle events.
 * @pk
 */
export type LifecycleHook = (event: LifecycleHookEvent, context: LifecycleHookContext) => MaybePromise<void>;

/**
 * Hook invoked for matched tool calls.
 * @pk
 */
export type ToolCallHook = (
  request: ToolCallRequest,
  context: MiddlewareContext,
) => MaybePromise<void | CallToolResult>;

/**
 * Hook invoked after upstream tool discovery and before returning tools to the client.
 * @pk
 */
export type ListToolsHook = (
  tools: ListToolsResult["tools"],
  context: ListToolsContext,
) => MaybePromise<ListToolsResult["tools"] | ListToolsResult | void>;

/**
 * Context passed to list tool hooks.
 * @pk
 */
export type ListToolsContext = {
  user: UserContext;
  subject?: ResolvedSubject;
  identity?: IdentityMetadata;
  log: Logger;
  policy?: Policy;
  policyDecision?: PolicyDecision;
  credentialSources?: CredentialSourceMetadata[];
};

/**
 * Helper for returning allow/deny responses from middleware.
 * @pk
 */
export class ResponseController {
  private readonly agentMessages: string[] = [];
  private structuredError: { code: number; message: string } | null = null;
  private readonly errorHandlers: Array<(error: Error) => MaybePromise<void>> = [];

  /**
   * Deny a tool call with a message.
   * @pk
   */
  deny(message: string): CallToolResult {
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }

  /**
   * Return a structured MCP-style error without throwing.
   * @pk
   */
  fail(code: number, message: string): CallToolResult {
    this.structuredError = { code, message };
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      _meta: {
        error: { code, message },
      },
    };
  }

  /**
   * Allow middleware to continue without overriding the response.
   * @pk
   */
  continue(): undefined {
    return undefined;
  }

  /**
   * Add guidance for the calling agent to the eventual tool response.
   * @pk
   */
  injectToAgent(message: string): void {
    if (message.trim()) {
      this.agentMessages.push(message);
    }
  }

  /**
   * Register a response event handler.
   * @pk
   */
  on(event: "error", handler: (error: Error) => MaybePromise<void>): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Run registered error handlers.
   * @internal
   */
  async notifyError(error: Error): Promise<void> {
    for (const handler of this.errorHandlers) {
      await handler(error);
    }
  }

  /**
   * Apply queued agent guidance to a tool result.
   * @internal
   */
  applyInjections(result: CallToolResult): CallToolResult {
    const withError = this.structuredError
      ? {
          ...result,
          _meta: {
            ...result._meta,
            error: {
              ...(isRecord(result._meta?.error) ? result._meta.error : {}),
              ...this.structuredError,
            },
          },
        }
      : result;

    if (this.agentMessages.length === 0) {
      return withError;
    }

    return {
      ...withError,
      content: [
        ...withError.content,
        ...this.agentMessages.map((text) => ({
          type: "text" as const,
          text,
        })),
      ],
    };
  }

  /**
   * Return queued agent guidance as an error result.
   * @internal
   */
  injectedErrorResult(): CallToolResult | undefined {
    if (this.agentMessages.length === 0) {
      return undefined;
    }

    return {
      content: this.agentMessages.map((text) => ({
        type: "text" as const,
        text,
      })),
      isError: true,
    };
  }
}

/**
 * Middleware execution context.
 * @pk
 */
export type MiddlewareContext = {
  user: UserContext;
  subject?: ResolvedSubject;
  identity?: IdentityMetadata;
  approval: ApprovalDecisionController;
  log: Logger;
  res: ResponseController;
  policy?: Policy | ProxyPolicyContext;
  policyDecision?: PolicyDecision;
  registry?: Registry;
  rateLimiter?: RateLimiter;
  credentialSources?: CredentialSourceMetadata[];
};

/**
 * Next middleware handler.
 * @pk
 */
export type Next = () => Promise<CallToolResult>;

/**
 * Next handler for unified proxy middleware.
 * @pk
 */
export type ProxyNext = () => Promise<ProxyOperationResult>;

/**
 * Legacy middleware function signature.
 * @pk
 */
export type LegacyMiddleware = (
  request: ToolCallRequest,
  context: MiddlewareContext,
  next: Next,
) => MaybePromise<CallToolResult | void>;

/**
 * Express-like middleware function signature.
 * @pk
 */
export type ProxyMiddleware = (
  context: import("./proxy.js").ProxyContext,
  next: ProxyNext,
) => MaybePromise<ProxyOperationResult | void>;

/**
 * Middleware function signature.
 * @pk
 */
export type Middleware = LegacyMiddleware | ProxyMiddleware;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
