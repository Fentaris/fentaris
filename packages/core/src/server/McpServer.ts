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
import { assertValidServerName } from "../nameMapping.js";
import { isOAuthAuth, oauthSessionKeyFor, type OAuthAuth } from "../auth/oauth/dsl.js";
import { PendingAuthorizations } from "../auth/oauth/pending.js";
import { FentarisOAuthClientProvider } from "../auth/oauth/provider.js";
import { MemoryOAuthTokenStore } from "../auth/oauth/store.js";
import { isCredentialReference, type CredentialReference } from "../credentials/index.js";
import type { FentarisTransport } from "../types/transport.js";
import type { Isolation } from "../types/policy.js";
import type { UserContext } from "../types/shared.js";
import type { ProxyContext } from "../types/proxy.js";

/**
 * Resolve environment variables per user.
 * @pk
 */
export type EnvValue = string | CredentialReference;

/**
 * Resolve environment variables per user.
 * @pk
 */
export type EnvResolver = Record<string, EnvValue> | ((user: UserContext) => Record<string, string>);

/**
 * Server credential application configuration.
 * @pk
 */
export type McpServerAuth = BearerCredentialAuth | HeaderCredentialAuth | OAuthAuth;

/**
 * Resolve the OAuth client provider bound to a caller for this server.
 * @pk
 */
export type OAuthProviderResolver = (user: UserContext) => OAuthClientProvider | undefined;

export type BearerCredentialAuth = {
  type: "bearer";
  credential: CredentialReference;
};

export type HeaderCredentialAuth = {
  type: "header";
  header: string;
  credential: CredentialReference;
};

export type ServerCredentialBinding =
  | { type: "bearer"; credential: CredentialReference }
  | { type: "header"; header: string; credential: CredentialReference }
  | { type: "env"; env: string; credential: CredentialReference };

/**
 * Configuration for an MCP server wrapper.
 * @pk
 */
export type McpServerOptions = {
  name: string;
  displayName?: string;
  transport: FentarisTransport;
  auth?: McpServerAuth;
  env?: EnvResolver;
  isolation?: Isolation;
  isolationTimeout?: number;
};

type EnvAwareTransport = FentarisTransport & {
  withEnv(env: Record<string, string>): FentarisTransport;
};

type UserAwareTransport = FentarisTransport & {
  withUser(user: UserContext): FentarisTransport;
};

type OAuthAwareTransport = FentarisTransport & {
  withAuthProvider(provider: OAuthClientProvider): FentarisTransport;
};

/**
 * MCP server wrapper with optional per-user env injection.
 * @pk
 */
export class McpServer {
  readonly name: string;
  readonly displayName: string;

  /** The transport backing this server; exposed for edge recipe/validation. @pk */
  readonly transport: FentarisTransport;
  private readonly auth?: McpServerAuth;
  private readonly env?: EnvResolver;
  private readonly isolation?: Isolation;
  private readonly isolationTimeout?: number;
  private readonly userTransports = new Map<string, FentarisTransport>();
  private oauthResolver?: OAuthProviderResolver;
  private standaloneOAuth?: { store: MemoryOAuthTokenStore; pending: PendingAuthorizations; providers: Map<string, FentarisOAuthClientProvider> };

  /**
   * Create a new MCP server wrapper.
   * @pk
   */
  constructor(options: McpServerOptions) {
    assertValidServerName(options.name);

    this.name = options.name;
    this.displayName = options.displayName ?? options.name;
    this.transport = options.transport;
    this.auth = options.auth;
    this.env = options.env;
    this.isolation = options.isolation;
    this.isolationTimeout = options.isolationTimeout;
  }

  /**
   * List tools for a given user.
   * @pk
   */
  async listTools(params?: ListToolsRequest["params"], user: UserContext = {}): Promise<ListToolsResult> {
    return this.transportFor(user).listTools(params);
  }

  /**
   * Call a tool for a given user.
   * @pk
   */
  async callTool(params: CallToolRequest["params"], user: UserContext = {}): Promise<CallToolResult> {
    return this.runIsolated(user, () => this.transportFor(user).callTool(params));
  }

  /**
   * Apply this server's configured isolation to an alternative transport path.
   * Used by target-aware edge dispatch so placement does not bypass existing
   * concurrency and timeout governance.
   * @internal
   */
  async runIsolated(user: UserContext, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    if (!this.isolation) {
      return run();
    }
    return this.isolation.queue(user.id ?? "anonymous", run, this.isolationTimeout);
  }

  /**
   * List resources for a given user.
   * @pk
   */
  async listResources(params?: ListResourcesRequest["params"], user: UserContext = {}): Promise<ListResourcesResult> {
    const transport = this.transportFor(user);
    if (!transport.listResources) {
      return { resources: [] };
    }

    return transport.listResources(params);
  }

