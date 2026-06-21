import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, type SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
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
import { resolveHttpTransportHeaders, type HttpTransportAuthOptions } from "../auth/transportAuth.js";
import type { UserContext } from "../../types/shared.js";
import type { FentarisTransport } from "../../types/transport.js";
import { assertAllowedUpstreamUrl, type UpstreamHttpNetworkOptions } from "./upstreamUrlGuardrails.js";

/**
 * Options for native MCP SSE upstream transport.
 * @pk
 */
export type SseMcpTransportOptions = {
  url: string | URL;
  auth?: HttpTransportAuthOptions;
  eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
  requestInit?: RequestInit;
  fetch?: SSEClientTransportOptions["fetch"];
  network?: UpstreamHttpNetworkOptions;
  clientName?: string;
  clientVersion?: string;
};

/**
 * Native MCP SSE upstream transport.
 * @pk
 */
export class SseMcpTransport implements FentarisTransport {
  private readonly options: SseMcpTransportOptions;
  private readonly user: UserContext;
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private connectPromise: Promise<Client> | null = null;

  /**
   * Create a native MCP SSE transport.
   * @pk
   */
  constructor(options: SseMcpTransportOptions, user: UserContext = {}) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("SseMcpTransport url must use http:// or https://");
    }

    this.options = { ...options, url };
    this.user = user;
  }

  /**
   * Return a copy bound to the current proxy user context.
   * @pk
   */
  withUser(user: UserContext): SseMcpTransport {
    return new SseMcpTransport(this.options, user);
  }

  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.tools) {
      return { tools: [] };
    }

    return client.listTools(params);
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return (await this.getClient()).callTool(params, CallToolResultSchema) as Promise<CallToolResult>;
  }

  async listResources(params?: ListResourcesRequest["params"]): Promise<ListResourcesResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources) {
      return { resources: [] };
    }

    return client.listResources(params);
  }

  async readResource(params: ReadResourceRequest["params"]): Promise<ReadResourceResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources) {
      throw unsupportedCapability("resources");
    }

    return client.readResource(params);
  }

  async listResourceTemplates(params?: ListResourceTemplatesRequest["params"]): Promise<ListResourceTemplatesResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources) {
      return { resourceTemplates: [] };
    }

    return client.listResourceTemplates(params);
  }

  async listPrompts(params?: ListPromptsRequest["params"]): Promise<ListPromptsResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.prompts) {
      return { prompts: [] };
    }

    return client.listPrompts(params);
  }

  async getPrompt(params: GetPromptRequest["params"]): Promise<GetPromptResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.prompts) {
      throw unsupportedCapability("prompts");
    }

    return client.getPrompt(params);
  }

  async complete(params: CompleteRequest["params"]): Promise<CompleteResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.completions) {
      throw unsupportedCapability("completions");
    }

    return client.complete(params);
  }

  async close(): Promise<void> {
    await this.client?.close();
    await this.transport?.close();
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
  }

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connect();
    }

    try {
      this.client = await this.connectPromise;
      return this.client;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  private async connect(): Promise<Client> {
    await assertAllowedUpstreamUrl(new URL(this.options.url), this.options.network);
    const headers = await resolveHttpTransportHeaders(this.options.auth, this.user);
    const client = new Client(
      {
        name: this.options.clientName ?? "fentaris-core",
        version: this.options.clientVersion ?? "0.1.0",
      },
      { capabilities: {} },
    );
    const transport = new SSEClientTransport(new URL(this.options.url), {
      fetch: this.options.fetch,
      eventSourceInit: {
        ...this.options.eventSourceInit,
        fetch: this.options.eventSourceInit?.fetch,
      },
      requestInit: {
        ...this.options.requestInit,
        headers: {
          ...headersFrom(this.options.requestInit?.headers),
          ...headers,
        },
      },
    });

    await client.connect(transport);
    this.transport = transport;
    return client;
  }
}

function headersFrom(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(new Headers(headers).entries());
}

function unsupportedCapability(capability: "resources" | "prompts" | "completions"): Error {
  return new Error(`Upstream MCP server does not support ${capability}`);
}
