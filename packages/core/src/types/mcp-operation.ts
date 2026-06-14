import type {
  CallToolRequest,
  CallToolResult,
  CompleteRequest,
  CompleteResult,
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

export type { ListToolsRequest, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Request/result aliases for MCP server resource operations.
 * @pk
 */
export type ListResourcesParams = ListResourcesRequest["params"];
export type ListResourcesResponse = ListResourcesResult;
export type ReadResourceParams = ReadResourceRequest["params"];
export type ReadResourceResponse = ReadResourceResult;
export type ListResourceTemplatesParams = ListResourceTemplatesRequest["params"];
export type ListResourceTemplatesResponse = ListResourceTemplatesResult;

/**
 * Request/result aliases for MCP server prompt operations.
 * @pk
 */
export type ListPromptsParams = ListPromptsRequest["params"];
export type ListPromptsResponse = ListPromptsResult;
export type GetPromptParams = GetPromptRequest["params"];
export type GetPromptResponse = GetPromptResult;

/**
 * Request/result aliases for MCP completion operations.
 * @pk
 */
export type CompleteParams = CompleteRequest["params"];
export type CompleteResponse = CompleteResult;

/**
 * Normalized tool call details for middleware.
 * @pk
 */
export type ToolCallRequest = {
  serverName: string;
  toolName: string;
  proxyToolName: string;
  arguments: CallToolRequest["params"]["arguments"];
  raw: CallToolRequest["params"];
};

/**
 * Normalized tool-call request passed to approval callbacks.
 * @pk
 */
export type ToolApprovalRequest = ToolCallRequest & {
  operation: "tool:call";
  target: string;
  targetKind: "tool";
};

/**
 * Operation names handled by the unified proxy context.
 * @pk
 */
export type ProxyOperation =
  | "tool:call"
  | "tools:list"
  | "resources:list"
  | "resource:read"
  | "resource-templates:list"
  | "prompts:list"
  | "prompt:get"
  | "completion:complete"
  | "session:start"
  | "session:end";

/**
 * Governed MCP operation names used by capability permissions.
 * @pk
 */
export type McpOperationName =
  | "tools:list"
  | "tool:call"
  | "resources:list"
  | "resource:read"
  | "resource-templates:list"
  | "prompts:list"
  | "prompt:get"
  | "completion:complete";

/**
 * Capability target selector kind for policy permissions.
 * @pk
 */
export type CapabilityTargetKind = "tool" | "resource" | "resourceTemplate" | "prompt" | "completion";

/**
 * Normalized request used for operation-based policy evaluation.
 * @pk
 */
export type CapabilityOperationRequest = {
  serverName: string;
  operation: McpOperationName;
  target?: string;
  targetKind?: CapabilityTargetKind;
  raw?: unknown;
};

/**
 * Result shapes returned by governed proxy operation handlers.
 * @pk
 */
export type ProxyOperationResult =
  | CallToolResult
  | CompleteResult
  | GetPromptResult
  | ListPromptsResult
  | ListResourcesResult
  | ListResourceTemplatesResult
  | ListToolsResult
  | ReadResourceResult;