  /**
   * Read a resource for a given user.
   * @pk
   */
  async readResource(params: ReadResourceRequest["params"], user: UserContext = {}): Promise<ReadResourceResult> {
    const transport = this.transportFor(user);
    if (!transport.readResource) {
      throw unsupportedCapability(this.name, "resources");
    }

    return transport.readResource(params);
  }

  /**
   * List resource templates for a given user.
   * @pk
   */
  async listResourceTemplates(
    params?: ListResourceTemplatesRequest["params"],
    user: UserContext = {},
  ): Promise<ListResourceTemplatesResult> {
    const transport = this.transportFor(user);
    if (!transport.listResourceTemplates) {
      return { resourceTemplates: [] };
    }

    return transport.listResourceTemplates(params);
  }

  /**
   * List prompts for a given user.
   * @pk
   */
  async listPrompts(params?: ListPromptsRequest["params"], user: UserContext = {}): Promise<ListPromptsResult> {
    const transport = this.transportFor(user);
    if (!transport.listPrompts) {
      return { prompts: [] };
    }

    return transport.listPrompts(params);
  }

  /**
   * Get a prompt for a given user.
   * @pk
   */
  async getPrompt(params: GetPromptRequest["params"], user: UserContext = {}): Promise<GetPromptResult> {
    const transport = this.transportFor(user);
    if (!transport.getPrompt) {
      throw unsupportedCapability(this.name, "prompts");
    }

    return transport.getPrompt(params);
  }

  /**
   * Complete a prompt or resource argument for a given user.
   * @pk
   */
  async complete(params: CompleteRequest["params"], user: UserContext = {}): Promise<CompleteResult> {
    const transport = this.transportFor(user);
    if (!transport.complete) {
      throw unsupportedCapability(this.name, "completions");
    }

    return transport.complete(params);
  }

  /**
   * Run a server operation with a governed proxy context when the transport supports it.
   * @pk
   */
  async withProxyContext<T>(context: ProxyContext, run: () => Promise<T>): Promise<T> {
    const transport = this.transportFor(context.user);
    if (!transport.withProxyContext) {
      return run();
    }

    return transport.withProxyContext(context, run);
  }

  /**
   * Whether the configured transport exposes resource operations.
   * @pk
   */
  supportsResources(): boolean {
    return Boolean(this.transport.listResources || this.transport.readResource || this.transport.listResourceTemplates);
  }

  /**
   * Whether the configured transport exposes prompt operations.
   * @pk
   */
  supportsPrompts(): boolean {
    return Boolean(this.transport.listPrompts || this.transport.getPrompt);
  }

  /**
   * Whether the configured transport exposes completion operations.
   * @pk
   */
  supportsCompletions(): boolean {
    return Boolean(this.transport.complete);
  }

  /**
   * Close all transports.
   * @pk
   */
  async close(): Promise<void> {
    await Promise.all([...this.userTransports.values()].map((transport) => transport.close()));
    this.userTransports.clear();
    await this.isolation?.close();
    await this.transport.close();
  }

  /**
   * Credential bindings declared with this server.
   * @pk
   */
  /**
   * The OAuth upstream auth declared for this server, when any.
   * @pk
   */
  getOAuthAuth(): OAuthAuth | undefined {
    return isOAuthAuth(this.auth) ? this.auth : undefined;
  }

  /**
   * Bind an OAuth provider resolver so per-user transports carry the caller's authorization.
   * @internal
   */
  attachOAuth(resolver: OAuthProviderResolver): void {
    this.oauthResolver = resolver;
    void this.closeUserTransports();
  }

  /**
   * Drop the cached upstream session for a caller so the next call reconnects.
   * @internal
   */
  async evictTransport(user: UserContext): Promise<void> {
    const prefix = `${this.sessionCacheKey(user)}:`;
    const closing: Promise<void>[] = [];
    for (const [key, transport] of this.userTransports) {
      if (key.startsWith(prefix)) {
        this.userTransports.delete(key);
        closing.push(transport.close().catch(() => undefined));
      }
    }

    await Promise.all(closing);
  }

  /**
   * Credential bindings declared with this server. OAuth is applied through the
   * transport auth provider, never as a static credential.
   * @pk
   */
  getCredentialBindings(): ServerCredentialBinding[] {
    const bindings: ServerCredentialBinding[] = [];
    if (this.auth?.type === "bearer") {
      bindings.push({ type: "bearer", credential: this.auth.credential });
    } else if (this.auth?.type === "header") {
      bindings.push({ type: "header", header: this.auth.header, credential: this.auth.credential });
    }

    if (this.env && typeof this.env !== "function") {
      for (const [name, value] of Object.entries(this.env)) {
        if (isCredentialReference(value)) {
          bindings.push({ type: "env", env: name, credential: value });
        }
      }
    }

    return bindings;
  }

