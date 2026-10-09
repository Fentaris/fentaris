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
import { credential as credentialReference, isCredentialReference, type CredentialReference } from "../credentials/index.js";
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
export type McpServerAuth = BearerCredentialAuth | HeaderCredentialAuth | OAuthAuth | { type: "none" | "managed" };

/** A named upstream connection. Client restrictions do not grant server/tool access. @pk */
export type McpAccountOptions = {
  auth?: McpServerAuth;
  env?: EnvResolver;
  transport?: FentarisTransport;
  /** Downstream clients permitted to use this connection, in addition to runtime policies. @pk */
  allowedUsers?: string[];
  /** A disconnected account stays in inventory but cannot be used. @pk */
  disconnected?: boolean;
  /** Optional provider lookup. Called only after a successful live check; never infer identity from an alias. @pk */
  inspectIdentity?: () => Promise<{ identity?: Record<string, string>; permissions?: string[] }>;
};

/** Resolve an upstream reference in the project credential store, never a client scope. @pk */
export type McpSecretResolver = (reference: string) => Promise<string | undefined>;


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
  description?: string;
  accounts?: Record<string, McpAccountOptions>;
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
  readonly description?: string;
  private accountDeclarations?: Record<string, McpAccountOptions>;
  private readonly accountServers = new Map<string, McpServer>();
  private readonly accountEnvReferences = new Map<string, Record<string, CredentialReference>>();
  private boundEnvReferences: Record<string, CredentialReference> = {};
  private accountAlias?: string;
  private disconnected = false;
  private secretResolver?: McpSecretResolver;


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
    this.description = options.description;
    this.accountDeclarations = options.accounts;

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
    if (this.accountDeclarations) return this.selectedAccount(user).listTools(params, user);
    user = await this.prepareAccountUser(user);
    return this.transportFor(user).listTools(params);
  }

  /**
   * Call a tool for a given user.
   * @pk
   */
  async callTool(params: CallToolRequest["params"], user: UserContext = {}): Promise<CallToolResult> {
    if (this.accountDeclarations) return this.selectedAccount(user).callTool(params, user);
    user = await this.prepareAccountUser(user);
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
    if (this.accountDeclarations) return this.selectedAccount(user).listResources(params, user);
    user = await this.prepareAccountUser(user);
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
    if (this.accountDeclarations) return this.selectedAccount(user).readResource(params, user);
    user = await this.prepareAccountUser(user);
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
    if (this.accountDeclarations) return this.selectedAccount(user).listResourceTemplates(params, user);
    user = await this.prepareAccountUser(user);
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
    if (this.accountDeclarations) return this.selectedAccount(user).listPrompts(params, user);
    user = await this.prepareAccountUser(user);
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
    if (this.accountDeclarations) return this.selectedAccount(user).getPrompt(params, user);
    user = await this.prepareAccountUser(user);
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
    if (this.accountDeclarations) return this.selectedAccount(user).complete(params, user);
    user = await this.prepareAccountUser(user);
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
    if (this.accountDeclarations) return this.selectedAccount(context.user).withProxyContext(context, run);
    const transport = this.transportFor(await this.prepareAccountUser(context.user));
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
    await Promise.all([...this.accountServers.values()].map((server) => server.close()));
    this.accountServers.clear();
    await Promise.all([...this.userTransports.values()].map((transport) => transport.close()));
    this.userTransports.clear();
    if (!this.accountAlias) await this.isolation?.close();
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

    for (const [name, value] of Object.entries(this.boundEnvReferences)) bindings.push({ type: "env", env: name, credential: value });
    return bindings;
  }

  /** Configured local aliases; a legacy singleton is displayed as default. @pk */
  accountNames(): string[] { return this.accountDeclarations ? Object.keys(this.accountDeclarations) : ["default"]; }

  /** Whether this server uses explicit upstream accounts. @pk */
  hasNamedAccounts(): boolean { return this.accountDeclarations !== undefined; }

  /** Read a declaration without starting a transport. @pk */
  accountOptions(alias: string): McpAccountOptions {
    if (!this.accountNames().includes(alias)) throw new Error(`Unknown account "${alias}" for MCP "${this.name}".`);
    return this.accountDeclarations?.[alias] ?? { auth: this.auth, env: this.env };
  }

  /** Authentication declaration, without exposing any resolved credential. @pk */
  authentication(): McpServerAuth | undefined { return this.auth; }

  /** Bind a project credential resolver for named account runtime and discovery. @pk */
  attachAccountSecrets(resolve: McpSecretResolver): void {
    this.secretResolver = resolve;
    for (const server of this.accountServers.values()) server.attachAccountSecrets(resolve);
  }

  /** Apply persisted reference bindings to a configured account. @pk */
  bindAccount(alias: string, entry: { disconnected?: boolean; bindings?: Record<string, string> }): void {
    const existing = this.accountOptions(alias);
    const bindings = entry.bindings ?? {};
    let auth = existing.auth ?? this.auth;
    if (bindings.bearer && auth?.type === "bearer") auth = { ...auth, credential: credentialReference(bindings.bearer) };
    if (auth?.type === "header" && bindings[auth.header]) auth = { ...auth, credential: credentialReference(bindings[auth.header]) };
    const originalEnv = existing.env ?? this.env;
    const envBindings = Object.fromEntries(Object.entries(bindings).filter(([slot]) => slot !== "bearer" && (auth?.type !== "header" || slot !== auth.header)).map(([slot, ref]) => [slot, credentialReference(ref)]));
    const env = Object.keys(envBindings).length === 0 || typeof originalEnv === "function" ? originalEnv : { ...originalEnv, ...envBindings };
    if (typeof originalEnv === "function") this.accountEnvReferences.set(alias, envBindings);
    this.accountDeclarations = { ...(this.accountDeclarations ?? { default: { auth: this.auth, env: this.env } }), [alias]: { ...existing, auth, env, disconnected: entry.disconnected } };
    const previous = this.accountServers.get(alias);
    this.accountServers.delete(alias);
    void previous?.close().catch(() => undefined);
  }

  /** An administrative connection view. It never fabricates a downstream user. @pk */
  account(alias: string): McpServer {
    const existing = this.accountServers.get(alias);
    if (existing) return existing;
    const declaration = this.accountOptions(alias);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)) throw new Error("Account aliases must contain letters, numbers, dots, underscores, or hyphens; user/group selectors are not account names.");
    const transport = declaration.transport ?? this.transport;
    const copy = isUserAwareTransport(transport) ? transport.withUser({}) : isEnvAwareTransport(transport) ? transport.withEnv({}) : transport;
    const auth = declaration.auth ?? this.auth;
    const server = new McpServer({ name: this.name, displayName: this.displayName, description: this.description, transport: copy,
      auth: isOAuthAuth(auth) ? { ...auth, account: alias } : auth,
      env: declaration.env ?? this.env, isolation: this.isolation, isolationTimeout: this.isolationTimeout });
    server.accountAlias = alias;
    server.boundEnvReferences = this.accountEnvReferences.get(alias) ?? {};
    server.disconnected = declaration.disconnected === true;
    server.secretResolver = this.secretResolver;
    this.accountServers.set(alias, server);
    return server;
  }

  /** Select one account explicitly or infer a singleton; never choose the first of several. @pk */
  selectedAccount(user: UserContext): McpServer {
    const names = this.accountNames();
    const alias = user.upstreamAccounts?.[this.name] ?? (names.length === 1 ? names[0] : undefined);
    if (!alias) throw new Error(`MCP "${this.name}" requires an explicit upstream account: ${names.join(", ")}.`);
    const declaration = this.accountOptions(alias);
    if (declaration.allowedUsers && (!user.id || !declaration.allowedUsers.includes(user.id))) throw new Error(`Client is not permitted to use MCP "${this.name}" account "${alias}".`);
    return this.account(alias);
  }

  private async prepareAccountUser(user: UserContext): Promise<UserContext> {
    if (!this.accountAlias) return user;
    if (this.disconnected) throw new Error(`MCP "${this.name}" account "${this.accountAlias}" is disconnected. Connect it before use.`);
    const bindings = this.getCredentialBindings();
    if (bindings.length === 0) return user;
    const env: Record<string, string> = {};
    for (const binding of bindings) {
      const value = await this.secretResolver?.(binding.credential.reference);
      if (!value) throw new Error(`Missing upstream credential reference "${binding.credential.reference}".`);
      if (binding.type === "bearer") env.AUTHORIZATION = `Bearer ${value}`;
      else env[binding.type === "header" ? binding.header : binding.env] = value;
    }
    return { ...user, __fentarisUpstreamEnv: { ...(user.__fentarisUpstreamEnv as Record<string, string> | undefined), ...env } };
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
    if ((this.env || upstreamEnv) && !isEnvAwareTransport(transport) && !isUserAwareTransport(transport)) {
      throw new Error(`Transport for server "${this.name}" does not support env injection`);
    }

    if ((this.env || upstreamEnv) && isEnvAwareTransport(transport)) {
      transport = transport.withEnv(resolvedEnv);
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
