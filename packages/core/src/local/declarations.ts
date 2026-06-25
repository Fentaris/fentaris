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
  Prompt,
  ReadResourceRequest,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { assertValidServerName } from "../nameMapping.js";
import { McpServer } from "../server/McpServer.js";
import type { FentarisTransport } from "../types/transport.js";
import type { ProxyContext } from "../types/proxy.js";
import type { MaybePromise } from "../types/shared.js";

/**
 * Metadata accepted when declaring a local tool.
 * @pk
 */
export type LocalToolMetadata = Omit<Tool, "name">;

/**
 * Metadata accepted when declaring a local exact resource.
 * @pk
 */
export type LocalResourceMetadata = Omit<Resource, "uri">;

/**
 * Metadata accepted when declaring a local resource template.
 * @pk
 */
export type LocalResourceTemplateMetadata = Omit<ResourceTemplate, "uriTemplate">;

/**
 * Metadata accepted when declaring a local prompt.
 * @pk
 */
export type LocalPromptMetadata = Omit<Prompt, "name">;

/**
 * Local tool handler.
 * @pk
 */
export type LocalToolHandler = (
  ctx: ProxyContext,
  params: CallToolRequest["params"],
) => MaybePromise<CallToolResult>;

/**
 * Local resource read handler.
 * @pk
 */
export type LocalResourceHandler = (
  ctx: ProxyContext,
  params: ReadResourceRequest["params"],
) => MaybePromise<ReadResourceResult>;

/**
 * Local prompt handler.
 * @pk
 */
export type LocalPromptHandler = (
  ctx: ProxyContext,
  params: GetPromptRequest["params"],
) => MaybePromise<GetPromptResult>;

/**
 * Local completion handler.
 * @pk
 */
export type LocalCompletionHandler = (
  ctx: ProxyContext,
  params: CompleteRequest["params"],
) => MaybePromise<CompleteResult>;

/**
 * Reference used to bind a local completion handler.
 * @pk
 */
export type LocalCompletionReference =
  | { type: "ref/prompt"; name: string }
  | { type: "ref/resource"; uriTemplate: string };

/**
 * Handle returned by `app.local(name)` for declaring local MCP capabilities.
 * @pk
 */
export type ProxyLocalHandle = {
  readonly name: string;
  tool(name: string, metadata: LocalToolMetadata, handler: LocalToolHandler): ProxyLocalHandle;
  resource(uri: string, metadata: LocalResourceMetadata, handler: LocalResourceHandler): ProxyLocalHandle;
  resourceTemplate(uriTemplate: string, metadata: LocalResourceTemplateMetadata, handler: LocalResourceHandler): ProxyLocalHandle;
  prompt(name: string, metadata: LocalPromptMetadata, handler: LocalPromptHandler): ProxyLocalHandle;
  completion(ref: LocalCompletionReference, handler: LocalCompletionHandler): ProxyLocalHandle;
};

type LocalToolDeclaration = Tool & { handler: LocalToolHandler };
type LocalResourceDeclaration = Resource & { handler: LocalResourceHandler };
type LocalResourceTemplateDeclaration = ResourceTemplate & {
  handler: LocalResourceHandler;
  matcher: RegExp;
};
type LocalPromptDeclaration = Prompt & { handler: LocalPromptHandler };
type LocalCompletionDeclaration = {
  ref: LocalCompletionReference;
  key: string;
  handler: LocalCompletionHandler;
};

export class LocalCapabilityRegistry {
  private readonly namespaces = new Map<string, LocalNamespaceDeclaration>();
  private readonly serversByName = new Map<string, McpServer>();

  namespace(name: string): LocalNamespaceDeclaration {
    const existing = this.namespaces.get(name);
    if (existing) {
      return existing;
    }

    const namespace = new LocalNamespaceDeclaration(name);
    this.namespaces.set(name, namespace);
    return namespace;
  }

  servers(): McpServer[] {
    return [...this.namespaces.values()].map((namespace) => {
      const existing = this.serversByName.get(namespace.name);
      if (existing) {
        return existing;
      }

      const server = namespace.toServer();
      this.serversByName.set(namespace.name, server);
      return server;
    });
  }
}

