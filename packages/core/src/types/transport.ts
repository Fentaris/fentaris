import type { CallToolRequest, CallToolResult, ListToolsRequest, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CompleteParams,
  CompleteResponse,
  GetPromptParams,
  GetPromptResponse,
  ListPromptsParams,
  ListPromptsResponse,
  ListResourcesParams,
  ListResourcesResponse,
  ListResourceTemplatesParams,
  ListResourceTemplatesResponse,
  ReadResourceParams,
  ReadResourceResponse,
} from "./mcp-operation.js";
import type { ProxyContext } from "./proxy.js";

/**
 * Transport interface for MCP client interactions.
 * @pk
 */
export type FentarisTransport = {
  /**
   * Run an MCP operation with the governed proxy context that authorized it.
   *
   * Context-aware transports (including edge dispatch) use this explicit
   * contract to observe the authenticated subject, downstream session, policy
   * decision, and selected capability without changing operation signatures.
   * Transports that do not need proxy context may omit it.
   * @pk
   */
  withProxyContext?<T>(context: ProxyContext, run: () => Promise<T>): Promise<T>;
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
  listResources?(params?: ListResourcesParams): Promise<ListResourcesResponse>;
  readResource?(params: ReadResourceParams): Promise<ReadResourceResponse>;
  listResourceTemplates?(params?: ListResourceTemplatesParams): Promise<ListResourceTemplatesResponse>;
  listPrompts?(params?: ListPromptsParams): Promise<ListPromptsResponse>;
  getPrompt?(params: GetPromptParams): Promise<GetPromptResponse>;
  complete?(params: CompleteParams): Promise<CompleteResponse>;
  close(): Promise<void>;
};
