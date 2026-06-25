import {
  McpProxy,
  McpServer,
  ConsoleLoggerDriver,
  FentarisConfigError,
  Logger,
  assertValidFentarisConfig,
  defineFentarisConfig,
  fentaris,
  formatFentarisDiagnostics,
  group,
  mcp,
  policy,
  stdio,
  user,
  validateFentarisConfig,
} from "@fentaris/core";
import type {
  FentarisConfigValidationResult,
  FentarisDiagnostic,
  FentarisDiagnosticFormatterOptions,
  LocalToolHandler,
} from "@fentaris/core";
import type {
  FentarisTransport,
  LoggerDriver,
  LogEntry,
  Middleware,
  Policy,
  PolicyDecision,
  ProxyEventHandler,
  ProxyExposureHandle,
  ProxyExposureTransport,
  ProxyMiddleware,
  ProxyRuntime,
  RateLimiter,
  Registry,
  ToolCallRequest,
} from "@fentaris/core/extensions";
import type {
  PluginCapabilities,
  PluginLifecycleHooks,
  PluginLoader,
  PluginManifest,
  PluginRegistry,
} from "@fentaris/core/experimental/plugins";

class CustomTransport implements FentarisTransport {
  async listTools() {
    return {
      tools: [
        {
          name: "search",
          inputSchema: { type: "object" as const },
        },
      ],
    };
  }

  async callTool() {
    return {
      content: [{ type: "text" as const, text: "ok" }],
    };
  }

  async close() {}
}

class CustomExposureTransport implements ProxyExposureTransport<ProxyExposureHandle> {
  async listen(runtime: ProxyRuntime): Promise<ProxyExposureHandle> {
    runtime.logger.info("custom exposure started", { identityRequired: runtime.identityRequired });
    return {
      async close() {},
    };
  }
}

class CustomPolicy implements Policy {
  readonly name = "custom";

  getPermissions() {
    return [{ tool: "*", effect: "allow" as const }];
  }

  evaluate(request: ToolCallRequest): PolicyDecision {
    return {
      allowed: request.toolName !== "dangerous",
      reason: request.toolName === "dangerous" ? "blocked" : undefined,
    };
  }
}

class CustomRegistry implements Registry {
  async getUser(userId: string) {
    return { id: userId, plan: "team" };
  }

  async getSecrets() {
    return { token: "redacted" };
  }

  async getTokens() {
    return null;
  }
}

class CustomRateLimiter implements RateLimiter {
  async consume() {
    return true;
  }

  async checkLimit() {
    return true;
  }

  async recordCall() {}

  async getRemainingCalls() {
    return 99;
  }
}

class CustomLoggerDriver implements LoggerDriver {
  write(entry: LogEntry): void {
    if (entry.level === "error") {
      console.error(entry.message);
    }
  }
}

class CustomPluginLoader implements PluginLoader {
  async load(name: string): Promise<PluginManifest> {
    return { name, version: "0.0.0" };
  }
}

class CustomPluginRegistry implements PluginRegistry {
  private plugins = new Map<string, PluginManifest>();

  async register(manifest: PluginManifest): Promise<void> {
    this.plugins.set(manifest.name, manifest);
  }

  getPlugin(name: string) {
    const manifest = this.plugins.get(name);
    return manifest ? { manifest, status: "installed" as const } : undefined;
  }

  listPlugins() {
    return [...this.plugins.values()].map((manifest) => ({ manifest, status: "installed" as const }));
  }
}

const pluginCapabilities: PluginCapabilities = { requiresAuth: true, requiredPermissions: ["tools:call"] };
const pluginLifecycle: PluginLifecycleHooks = {
  async onActivate() {},
};

const middleware: ProxyMiddleware = async (ctx, next) => {
  const remaining = ctx.rateLimiter ? await ctx.rateLimiter.getRemainingCalls(ctx.subject?.id ?? "anonymous") : undefined;
  ctx.log.info("middleware", { operation: ctx.operation });
  ctx.log.debug("rate limit", { remaining });
  return next();
};

const typedMiddleware: Middleware = middleware;

const eventHandler: ProxyEventHandler = ({ ctx, durationMs }) => {
  ctx.log.info("event", { operation: ctx.operation, durationMs });
};

const application = fentaris({
  servers: [
    mcp("github", {
      transport: stdio({ command: "github-mcp-server" }),
    }),
    mcp("custom", { transport: new CustomTransport() }),
  ],
  groups: [
    group({
      id: "admins",
      users: [user("u_123")],
      policy: policy("admins").mcp("*").allow("*"),
    }),
  ],
});

application.policy("readonly").mcp("github").allow("read");
application.usePolicy("readonly");
application.usePolicy(policy("global").mcp("github").allow("read"));
application.server("docs", { transport: stdio({ command: "docs-mcp-server" }) }).use(typedMiddleware);
application.group("guests").users(user("guest")).policy("readonly").mcp("github").use(typedMiddleware);
application.local("workspace")
  .tool("status", { inputSchema: { type: "object" } }, ((ctx, params) => {
    ctx.log.info("local status", { operation: ctx.operation, tool: ctx.tool?.name });
    return { content: [{ type: "text", text: String(params.arguments?.verbose ?? false) }] };
  }) satisfies LocalToolHandler)
  .resource("config://current", { name: "Current config" }, (ctx, params) => ({
    contents: [{ uri: params.uri, text: ctx.server?.name ?? "workspace" }],
  }))
  .resourceTemplate("config://projects/{id}", { name: "Project config" }, (_ctx, params) => ({
    contents: [{ uri: params.uri, text: "project" }],
  }))
  .prompt("review_pr", { arguments: [{ name: "diff" }] }, (_ctx, params) => ({
    messages: [{ role: "user", content: { type: "text", text: String(params.arguments?.diff ?? "") } }],
  }))
  .completion({ type: "ref/prompt", name: "review_pr" }, (_ctx, params) => ({
    completion: { values: [params.argument.value] },
  }));

const configFirstApplication = fentaris({
  groups: [
    group({
      id: "guests",
      users: [user("guest")],
      policy: policy("readonly").mcp("github").allow("read"),
    }),
  ],
});
void configFirstApplication;

const typedConfig = defineFentarisConfig({
  servers: [
    mcp("typed", {
      transport: new CustomTransport(),
    }),
  ],
});

const validation: FentarisConfigValidationResult = validateFentarisConfig(typedConfig);
const diagnostics: FentarisDiagnostic[] = validation.diagnostics;
const formatterOptions: FentarisDiagnosticFormatterOptions = { format: "plain", color: "never", unicode: "never" };
formatFentarisDiagnostics(diagnostics, formatterOptions);
assertValidFentarisConfig(typedConfig);
new FentarisConfigError(diagnostics).format({ format: "compact" });

const proxy = new McpProxy({
  servers: [new McpServer({ name: "custom", transport: new CustomTransport() })],
  policy: new CustomPolicy(),
  registry: new CustomRegistry(),
  logger: new Logger({ driver: new CustomLoggerDriver() }),
});

proxy.use(typedMiddleware);
proxy.on("tool:after", eventHandler);
proxy.listen(new CustomExposureTransport());

new ConsoleLoggerDriver();
new CustomRateLimiter();
new CustomPluginLoader();
new CustomPluginRegistry();
void pluginCapabilities;
void pluginLifecycle;
void application;