export class LocalNamespaceDeclaration implements ProxyLocalHandle {
  readonly tools = new Map<string, LocalToolDeclaration>();
  readonly resources = new Map<string, LocalResourceDeclaration>();
  readonly resourceTemplates = new Map<string, LocalResourceTemplateDeclaration>();
  readonly prompts = new Map<string, LocalPromptDeclaration>();
  readonly completions = new Map<string, LocalCompletionDeclaration>();

  constructor(readonly name: string) {
    assertValidServerName(name);
  }

  tool(name: string, metadata: LocalToolMetadata, handler: LocalToolHandler): ProxyLocalHandle {
    assertValidDeclarationName(name, "tool");
    assertUnique(this.tools, name, "tool", this.name);
    this.tools.set(name, { ...metadata, name, handler });
    return this;
  }

  resource(uri: string, metadata: LocalResourceMetadata, handler: LocalResourceHandler): ProxyLocalHandle {
    assertValidUri(uri, "resource URI");
    assertUnique(this.resources, uri, "resource", this.name);
    this.resources.set(uri, { ...metadata, uri, handler });
    return this;
  }

  resourceTemplate(uriTemplate: string, metadata: LocalResourceTemplateMetadata, handler: LocalResourceHandler): ProxyLocalHandle {
    assertValidUri(uriTemplate, "resource template URI");
    assertUnique(this.resourceTemplates, uriTemplate, "resource template", this.name);
    this.resourceTemplates.set(uriTemplate, {
      ...metadata,
      uriTemplate,
      handler,
      matcher: compileUriTemplate(uriTemplate),
    });
    return this;
  }

  prompt(name: string, metadata: LocalPromptMetadata, handler: LocalPromptHandler): ProxyLocalHandle {
    assertValidDeclarationName(name, "prompt");
    assertUnique(this.prompts, name, "prompt", this.name);
    this.prompts.set(name, { ...metadata, name, handler });
    return this;
  }

  completion(ref: LocalCompletionReference, handler: LocalCompletionHandler): ProxyLocalHandle {
    const key = completionKey(ref);
    if (ref.type === "ref/prompt" && !this.prompts.has(ref.name)) {
      throw new Error(`Local namespace "${this.name}" cannot declare completion for unknown prompt "${ref.name}"`);
    }
    if (ref.type === "ref/resource" && !this.resourceTemplates.has(ref.uriTemplate)) {
      throw new Error(`Local namespace "${this.name}" cannot declare completion for unknown resource template "${ref.uriTemplate}"`);
    }
    assertUnique(this.completions, key, "completion handler", this.name);
    this.completions.set(key, { ref, key, handler });
    return this;
  }

  toServer(): McpServer {
    return new McpServer({
      name: this.name,
      displayName: this.name,
      transport: new LocalCapabilityTransport(this),
    });
  }
}

export type ProxyContextAwareTransport = FentarisTransport & {
  withProxyContext<T>(context: ProxyContext, run: () => Promise<T>): Promise<T>;
};

export function isProxyContextAwareTransport(transport: FentarisTransport): transport is ProxyContextAwareTransport {
  return "withProxyContext" in transport && typeof transport.withProxyContext === "function";
}

class LocalCapabilityTransport implements FentarisTransport {
  private context?: ProxyContext;

  constructor(private readonly namespace: LocalNamespaceDeclaration) {}

  async withProxyContext<T>(context: ProxyContext, run: () => Promise<T>): Promise<T> {
    const previous = this.context;
    this.context = context;
    try {
      return await run();
    } finally {
      this.context = previous;
    }
  }

  async listTools(_params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    return { tools: [...this.namespace.tools.values()].map(({ handler: _handler, ...tool }) => tool) };
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    const declaration = this.namespace.tools.get(params.name);
    if (!declaration) {
      throw new Error(`Unknown local tool "${params.name}" in namespace "${this.namespace.name}"`);
    }

    return assertToolResult(await declaration.handler(this.requireContext(), params));
  }

  async listResources(_params?: ListResourcesRequest["params"]): Promise<ListResourcesResult> {
    return { resources: [...this.namespace.resources.values()].map(({ handler: _handler, ...resource }) => resource) };
  }