  private sessionCacheKey(user: UserContext): string {
    const oauthAuth = this.getOAuthAuth();
    return oauthAuth ? oauthSessionKeyFor(oauthAuth, user) : (user.id ?? "default");
  }

  /**
   * Provider used when an OAuth server is driven outside a proxy: memory-backed,
   * so authorizations last only for the process.
   */
  private standaloneOAuthProviderFor(user: UserContext): OAuthClientProvider | undefined {
    const oauthAuth = this.getOAuthAuth();
    if (!oauthAuth) {
      return undefined;
    }

    this.standaloneOAuth ??= { store: new MemoryOAuthTokenStore(), pending: new PendingAuthorizations(), providers: new Map() };
    const session = oauthSessionKeyFor(oauthAuth, user);
    const existing = this.standaloneOAuth.providers.get(session);
    if (existing) {
      return existing;
    }

    if (oauthAuth.provider) {
      const custom = oauthAuth.provider({ server: this.name, user, session, store: this.standaloneOAuth.store });
      return custom;
    }

    const provider = new FentarisOAuthClientProvider({
      server: this.name,
      session,
      auth: oauthAuth,
      store: this.standaloneOAuth.store,
      pending: this.standaloneOAuth.pending,
    });
    this.standaloneOAuth.providers.set(session, provider);
    return provider;
  }

  private async closeUserTransports(): Promise<void> {
    const transports = [...this.userTransports.values()];
    this.userTransports.clear();
    await Promise.all(transports.map((transport) => transport.close().catch(() => undefined)));
  }

  private transportFor(user: UserContext): FentarisTransport {
    const upstreamEnv = isStringRecord(user.__fentarisUpstreamEnv) ? user.__fentarisUpstreamEnv : undefined;
    const supportsUserContext = isUserAwareTransport(this.transport);
    const oauthProvider = this.oauthResolver ? this.oauthResolver(user) : this.standaloneOAuthProviderFor(user);
    if (!this.env && !upstreamEnv && !supportsUserContext && !oauthProvider) {
      return this.transport;
    }

    const configuredEnv = typeof this.env === "function" ? this.env(user) : this.env;
    const resolvedEnv = {
      ...stringEnv(configuredEnv ?? {}),
      ...(upstreamEnv ?? {}),
    };
    const key = `${this.sessionCacheKey(user)}:${JSON.stringify(Object.entries(resolvedEnv).sort(([left], [right]) => left.localeCompare(right)))}`;
    const existing = this.userTransports.get(key);
    if (existing) {
      return existing;
    }

    let transport = this.transport;
    if ((this.env || upstreamEnv) && !isEnvAwareTransport(transport)) {
      throw new Error(`Transport for server "${this.name}" does not support env injection`);
    }

    if (this.env || upstreamEnv) {
      transport = (transport as EnvAwareTransport).withEnv(resolvedEnv);
    }

    if (isUserAwareTransport(transport)) {
      transport = transport.withUser(user);
    }

    if (oauthProvider) {
      if (!isOAuthAwareTransport(transport)) {
        throw new Error(`Transport for server "${this.name}" does not support OAuth upstream auth`);
      }

      transport = transport.withAuthProvider(oauthProvider);
    }

    this.userTransports.set(key, transport);
    return transport;
  }
}

/**
 * Create an upstream MCP server declaration.
 * @pk
 */
export function mcp(name: string, options: Omit<McpServerOptions, "name">): McpServer {
  return new McpServer({ ...options, name });
}

/**
 * Apply a credential as an Authorization bearer token.
 * @pk
 */
export function bearer(credential: CredentialReference): BearerCredentialAuth {
  return { type: "bearer", credential };
}

/**
 * Apply a credential as a named request header.
 * @pk
 */
export function header(name: string, credential: CredentialReference): HeaderCredentialAuth {
  if (!name.trim()) {
    throw new Error("Credential header name cannot be empty");
  }

  return { type: "header", header: name, credential };
}

/**
 * Type guard for env-aware transports.
 * @pk
 */
function isEnvAwareTransport(transport: FentarisTransport): transport is EnvAwareTransport {
  return "withEnv" in transport && typeof transport.withEnv === "function";
}

function isUserAwareTransport(transport: FentarisTransport): transport is UserAwareTransport {
  return "withUser" in transport && typeof transport.withUser === "function";
}

/**
 * Type guard for transports that accept an OAuth client provider.
 * @pk
 */
export function isOAuthAwareTransport(transport: FentarisTransport): transport is OAuthAwareTransport {
  return "withAuthProvider" in transport && typeof transport.withAuthProvider === "function";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringEnv(value: Record<string, EnvValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function unsupportedCapability(serverName: string, capability: "resources" | "prompts" | "completions"): Error {
  return new Error(`Transport for server "${serverName}" does not support ${capability}`);
}
