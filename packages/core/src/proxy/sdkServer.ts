import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type CompleteRequest,
  type CompleteResult,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsRequest,
  type ListPromptsResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ListResourceTemplatesRequest,
  type ListResourceTemplatesResult,
  type ListToolsRequest,
  type ListToolsResult,
  type ReadResourceRequest,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { IdentityMetadata, ResolvedSubject, UserContext } from "../types/shared.js";
import type { ProxySessionInteraction } from "../types/proxy.js";
import type { McpServer } from "../server/McpServer.js";

export interface SdkServerDeps {
  name: string;
  version: string;
  servers: McpServer[];
  listTools(params?: ListToolsRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<CallToolResult>;
  listResources(params?: ListResourcesRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<ListResourcesResult>;
  readResource(params: ReadResourceRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<ReadResourceResult>;
  listResourceTemplates(params?: ListResourceTemplatesRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<ListResourceTemplatesResult>;
  listPrompts(params?: ListPromptsRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<ListPromptsResult>;
  getPrompt(params: GetPromptRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<GetPromptResult>;
  complete(params: CompleteRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject, interaction?: ProxySessionInteraction): Promise<CompleteResult>;
}

export function createServerCapabilities(servers: McpServer[]): {
  tools: object;
  logging: object;
  resources?: object;
  prompts?: object;
  completions?: object;
} {
  return {
    tools: {},
    logging: {},
    ...(servers.some((server) => server.supportsResources()) ? { resources: {} } : {}),
    ...(servers.some((server) => server.supportsPrompts()) ? { prompts: {} } : {}),
    ...(servers.some((server) => server.supportsCompletions()) ? { completions: {} } : {}),
  };
}

export function createSdkServer(deps: SdkServerDeps, user: UserContext = {}, identity?: IdentityMetadata, subject?: ResolvedSubject): McpSdkServer {
  const capabilities = createServerCapabilities(deps.servers);
  const server = new McpSdkServer(
    { name: deps.name, version: deps.version },
    {
      capabilities,
      instructions: "Fentaris MCP proxy. Tool and prompt names are prefixed as <server>__<name>; resources use fentaris:// proxy URIs.",
    },
  );

  const interaction = createSessionInteraction(server);

  server.setRequestHandler(ListToolsRequestSchema, async (request) => deps.listTools(request.params, user, identity, subject, interaction));
  server.setRequestHandler(CallToolRequestSchema, async (request) => deps.callTool(request.params, user, identity, subject, interaction));
  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => deps.listResources(request.params, user, identity, subject));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => deps.readResource(request.params, user, identity, subject));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => deps.listResourceTemplates(request.params, user, identity, subject));
  }
  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => deps.listPrompts(request.params, user, identity, subject));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => deps.getPrompt(request.params, user, identity, subject));
  }
  if (capabilities.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => deps.complete(request.params, user, identity, subject));
  }

  return server;
}

/**
 * Build the per-session interaction channel from the SDK server instance.
 */
function createSessionInteraction(server: McpSdkServer): ProxySessionInteraction {
  return {
    supportsUrlElicitation(): boolean {
      const capabilities = server.getClientCapabilities() as { elicitation?: { url?: unknown } } | undefined;
      return Boolean(capabilities?.elicitation && "url" in capabilities.elicitation && capabilities.elicitation.url);
    },
    async elicitUrl(params): Promise<{ action: "accept" | "decline" | "cancel" }> {
      const result = await server.elicitInput({
        mode: "url",
        message: params.message,
        url: params.url,
        elicitationId: params.elicitationId,
      });
      return { action: result.action as "accept" | "decline" | "cancel" };
    },
    async notifyElicitationComplete(elicitationId): Promise<void> {
      await server.createElicitationCompletionNotifier(elicitationId)();
    },
  };
}