  async readResource(params: ReadResourceRequest["params"]): Promise<ReadResourceResult> {
    const exact = this.namespace.resources.get(params.uri);
    if (exact) {
      return assertResourceResult(await exact.handler(this.requireContext(), params));
    }

    const template = [...this.namespace.resourceTemplates.values()].find((entry) => entry.matcher.test(params.uri));
    if (!template) {
      throw new Error(`Unknown local resource "${params.uri}" in namespace "${this.namespace.name}"`);
    }

    return assertResourceResult(await template.handler(this.requireContext(), params));
  }

  async listResourceTemplates(_params?: ListResourceTemplatesRequest["params"]): Promise<ListResourceTemplatesResult> {
    return {
      resourceTemplates: [...this.namespace.resourceTemplates.values()]
        .map(({ handler: _handler, matcher: _matcher, ...template }) => template),
    };
  }

  async listPrompts(_params?: ListPromptsRequest["params"]): Promise<ListPromptsResult> {
    return { prompts: [...this.namespace.prompts.values()].map(({ handler: _handler, ...prompt }) => prompt) };
  }

  async getPrompt(params: GetPromptRequest["params"]): Promise<GetPromptResult> {
    const declaration = this.namespace.prompts.get(params.name);
    if (!declaration) {
      throw new Error(`Unknown local prompt "${params.name}" in namespace "${this.namespace.name}"`);
    }

    return assertPromptResult(await declaration.handler(this.requireContext(), params));
  }

  async complete(params: CompleteRequest["params"]): Promise<CompleteResult> {
    const key = params.ref.type === "ref/prompt"
      ? completionKey({ type: "ref/prompt", name: params.ref.name })
      : completionKey({ type: "ref/resource", uriTemplate: params.ref.uri });
    const declaration = this.namespace.completions.get(key);
    if (!declaration) {
      throw new Error(`Transport for server "${this.namespace.name}" does not support completions`);
    }

    return assertCompletionResult(await declaration.handler(this.requireContext(), params));
  }

  async close(): Promise<void> {}

  private requireContext(): ProxyContext {
    if (!this.context) {
      throw new Error(`Local namespace "${this.namespace.name}" handler invoked without proxy context`);
    }

    return this.context;
  }
}

function assertValidDeclarationName(name: string, kind: "tool" | "prompt"): void {
  if (!name.trim()) {
    throw new Error(`Local ${kind} name cannot be empty`);
  }
}

function assertValidUri(uri: string, kind: string): void {
  if (!uri.trim()) {
    throw new Error(`Local ${kind} cannot be empty`);
  }
}

function assertUnique(map: Map<string, unknown>, key: string, kind: string, namespace: string): void {
  if (map.has(key)) {
    throw new Error(`Duplicate local ${kind} "${key}" in namespace "${namespace}"`);
  }
}

function completionKey(ref: LocalCompletionReference): string {
  return ref.type === "ref/prompt" ? `prompt:${ref.name}` : `resource:${ref.uriTemplate}`;
}

function compileUriTemplate(template: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < template.length; i += 1) {
    const char = template[i];
    if (char === "{") {
      const end = template.indexOf("}", i + 1);
      if (end === -1 || end === i + 1) {
        throw new Error(`Invalid local resource template URI "${template}"`);
      }
      pattern += "[^/]+";
      i = end;
      continue;
    }
    pattern += escapeRegExp(char);
  }
  pattern += "$";
  return new RegExp(pattern);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function assertToolResult(result: CallToolResult): CallToolResult {
  if (!result || !Array.isArray(result.content)) {
    throw new Error("Local tool handler returned an invalid MCP tool result");
  }
  return result;
}

function assertResourceResult(result: ReadResourceResult): ReadResourceResult {
  if (!result || !Array.isArray(result.contents)) {
    throw new Error("Local resource handler returned an invalid MCP resource result");
  }
  return result;
}

function assertPromptResult(result: GetPromptResult): GetPromptResult {
  if (!result || !Array.isArray(result.messages)) {
    throw new Error("Local prompt handler returned an invalid MCP prompt result");
  }
  return result;
}

function assertCompletionResult(result: CompleteResult): CompleteResult {
  if (!result || !result.completion || !Array.isArray(result.completion.values)) {
    throw new Error("Local completion handler returned an invalid MCP completion result");
  }
  return result;
}
