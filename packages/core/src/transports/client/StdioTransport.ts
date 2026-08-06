import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
import { isRuntimeValueToken, describeRuntimeValueToken, type RuntimeValueToken } from "../../edge/runtimeInput.js";
import { compileLaunchRecipe, type LaunchRecipe } from "../../edge/recipe.js";
import { edgeError } from "../../edge/errors.js";
import type { EdgeInstallPlan, EdgeNpmInstallPlanInput } from "../../edge/install.js";
import type { SetupSchema } from "../../edge/setup.js";
import type { FentarisTransport } from "../../types/transport.js";

/**
 * Options for the stdio transport.
 *
 * Argument and environment entries may be plain strings (existing behavior) or
 * runtime-value tokens (`runtime.input(...)` / `runtime.secret(...)`) that are
 * resolved before process launch on a cloud target, or serialized into a
 * recipe for edge launch. A plain-string configuration remains unchanged.
 * @pk
 */
export type StdioTransportOptions = {
  command: string;
  args?: Array<string | RuntimeValueToken>;
  env?: Record<string, string | RuntimeValueToken>;
  /**
   * Explicit cloud-side resolutions for runtime references. These values are
   * used only for local cloud process launch and are never serialized into an
   * edge launch recipe.
   * @pk
   */
  runtimeValues?: Record<string, string>;
  /**
   * Managed installation for edge execution. Declare it with `edge.npm(...)`.
   * When present, `command` is a bare bin name that the edge agent resolves
   * inside its managed install directory, and cloud execution is rejected.
   * @pk
   */
  install?: EdgeInstallPlan | EdgeNpmInstallPlanInput;
  stderr?: "inherit" | "pipe" | "overlapped" | "ignore";
  clientName?: string;
  clientVersion?: string;
};

/**
 * Stdio-based MCP transport implementation.
 * @pk
 */
export class StdioTransport implements FentarisTransport {
  private readonly options: StdioTransportOptions;
  private client: Client | null = null;
  private connectPromise: Promise<Client> | null = null;

  /**
   * Create a new stdio transport.
   * @pk
   */
  constructor(options: StdioTransportOptions) {
    if (!options.command.trim()) {
      throw new Error("StdioTransport command cannot be empty");
    }

    this.options = options;
  }

  /**
   * Compile this transport's declaration into a serializable launch recipe bound
   * to an optional setup schema. Cloud/edge validation uses this to reconcile
   * runtime-value references against declared setup fields.
   * @pk
   */
  toLaunchRecipe(schema?: SetupSchema): LaunchRecipe {
    return compileLaunchRecipe(this.options, schema);
  }

  /**
   * Return every runtime-value token declared in arguments and environment.
   * Used by configuration validation to reconcile references against setup
   * fields without exposing the full options object.
   * @pk
   */
  runtimeValueTokens(): RuntimeValueToken[] {
    const tokens: RuntimeValueToken[] = [];
    for (const value of this.options.args ?? []) {
      if (isRuntimeValueToken(value)) tokens.push(value);
    }
    for (const value of Object.values(this.options.env ?? {})) {
      if (isRuntimeValueToken(value)) tokens.push(value);
    }
    return tokens;
  }

  /** Whether this transport declares an edge-managed software installation. @pk */
  requiresManagedInstall(): boolean {
    return this.options.install !== undefined;
  }

  /** Runtime references that have no explicit cloud-side value. @pk */
  unresolvedCloudRuntimeRefs(): string[] {
    const values = this.options.runtimeValues ?? {};
    return [...new Set(this.runtimeValueTokens().map((token) => token.ref).filter((ref) => values[ref] === undefined))].sort();
  }

  /**
   * Return a copy with merged environment variables.
   * @pk
   */
  withEnv(env: Record<string, string>): StdioTransport {
    return new StdioTransport({
      ...this.options,
      env: {
        ...this.options.env,
        ...env,
      },
    });
  }

  /**
   * List tools exposed by the MCP server.
   * @pk
   */
  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.tools) {
      return { tools: [] };
    }

    return client.listTools(params);
  }

  /**
   * Call a tool on the MCP server.
   * @pk
   */
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

  /** Return the initialized upstream capability declaration. @pk */
  async serverCapabilities(): Promise<ReturnType<Client["getServerCapabilities"]>> {
    return (await this.getClient()).getServerCapabilities();
  }

  /**
   * Close the underlying client connection.
   * @pk
   */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
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
    if (this.options.install) {
      throw edgeError(
        "EDGE_UNRESOLVED_RUNTIME_INPUT",
        "Managed installation requires an edge target; the cloud target cannot install MCP packages.",
        { details: { command: this.options.command } },
      );
    }
    const client = new Client(
      {
        name: this.options.clientName ?? "fentaris-core",
        version: this.options.clientVersion ?? "0.1.0",
      },
      { capabilities: {} },
    );

    await client.connect(
      new StdioClientTransport({
        command: this.options.command,
        args: this.resolveCloudLaunchArgs(this.options.args ?? []),
        env: this.resolveCloudLaunchEnv(this.options.env),
        stderr: this.options.stderr ?? "inherit",
      }),
    );

    return client;
  }

  /**
   * Resolve recipe arguments to plain strings for cloud execution. Throws a
   * normalized `EDGE_UNRESOLVED_RUNTIME_INPUT` error for any runtime-value
   * token without a cloud-side resolution; this is the cloud-launch backstop
   * for the explicit recipe validation performed before dispatch.
   * @pk
   */
  private resolveCloudLaunchArgs(args: Array<string | RuntimeValueToken>): string[] {
    return args.map((value) => this.coerceCloudLaunchValue(value));
  }

  private resolveCloudLaunchEnv(env?: Record<string, string | RuntimeValueToken>): Record<string, string> | undefined {
    if (!env) {
      return undefined;
    }
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      resolved[key] = this.coerceCloudLaunchValue(value);
    }
    return resolved;
  }

  private coerceCloudLaunchValue(value: string | RuntimeValueToken): string {
    if (typeof value === "string") {
      return value;
    }
    if (isRuntimeValueToken(value)) {
      const resolved = this.options.runtimeValues?.[value.ref];
      if (resolved !== undefined) {
        return resolved;
      }
      throw edgeError("EDGE_UNRESOLVED_RUNTIME_INPUT", `Stdio cloud launch cannot resolve ${describeRuntimeValueToken(value)}`, {
        details: { ref: value.ref },
      });
    }
    throw new TypeError("invalid stdio launch value");
  }
}

/**
 * Create a stdio upstream transport.
 * @pk
 */
export function stdio(options: StdioTransportOptions): StdioTransport {
  return new StdioTransport(options);
}

function unsupportedCapability(capability: "resources" | "prompts" | "completions"): Error {
  return new Error(`Upstream MCP server does not support ${capability}`);
}
