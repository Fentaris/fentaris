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
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { resolveHttpTransportHeaders, type HttpTransportAuthOptions } from "../auth/transportAuth.js";
import type { UserContext } from "../../types/shared.js";
import type { FentarisTransport } from "../../types/transport.js";
import { guardedUpstreamFetch, isDefinitiveUnauthorized } from "./guardedFetch.js";
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
  authProvider?: OAuthClientProvider;
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

  /**
   * Absolute upstream MCP URL this transport connects to.
   * @pk
   */
  get upstreamUrl(): string {
    return String(this.options.url);
  }

  /**
   * Fetch implementation applying this transport's network guardrails; used for
   * out-of-band authorization-server requests.
   * @internal
   */
  createGuardedFetch(): ReturnType<typeof guardedUpstreamFetch> {
    return guardedUpstreamFetch(this.options.network, this.options.fetch);
  }

  /**
   * Return a copy bound to an OAuth client provider for one authorization session.
   * @pk
   */
  withAuthProvider(authProvider: OAuthClientProvider): SseMcpTransport {
    return new SseMcpTransport({ ...this.options, authProvider }, this.user);
  }

  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    return this.run(async (client) => (client.getServerCapabilities()?.tools ? client.listTools(params) : { tools: [] }));
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.run(async (client) => client.callTool(params, CallToolResultSchema) as Promise<CallToolResult>);
  }

  async listResources(params?: ListResourcesRequest["params"]): Promise<ListResourcesResult> {
    return this.run(async (client) => (client.getServerCapabilities()?.resources ? client.listResources(params) : { resources: [] }));
  }

  async readResource(params: ReadResourceRequest["params"]): Promise<ReadResourceResult> {
    return this.run(async (client) => {
      if (!client.getServerCapabilities()?.resources) {
        throw unsupportedCapability("resources");
      }

      return client.readResource(params);
    });
  }

  async listResourceTemplates(params?: ListResourceTemplatesRequest["params"]): Promise<ListResourceTemplatesResult> {
    return this.run(async (client) =>
      client.getServerCapabilities()?.resources ? client.listResourceTemplates(params) : { resourceTemplates: [] },
    );
  }

  async listPrompts(params?: ListPromptsRequest["params"]): Promise<ListPromptsResult> {
    return this.run(async (client) => (client.getServerCapabilities()?.prompts ? client.listPrompts(params) : { prompts: [] }));
  }

  async getPrompt(params: GetPromptRequest["params"]): Promise<GetPromptResult> {
    return this.run(async (client) => {
      if (!client.getServerCapabilities()?.prompts) {
        throw unsupportedCapability("prompts");
      }

      return client.getPrompt(params);
    });
  }

  async complete(params: CompleteRequest["params"]): Promise<CompleteResult> {
    return this.run(async (client) => {
      if (!client.getServerCapabilities()?.completions) {
        throw unsupportedCapability("completions");
      }

      return client.complete(params);
    });
  }

  async close(): Promise<void> {
    await this.client?.close();
    await this.transport?.close();
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
  }

  private async run<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    let client: Client;
    try {
      client = await this.getClient();
    } catch (error: unknown) {
      if (isDefinitiveUnauthorized(error)) {
        await this.resetSession();
      }

      throw error;
    }

    try {
      return await operation(client);
    } catch (error: unknown) {
      if (isDefinitiveUnauthorized(error)) {
        // The upstream definitively rejected this session; drop it so the next call
        // reconnects with fresh authorization state.
        await this.resetSession();
      }

      throw error;
    }
  }

  private async resetSession(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
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
    const guardedFetch = guardedUpstreamFetch(this.options.network, this.options.fetch);
    const transport = new SSEClientTransport(new URL(this.options.url), {
      fetch: guardedFetch,
      authProvider: this.options.authProvider,
      eventSourceInit: {
        ...this.options.eventSourceInit,
        fetch: this.options.eventSourceInit?.fetch ?? (guardedFetch as NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]),
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
