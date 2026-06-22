import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { FentarisTransport } from "../../types/transport.js";
import { resolveHttpTransportHeaders, type HttpTransportAuthOptions } from "../auth/transportAuth.js";
import { assertAllowedUpstreamUrl, type UpstreamHttpNetworkOptions } from "./upstreamUrlGuardrails.js";

export type HttpTransportEnvHeaderMap = Record<string, string> | ((env: Record<string, string>) => Record<string, string>);

/**
 * Options for HTTP transport.
 * @pk
 */
export type HttpTransportOptions = {
  baseUrl: string;
  headers?: Record<string, string>;
  authToken?: string;
  auth?: HttpTransportAuthOptions;
  envHeaderMap?: HttpTransportEnvHeaderMap;
  network?: UpstreamHttpNetworkOptions;
  fetch?: typeof fetch;
};

/**
 * HTTP-based MCP transport adapter.
 * @pk
 */
export class HttpTransport implements FentarisTransport {
  private readonly options: HttpTransportOptions;
  private readonly fetchImpl: typeof fetch;

  /**
   * Create a new HTTP transport.
   * @pk
   */
  constructor(options: HttpTransportOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error("HttpTransport baseUrl cannot be empty");
    }

    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Return a copy with explicitly mapped env-derived headers merged in.
   * @pk
   */
  withEnv(env: Record<string, string>): HttpTransport {
    const authorization = env.AUTHORIZATION ?? (env.AUTH_TOKEN ? `Bearer ${env.AUTH_TOKEN}` : undefined);
    return new HttpTransport({
      ...this.options,
      headers: {
        ...this.options.headers,
        ...mapEnvHeaders(env, this.options.envHeaderMap),
        ...(authorization ? { authorization } : {}),
      },
    });
  }

  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    return this.post<ListToolsResult>("listTools", { params });
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.post<CallToolResult>("callTool", { params });
  }

  async close(): Promise<void> {
    return undefined;
  }

  private async post<TResult>(method: "listTools" | "callTool", body: unknown): Promise<TResult> {
    const requestUrl = new URL(method, ensureTrailingSlash(this.options.baseUrl));
    await assertAllowedUpstreamUrl(requestUrl, this.options.network);
    const authHeaders = await resolveHttpTransportHeaders(this.options.auth, {});
    const response = await this.fetchImpl(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.options.headers,
        ...authHeaders,
        ...(this.options.authToken ? { authorization: `Bearer ${this.options.authToken}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP transport request failed with status ${response.status}`);
    }

    return response.json() as Promise<TResult>;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function mapEnvHeaders(env: Record<string, string>, mapper: HttpTransportEnvHeaderMap | undefined): Record<string, string> {
  if (!mapper) {
    return {};
  }

  if (typeof mapper === "function") {
    return mapper(env);
  }

  const headers: Record<string, string> = {};
  for (const [header, envName] of Object.entries(mapper)) {
    const value = env[envName];
    if (value) {
      headers[header] = value;
    }
  }
  return headers;
}
