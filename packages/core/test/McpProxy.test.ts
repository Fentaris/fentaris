import { describe, expect, it, vi } from "vitest";
import type {
  CallToolRequest,
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "../src/logger.js";
import { health } from "../src/health/index.js";
import { McpProxy, fentaris } from "../src/proxy/McpProxy.js";
import { McpServer } from "../src/server/McpServer.js";
import { FentarisErrorCode } from "../src/errors.js";
import { Policy, group, policy, user } from "../src/governance.js";
import {
  fromProxyPromptName,
  fromProxyResourceTemplateUri,
  fromProxyResourceUri,
  fromProxyToolName,
  toProxyPromptName,
  toProxyResourceTemplateUri,
  toProxyResourceUri,
  toProxyToolName,
} from "../src/nameMapping.js";
import type { LogEntry, LoggerDriver } from "../src/logger.js";
import type { FentarisTransport } from "../src/types.js";
import type { RuntimeEvent } from "../src/profiler/index.js";

class MemoryLogDriver implements LoggerDriver {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

class MockTransport implements FentarisTransport {
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => {
    return {
      content: [{ type: "text", text: `called:${params.name}` }],
    };
  });

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => {
    return {
      tools: [
        {
          name: "create_issue",
          description: "Create an issue",
          inputSchema: { type: "object" },
        },
      ],
    };
  });

  readonly close = vi.fn(async (): Promise<void> => {});
}

class SlowCloseTransport extends MockTransport {
  override readonly close = vi.fn(async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

class FeatureTransport extends MockTransport {
  readonly listResources = vi.fn(async (): Promise<ListResourcesResult> => {
    return {
      resources: [
        {
          uri: "file:///shared.md",
          name: "shared",
          title: "Shared",
          description: "Shared resource",
          mimeType: "text/markdown",
          size: 42,
          _meta: { upstream: true },
        },
      ],
    };
  });

  readonly readResource = vi.fn(async (params: ReadResourceRequest["params"]): Promise<ReadResourceResult> => {
    return {
      contents: [
        {
          uri: params.uri,
          text: "resource text",
          mimeType: "text/markdown",
          _meta: { content: true },
        },
      ],
      _meta: { read: true },
    };
  });

  readonly listResourceTemplates = vi.fn(async (): Promise<ListResourceTemplatesResult> => {
    return {
      resourceTemplates: [
        {
          uriTemplate: "file:///{path}",
          name: "file",
          description: "File template",
          mimeType: "text/plain",
          _meta: { template: true },
        },
      ],
    };
  });

  readonly listPrompts = vi.fn(async (): Promise<ListPromptsResult> => {
    return {
      prompts: [
        {
          name: "summarize",
          title: "Summarize",
          description: "Summarize content",
          arguments: [{ name: "topic", required: true }],
          _meta: { prompt: true },
        },
      ],
    };
  });

  readonly getPrompt = vi.fn(async (params: GetPromptRequest["params"]): Promise<GetPromptResult> => {
    return {
      description: "Prompt response",
      messages: [
        {
          role: "user",
          content: { type: "text", text: `prompt:${params.name}:${params.arguments?.topic ?? ""}` },
        },
      ],
      _meta: { got: true },
    };
  });

  readonly complete = vi.fn(async (params: CompleteRequest["params"]): Promise<CompleteResult> => {
    return {
      completion: {
        values: [`${params.ref.type}:${"name" in params.ref ? params.ref.name : params.ref.uri}:${params.argument.value}`],
        total: 1,
        hasMore: false,
      },
      _meta: { complete: true },
    };
  });
}

describe("proxied tool names", () => {
  it("round-trips server and tool names", () => {
    const proxyName = toProxyToolName("github", "create_issue");

    expect(proxyName).toBe("github__create_issue");
    expect(fromProxyToolName(proxyName)).toEqual({
      serverName: "github",
      toolName: "create_issue",
    });
  });

  it("rejects invalid server names and proxy tool names", () => {
    expect(() => toProxyToolName("bad__server", "tool")).toThrow(/cannot include/);
    expect(() => fromProxyToolName("missing-separator")).toThrow(/Invalid proxied tool name/);
  });
});

describe("proxied prompt names", () => {
  it("round-trips server and prompt names", () => {
    const proxyName = toProxyPromptName("docs", "summarize_page");

    expect(proxyName).toBe("docs__summarize_page");
    expect(fromProxyPromptName(proxyName)).toEqual({
      serverName: "docs",
      promptName: "summarize_page",
    });
  });

  it("keeps prompt names with separators unambiguous", () => {
    const proxyName = toProxyPromptName("docs", "team__summary");

    expect(fromProxyPromptName(proxyName)).toEqual({
      serverName: "docs",
      promptName: "team__summary",
    });
  });

  it("rejects invalid prompt mappings", () => {
    expect(() => toProxyPromptName("bad__server", "prompt")).toThrow(/cannot include/);
    expect(() => toProxyPromptName("docs", "")).toThrow(/prompt name cannot be empty/);
    expect(() => fromProxyPromptName("missing-separator")).toThrow(/Invalid proxied prompt name/);
    expect(() => fromProxyPromptName("docs__")).toThrow(/Invalid proxied prompt name/);
  });
});

describe("proxied resource URIs", () => {
  it("round-trips resource URIs", () => {
    const proxyUri = toProxyResourceUri("files", "file:///tmp/readme.md?rev=1");

    expect(proxyUri).toBe("fentaris://resources/files/file%3A%2F%2F%2Ftmp%2Freadme.md%3Frev%3D1");
    expect(fromProxyResourceUri(proxyUri)).toEqual({
      serverName: "files",
      uri: "file:///tmp/readme.md?rev=1",
    });
  });

  it("round-trips resource template URIs", () => {
    const proxyTemplate = toProxyResourceTemplateUri("repo", "repo://{owner}/{name}/issues/{id}");

    expect(proxyTemplate).toBe("fentaris://resource-templates/repo/repo%3A%2F%2F%7Bowner%7D%2F%7Bname%7D%2Fissues%2F%7Bid%7D");
    expect(fromProxyResourceTemplateUri(proxyTemplate)).toEqual({
      serverName: "repo",
      uriTemplate: "repo://{owner}/{name}/issues/{id}",
    });
  });

  it("rejects invalid resource mappings", () => {
    expect(() => toProxyResourceUri("bad__server", "file:///tmp/readme.md")).toThrow(/cannot include/);
    expect(() => toProxyResourceUri("files", "")).toThrow(/resource URI cannot be empty/);
    expect(() => fromProxyResourceUri("file:///tmp/readme.md")).toThrow(/Invalid proxied resource URI/);
    expect(() => fromProxyResourceUri("fentaris://resources/files")).toThrow(/Invalid proxied resource URI/);
    expect(() => fromProxyResourceUri("fentaris://resources/files/file/raw")).toThrow(/raw path separators/);
    expect(() => fromProxyResourceTemplateUri("fentaris://resources/files/file%3A%2F%2Fa")).toThrow(
      /Invalid proxied resource template URI/,
    );
  });
});

describe("McpProxy", () => {
  it("exposes lifecycle state and idempotent stop behavior", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    expect(proxy.state().state).toBe("created");

    await proxy.stop();
    await proxy.stop();

    expect(proxy.state().state).toBe("stopped");
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("starts idempotently while startup is in progress", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });

    const first = proxy.start({ port: 0 });
    const second = proxy.start({ port: 0 });
    await Promise.all([first, second]);
    expect(proxy.state().state).toBe("ready");

    await proxy.stop();
  });

  it("normalizes shutdown timeout failures", async () => {
    const transport = new SlowCloseTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    await proxy.start({ port: 0 });
    await expect(proxy.stop({ shutdownTimeoutMs: 1 })).rejects.toMatchObject({
      code: "FENTARIS_TIMEOUT_ERROR",
    });
    expect(proxy.state().state).toBe("failed");
  });

  it("restores readiness after degraded health checks recover", async () => {
    let healthy = false;
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
      health: health({ include: ["runtime"] }).check("transient", () => (healthy ? "ok" : "degraded")),
    });

    await proxy.start({ port: 0 });

    await expect(proxy.health()).resolves.toMatchObject({ status: "degraded" });
    expect(proxy.state().state).toBe("degraded");

    healthy = true;
    await expect(proxy.health()).resolves.toMatchObject({ status: "ok" });
    expect(proxy.state().state).toBe("ready");

    await proxy.stop();
  });

  it("normalizes builder and object health configuration", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
      health: health({ include: ["runtime"] })
        .timeout(50)
        .check("database", () => ({ status: "ok", metadata: { region: "local" } })),
    });

    const report = await proxy.health();

    expect(report.status).toBe("degraded");
    expect(report.checks.map((check) => check.name)).toContain("database");
    expect(report.checks.find((check) => check.name === "database")?.metadata).toEqual({ region: "local" });
  });

  it("runs object-configured built-in health checks", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
      health: { checks: true, include: ["runtime", "mcp", "transport"] },
    });

    const report = await proxy.health();

    expect(report.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["runtime.lifecycle", "mcp.github.availability", "mcp.catalog", "transport.exposure"]),
    );
    expect(report.status).toBe("degraded");
  });

  it("normalizes custom health check errors and timeouts", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
      health: health()
        .check("throws", () => {
          throw new Error("database unavailable");
        })
        .check("slow", async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { status: "ok" };
        }, { timeoutMs: 1 }),
    });

    const report = await proxy.health();

    expect(report.status).toBe("down");
    expect(report.checks.find((check) => check.name === "throws")?.status).toBe("degraded");
    expect(report.checks.find((check) => check.name === "slow")?.status).toBe("down");
  });

  it("exposes safe server and group health context helpers", async () => {
    const engineering = group({
      id: "engineering",
      users: [user("ada")],
      policy: Policy.allowAll(),
      servers: [new McpServer({ name: "linear", transport: new MockTransport() })],
    });
    const proxy = new McpProxy({
      groups: [engineering],
      health: health()
        .include(["groups"])
        .check("linear-ping", (ctx) => ctx.mcp("linear").ping())
        .check("engineering-servers", (ctx) => ({
          status: "ok",
          metadata: { servers: ctx.group("engineering").servers() },
        }))
        .check("unknown-ping", (ctx) => ctx.mcp("missing").ping()),
    });

    const report = await proxy.health();

    expect(report.checks.find((check) => check.name === "linear-ping")?.status).toBe("ok");
    expect(report.checks.find((check) => check.name === "unknown-ping")?.status).toBe("unknown");
    expect(report.checks.find((check) => check.name === "engineering-servers")?.metadata).toEqual({
      servers: [{ name: "linear", displayName: "linear" }],
    });
  });

  it("emits lifecycle and health profiler events", async () => {
    const events: RuntimeEvent[] = [];
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
      health: health().check("custom", () => "ok"),
      profiler: {
        level: "debug",
        track: ["lifecycle", "health", "timeouts", "errors"],
        sink: (event) => events.push(event),
      },
    });

    await proxy.health();
    await proxy.stop();

    expect(events.map((event) => event.name)).toEqual(
      expect.arrayContaining(["health.check.start", "health.check.success", "health.status", "runtime.stop"]),
    );
  });

  it("aggregates upstream tools with server namespaces", async () => {
    const githubTransport = new MockTransport();
    const notionTransport = new MockTransport();
    const proxy = new McpProxy({
      servers: [
        new McpServer({ name: "github", transport: githubTransport }),
        new McpServer({ name: "notion", displayName: "Notion API", transport: notionTransport }),
      ],
    });

    const result = await proxy.listTools();

    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((tool) => tool.name)).toEqual(["github__create_issue", "notion__create_issue"]);
    expect(result.tools[1]?.title).toBe("Notion API: create_issue");
    expect(result.tools[1]?.description).toBe("[Notion API] Create an issue");
  });

  it("routes namespaced tool calls to the original upstream tool name", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    const result = await proxy.callTool({
      name: "github__create_issue",
      arguments: { title: "Bug" },
    });

    expect(result.content).toEqual([{ type: "text", text: "called:create_issue" }]);
    expect(transport.callTool).toHaveBeenCalledWith({
      name: "create_issue",
      arguments: { title: "Bug" },
    });
  });

  it("aggregates resources with proxied URIs and preserves metadata", async () => {
    const githubTransport = new FeatureTransport();
    const notionTransport = new FeatureTransport();
    const proxy = new McpProxy({
      servers: [
        new McpServer({ name: "github", transport: githubTransport }),
        new McpServer({ name: "notion", transport: notionTransport }),
      ],
    });

    const result = await proxy.listResources();

    expect(result.resources).toEqual([
      expect.objectContaining({
        uri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md",
        name: "shared",
        title: "Shared",
        description: "Shared resource",
        mimeType: "text/markdown",
        size: 42,
        _meta: { upstream: true },
      }),
      expect.objectContaining({
        uri: "fentaris://resources/notion/file%3A%2F%2F%2Fshared.md",
        name: "shared",
      }),
    ]);
  });

  it("routes proxied resource reads and rewrites returned content URIs", async () => {
    const transport = new FeatureTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    const result = await proxy.readResource({
      uri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md",
    });

    expect(transport.readResource).toHaveBeenCalledWith({ uri: "file:///shared.md" });
    expect(result).toEqual({
      contents: [
        {
          uri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md",
          text: "resource text",
          mimeType: "text/markdown",
          _meta: { content: true },
        },
      ],
      _meta: { read: true },
    });
  });

  it("aggregates resource templates with proxied URI templates", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new FeatureTransport() })],
    });

    const result = await proxy.listResourceTemplates();

    expect(result.resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "fentaris://resource-templates/github/file%3A%2F%2F%2F%7Bpath%7D",
        name: "file",
        description: "File template",
        mimeType: "text/plain",
        _meta: { template: true },
      }),
    ]);
  });

  it("aggregates prompts with proxied names and preserves prompt metadata", async () => {
    const githubTransport = new FeatureTransport();
    const notionTransport = new FeatureTransport();
    const proxy = new McpProxy({
      servers: [
        new McpServer({ name: "github", transport: githubTransport }),
        new McpServer({ name: "notion", transport: notionTransport }),
      ],
    });

    const result = await proxy.listPrompts();

    expect(result.prompts).toEqual([
      expect.objectContaining({
        name: "github__summarize",
        title: "Summarize",
        description: "Summarize content",
        arguments: [{ name: "topic", required: true }],
        _meta: { prompt: true },
      }),
      expect.objectContaining({
        name: "notion__summarize",
      }),
    ]);
  });

  it("routes proxied prompt get requests to the upstream prompt name", async () => {
    const transport = new FeatureTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    const result = await proxy.getPrompt({
      name: "github__summarize",
      arguments: { topic: "mcp" },
    });

    expect(transport.getPrompt).toHaveBeenCalledWith({
      name: "summarize",
      arguments: { topic: "mcp" },
    });
    expect(result).toMatchObject({
      messages: [{ content: { text: "prompt:summarize:mcp" } }],
      _meta: { got: true },
    });
  });

  it("routes completion for proxied prompt and resource-template references", async () => {
    const transport = new FeatureTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    await expect(
      proxy.complete({
        ref: { type: "ref/prompt", name: "github__summarize" },
        argument: { name: "topic", value: "m" },
      }),
    ).resolves.toMatchObject({
      completion: { values: ["ref/prompt:summarize:m"] },
      _meta: { complete: true },
    });
    await expect(
      proxy.complete({
        ref: { type: "ref/resource", uri: "fentaris://resource-templates/github/file%3A%2F%2F%2F%7Bpath%7D" },
        argument: { name: "path", value: "r" },
      }),
    ).resolves.toMatchObject({
      completion: { values: ["ref/resource:file:///{path}:r"] },
      _meta: { complete: true },
    });
    expect(transport.complete).toHaveBeenNthCalledWith(1, {
      ref: { type: "ref/prompt", name: "summarize" },
      argument: { name: "topic", value: "m" },
    });
    expect(transport.complete).toHaveBeenNthCalledWith(2, {
      ref: { type: "ref/resource", uri: "file:///{path}" },
      argument: { name: "path", value: "r" },
    });
  });

  it("filters listed resources, resource templates, and prompts through capability policy", async () => {
    const transport = new FeatureTransport();
    const proxy = new McpProxy({
      policy: new Policy({ name: "capabilities" })
        .mcp("github")
        .allowCapability({ operation: "resources:list", targetKind: "resource" })
        .mcp("github")
        .denyCapability({ operation: "resource:read", target: "file:///shared.md", targetKind: "resource" })
        .mcp("github")
        .allowCapability({ operation: "resource-templates:list", targetKind: "resourceTemplate" })
        .mcp("github")
        .denyCapability({ operation: "resource-templates:list", target: "file:///{path}", targetKind: "resourceTemplate" })
        .mcp("github")
        .allowCapability({ operation: "prompts:list", targetKind: "prompt" })
        .mcp("github")
        .denyCapability({ operation: "prompt:get", target: "summarize", targetKind: "prompt" }),
      servers: [new McpServer({ name: "github", transport })],
    });

    await expect(proxy.listResources()).resolves.toEqual({ resources: [] });
    await expect(proxy.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
    await expect(proxy.listPrompts()).resolves.toEqual({ prompts: [] });
  });

  it("rejects denied resource, prompt, and completion operations before forwarding upstream", async () => {
    const transport = new FeatureTransport();
    const proxy = new McpProxy({
      policy: new Policy({ name: "blocked" })
        .mcp("github")
        .denyCapability({ operation: "resource:read", target: "file:///shared.md", targetKind: "resource" })
        .mcp("github")
        .denyCapability({ operation: "prompt:get", target: "summarize", targetKind: "prompt" })
        .mcp("github")
        .denyCapability({ operation: "completion:complete", target: "summarize", targetKind: "completion" }),
      servers: [new McpServer({ name: "github", transport })],
    });

    await expect(proxy.readResource({ uri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md" })).rejects.toMatchObject({
      code: FentarisErrorCode.PolicyDenied,
      message: 'Operation "resource:read" denied by policy "blocked"',
    });
    await expect(proxy.getPrompt({ name: "github__summarize" })).rejects.toMatchObject({
      code: FentarisErrorCode.PolicyDenied,
      message: 'Operation "prompt:get" denied by policy "blocked"',
    });
    await expect(
      proxy.complete({
        ref: { type: "ref/prompt", name: "github__summarize" },
        argument: { name: "topic", value: "m" },
      }),
    ).rejects.toMatchObject({
      code: FentarisErrorCode.PolicyDenied,
      message: 'Operation "completion:complete" denied by policy "blocked"',
    });
    expect(transport.readResource).not.toHaveBeenCalled();
    expect(transport.getPrompt).not.toHaveBeenCalled();
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it("builds capability contexts and dispatches middleware for non-tool operations", async () => {
    const transport = new FeatureTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });
    const seen: unknown[] = [];

    proxy.use((ctx, next) => {
      seen.push({
        operation: ctx.operation,
        server: ctx.server?.name,
        resource: ctx.resource,
        prompt: ctx.prompt,
        completion: ctx.completion,
        hasUser: Boolean(ctx.user),
        hasAuth: Boolean(ctx.auth),
        hasPolicy: Boolean(ctx.policy),
        hasCredentials: Boolean(ctx.credentials),
        hasRaw: Boolean(ctx.raw),
        hasLogger: Boolean(ctx.log),
      });
      return next();
    });

    await proxy.readResource({ uri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md" });
    await proxy.getPrompt({ name: "github__summarize", arguments: { topic: "mcp" } });
    await proxy.complete({
      ref: { type: "ref/prompt", name: "github__summarize" },
      argument: { name: "topic", value: "m" },
    });

    expect(seen).toEqual([
      expect.objectContaining({
        operation: "resource:read",
        server: "github",
        resource: {
          uri: "file:///shared.md",
          proxyUri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md",
        },
        hasUser: true,
        hasAuth: true,
        hasPolicy: true,
        hasCredentials: true,
        hasRaw: true,
        hasLogger: true,
      }),
      expect.objectContaining({
        operation: "prompt:get",
        server: "github",
        prompt: { name: "summarize", proxyName: "github__summarize" },
      }),
      expect.objectContaining({
        operation: "completion:complete",
        server: "github",
        completion: {
          refType: "ref/prompt",
          target: "summarize",
          proxyTarget: "github__summarize",
          argumentName: "topic",
        },
      }),
    ]);
  });

  it("lets middleware and operation routes deny non-tool operations before upstream forwarding", async () => {
    const transport = new FeatureTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    proxy.use((ctx, next) => {
      if (ctx.operation === "resource:read") {
        return ctx.fail(FentarisErrorCode.PolicyDenied, `blocked:${ctx.resource?.uri}`);
      }
      if (ctx.operation === "completion:complete") {
        return ctx.fail(FentarisErrorCode.PolicyDenied, `blocked:${ctx.completion?.target}`);
      }
      return next();
    });
    proxy.operation("prompt:get", (ctx) => ctx.fail(FentarisErrorCode.PolicyDenied, `blocked:${ctx.prompt?.name}`));

    await expect(proxy.readResource({ uri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md" })).rejects.toMatchObject({
      code: FentarisErrorCode.PolicyDenied,
      message: "blocked:file:///shared.md",
    });
    await expect(proxy.getPrompt({ name: "github__summarize" })).rejects.toMatchObject({
      code: FentarisErrorCode.PolicyDenied,
      message: "blocked:summarize",
    });
    await expect(
      proxy.complete({
        ref: { type: "ref/prompt", name: "github__summarize" },
        argument: { name: "topic", value: "m" },
      }),
    ).rejects.toMatchObject({
      code: FentarisErrorCode.PolicyDenied,
      message: "blocked:summarize",
    });
    expect(transport.readResource).not.toHaveBeenCalled();
    expect(transport.getPrompt).not.toHaveBeenCalled();
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it("emits capability events and audit logs for allowed and denied operations", async () => {
    const transport = new FeatureTransport();
    const driver = new MemoryLogDriver();
    const proxy = new McpProxy({
      logger: new Logger({ level: "debug", driver }),
      policy: new Policy({ name: "audit" })
        .mcp("github")
        .allowCapability({ operation: "resource:read", target: "file:///shared.md", targetKind: "resource" })
        .mcp("github")
        .denyCapability({ operation: "prompt:get", target: "summarize", targetKind: "prompt" }),
      servers: [new McpServer({ name: "github", transport })],
    });
    const events: string[] = [];

    proxy.on("resource:success", ({ ctx, result, durationMs }) => {
      events.push(`resource:success:${ctx.resource?.uri}:${Boolean(result)}:${typeof durationMs}`);
    });
    proxy.on("resource:after", ({ success }) => {
      events.push(`resource:after:${success}`);
    });
    proxy.on("prompt:error", ({ ctx, error }) => {
      events.push(`prompt:error:${ctx.prompt?.name}:${error?.message}`);
    });
    proxy.on("prompt:after", ({ success }) => {
      events.push(`prompt:after:${success}`);
    });

    await proxy.readResource({ uri: "fentaris://resources/github/file%3A%2F%2F%2Fshared.md" }, { id: "alice" });
    await expect(proxy.getPrompt({ name: "github__summarize" }, { id: "alice" })).rejects.toMatchObject({
      code: FentarisErrorCode.PolicyDenied,
    });

    expect(events).toEqual([
      "resource:success:file:///shared.md:true:number",
      "resource:after:true",
      'prompt:error:summarize:Operation "prompt:get" denied by policy "audit"',
      "prompt:after:false",
    ]);
    expect(driver.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "MCP capability operation",
          context: expect.objectContaining({
            operation: "resource:read",
            serverName: "github",
            target: "file:///shared.md",
          }),
          metadata: expect.objectContaining({
            allowed: true,
            event: "resource:read.success",
          }),
        }),
        expect.objectContaining({
          message: "MCP capability operation failed",
          context: expect.objectContaining({
            operation: "prompt:get",
            serverName: "github",
            target: "summarize",
          }),
          metadata: expect.objectContaining({
            allowed: false,
            event: "prompt:get.failure",
          }),
        }),
      ]),
    );
  });

  it("rejects unknown routed resource and prompt identifiers", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new FeatureTransport() })],
    });

    await expect(proxy.readResource({ uri: "fentaris://resources/missing/file%3A%2F%2F%2Fshared.md" })).rejects.toThrow(
      /Unknown MCP server/,
    );
    await expect(proxy.getPrompt({ name: "missing__summarize" })).rejects.toThrow(/Unknown MCP server/);
  });

  it("runs middleware before forwarding a tool call", async () => {
    const transport = new MockTransport();
    const driver = new MemoryLogDriver();
    const proxy = new McpProxy({
      logger: new Logger({ level: "debug", driver }),
      user: { id: "user-1" },
      servers: [new McpServer({ name: "github", transport })],
    });
    const seen: string[] = [];

    proxy.use(async (req, ctx, next) => {
      seen.push(`${ctx.user.id}:${req.serverName}:${req.toolName}`);
      ctx.log.info("observed");
      return next();
    });

    const result = await proxy.callTool({ name: "github__create_issue" }, { id: "user-1" });

    expect(result.isError).toBeUndefined();
    expect(seen).toEqual(["user-1:github:create_issue"]);
    expect(transport.callTool).toHaveBeenCalledOnce();
    expect(driver.entries[0]).toMatchObject({
      level: "info",
      message: "observed",
      context: {
        userId: "user-1",
        serverName: "github",
        toolName: "create_issue",
        proxyToolName: "github__create_issue",
      },
    });
  });

  it("builds a unified context for new middleware and shares request-local state", async () => {
    const transport = new MockTransport();
    const driver = new MemoryLogDriver();
    const proxy = new McpProxy({
      logger: new Logger({ level: "debug", driver }),
      user: { id: "user-1" },
      servers: [new McpServer({ name: "github", transport })],
    });
    const seen: unknown[] = [];

    proxy.use(async (ctx, next) => {
      ctx.state.startedAt = 123;
      ctx.inject("Use read-only mode");
      ctx.log.info("validated");
      seen.push({
        operation: ctx.operation,
        subjectId: ctx.subject?.id,
        authUserId: ctx.auth.userId,
        server: ctx.server?.name,
        tool: ctx.tool?.name,
        proxyTool: ctx.tool?.proxyName,
        args: ctx.args,
        responseAlias: ctx.response === ctx.res,
        userAlias: ctx.user.id,
        credentialSources: ctx.credentials.sources,
      });
      return next();
    });
    proxy.use((ctx, next) => {
      seen.push(ctx.state.startedAt);
      return next();
    });

    const result = await proxy.callTool({ name: "github__create_issue", arguments: { title: "Bug" } }, { id: "user-1" });

    expect(result.content).toEqual([
      { type: "text", text: "called:create_issue" },
      { type: "text", text: "Use read-only mode" },
    ]);
    expect(seen).toEqual([
      {
        operation: "tool:call",
        subjectId: undefined,
        authUserId: "user-1",
        server: "github",
        tool: "create_issue",
        proxyTool: "github__create_issue",
        args: { title: "Bug" },
        responseAlias: true,
        userAlias: "user-1",
        credentialSources: [],
      },
      123,
    ]);
    expect(driver.entries[0]).toMatchObject({
      message: "validated",
      context: {
        operation: "tool:call",
        userId: "user-1",
        subjectId: "user-1",
        serverName: "github",
        toolName: "create_issue",
        proxyToolName: "github__create_issue",
      },
    });
    expect(JSON.stringify(seen)).not.toContain("__fentarisUpstreamEnv");
  });

  it("runs filtered call hooks before middleware", async () => {
    const transport = new MockTransport();
    const driver = new MemoryLogDriver();
    const proxy = new McpProxy({
      logger: new Logger({ level: "debug", driver }),
      servers: [new McpServer({ name: "notion", transport })],
    });
    const seen: string[] = [];

    proxy.on("call", { server: "notion" }, (req, ctx) => {
      seen.push(`hook:${req.serverName}:${req.toolName}`);
      ctx.log.annotate("integration_type", "enterprise_api");
      ctx.log.setTag("billing_unit", "marketing_dept");
      ctx.log.info("hooked");
    });
    proxy.use((req, ctx, next) => {
      seen.push(`middleware:${req.serverName}:${req.toolName}`);
      return next();
    });

    const result = await proxy.callTool({ name: "notion__read_page" });

    expect(result.content).toEqual([{ type: "text", text: "called:read_page" }]);
    expect(seen).toEqual(["hook:notion:read_page", "middleware:notion:read_page"]);
    expect(driver.entries[0]).toMatchObject({
      message: "hooked",
      metadata: {
        integration_type: "enterprise_api",
        "tag.billing_unit": "marketing_dept",
      },
    });
  });

  it("lets call hooks short-circuit matched calls", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "prod-db", transport })],
    });

    proxy.on("call", { server: "prod-db", tool: "drop_table" }, (_, ctx) => {
      return ctx.res.deny("blocked by hook");
    });

    const result = await proxy.callTool({ name: "prod-db__drop_table" });

    expect(result).toEqual({
      content: [{ type: "text", text: "blocked by hook" }],
      isError: true,
    });
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("transforms listed tools with onListTools hooks", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });

    proxy.onListTools((tools, ctx) => {
      expect(ctx.user.id).toBe("beta-user");
      return [
        ...tools,
        {
          name: "experimental_tool",
          description: "Only for testers",
          inputSchema: { type: "object" },
        },
      ];
    });

    const result = await proxy.listTools(undefined, { id: "beta-user" });

    expect(result.tools.map((tool) => tool.name)).toEqual(["github__create_issue", "experimental_tool"]);
  });

  it("injects guidance into successful tool responses", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });

    proxy.use((_, ctx, next) => {
      ctx.res.injectToAgent("Try a narrower query next.");
      return next();
    });

    const result = await proxy.callTool({ name: "github__create_issue" });

    expect(result.content).toEqual([
      { type: "text", text: "called:create_issue" },
      { type: "text", text: "Try a narrower query next." },
    ]);
  });

  it("lets response error handlers inject guidance when upstream fails", async () => {
    class FailingTransport extends MockTransport {
      override readonly callTool = vi.fn(async (): Promise<CallToolResult> => {
        throw new Error("upstream overloaded");
      });
    }

    const transport = new FailingTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    proxy.use((_, ctx, next) => {
      ctx.res.on("error", (error) => {
        ctx.log.error("Upstream failed", { error: error.message });
        ctx.res.injectToAgent("The server is overloaded. Reduce query complexity and retry.");
      });
      return next();
    });

    const result = await proxy.callTool({ name: "github__create_issue" });

    expect(result).toEqual({
      content: [{ type: "text", text: "The server is overloaded. Reduce query complexity and retry." }],
      isError: true,
    });
  });

  it("lets middleware deny a tool call without touching the upstream", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "prod-db", transport })],
    });

    proxy.use((_, ctx) => {
      return ctx.res.deny("blocked");
    });

    const result = await proxy.callTool({ name: "prod-db__drop_table" });

    expect(result).toEqual({
      content: [{ type: "text", text: "blocked" }],
      isError: true,
    });
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("registers upstream MCP servers through the non config-first API", async () => {
    const transport = new MockTransport();
    const app = fentaris();
    const github = app.mcp({ name: "github", transport });
    const seen: string[] = [];

    github.tool("create_issue", (ctx, next) => {
      seen.push(`${ctx.server?.name}:${ctx.tool?.name}`);
      return next();
    });

    const ping = await github.ping();
    const healthReport = await github.health();
    const result = await app.callTool({ name: "github__create_issue" });

    expect(ping.status).toBe("ok");
    expect(healthReport.status).toBe("ok");
    expect(result).toMatchObject({ content: [{ type: "text", text: "called:create_issue" }] });
    expect(seen).toEqual(["github:create_issue"]);
  });

  it("allows policies to reference MCP servers registered after construction when configured", async () => {
    const transport = new MockTransport();
    const app = fentaris({
      validation: { allowRuntimePolicyServerReferences: true },
      groups: [
        group({
          id: "engineering",
          users: [user("alice")],
          policy: policy("engineering").mcp("github").allow("*"),
        }),
      ],
    });

    app.mcp("github", { transport });

    const result = await app.callTool({ name: toProxyToolName("github", "create_issue") }, { id: "alice" });

    expect(result).toMatchObject({ content: [{ type: "text", text: "called:create_issue" }] });
  });

  it("routes matching public tool patterns in registration order", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });
    const seen: string[] = [];

    proxy.use((ctx, next) => {
      seen.push(`global:${ctx.server?.name}`);
      return next();
    });
    proxy.mcp("github").use((ctx, next) => {
      seen.push(`server:${ctx.server?.name}`);
      return next();
    });
    proxy.tool("github.*", (ctx, next) => {
      seen.push(`server-wildcard:${ctx.tool?.name}`);
      return next();
    });
    proxy.tool("*.create_*", (ctx) => {
      seen.push(`tool-wildcard:${ctx.tool?.name}`);
      return ctx.deny("blocked by route");
    });
    proxy.tool("github.create_issue", () => {
      seen.push("unreachable");
    });

    const result = await proxy.callTool({ name: "github__create_issue" });

    expect(result).toEqual({
      content: [{ type: "text", text: "blocked by route" }],
      isError: true,
    });
    expect(seen).toEqual(["global:github", "server:github", "server-wildcard:create_issue", "tool-wildcard:create_issue"]);
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("validates invalid public tool patterns", () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });

    expect(() => proxy.tool("github__create_issue", () => undefined)).toThrow(/dot notation/);
    expect(() => proxy.tool("github", () => undefined)).toThrow(/server.tool/);
    expect(() => proxy.mcp("github").tool("notion.create_issue", () => undefined)).toThrow(/cannot target server/);
  });

  it("keeps MCP handles scoped to their upstream", async () => {
    const githubTransport = new MockTransport();
    const notionTransport = new MockTransport();
    const proxy = new McpProxy({
      servers: [
        new McpServer({ name: "github", transport: githubTransport }),
        new McpServer({ name: "notion", transport: notionTransport }),
      ],
    });
    const seen: string[] = [];

    proxy.mcp("github").tool("create_issue", (ctx, next) => {
      seen.push(`${ctx.server?.name}:${ctx.tool?.name}`);
      return next();
    });

    await proxy.callTool({ name: "notion__create_issue" });
    await proxy.callTool({ name: "github__create_issue" });

    expect(seen).toEqual(["github:create_issue"]);
    expect(notionTransport.callTool).toHaveBeenCalledOnce();
    expect(githubTransport.callTool).toHaveBeenCalledOnce();
  });

  it("emits unified tool events and filtered MCP-scoped events", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });
    const events: string[] = [];

    proxy.on("tool:start", ({ ctx }) => {
      events.push(`start:${ctx.server?.name}:${ctx.tool?.name}`);
    });
    proxy.mcp("github").on("tool:success", ({ ctx, result }) => {
      events.push(`success:${ctx.server?.name}:${result?.content[0]?.type}`);
    });
    proxy.on("tool:after", { server: "github" }, ({ durationMs }) => {
      events.push(`after:${typeof durationMs}`);
    });

    await proxy.callTool({ name: "github__create_issue" });

    expect(events).toEqual(["start:github:create_issue", "success:github:text", "after:number"]);
  });

  it("lets tools:list:after transform listed tools with unified context", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });

    proxy.on("tools:list:after", ({ ctx, tools }) => {
      expect(ctx.operation).toBe("tools:list");
      expect(ctx.server).toBeUndefined();
      expect(ctx.tool).toBeUndefined();
      return [
        ...(tools ?? []),
        {
          name: "added",
          inputSchema: { type: "object" },
        },
      ];
    });

    const result = await proxy.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual(["github__create_issue", "added"]);
  });

  it("bridges session lifecycle events to unified events", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });
    const seen: string[] = [];

    proxy.on("session:start", ({ ctx }) => {
      seen.push(`start:${ctx.transport.sessionId}:${ctx.operation}`);
    });
    proxy.on("session:end", ({ ctx }) => {
      seen.push(`end:${ctx.transport.sessionId}:${ctx.operation}`);
    });

    await proxy.emitSessionStart({ user: { id: "user-1" }, sessionId: "s1", log: new Logger() });
    await proxy.emitSessionEnd({ user: { id: "user-1" }, sessionId: "s1", log: new Logger() });

    expect(seen).toEqual(["start:s1:session:start", "end:s1:session:end"]);
  });

  it("keeps legacy middleware and call hooks composed with new events", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });
    const seen: string[] = [];

    proxy.use((req, _ctx, next) => {
      seen.push(`legacy:${req.toolName}`);
      return next();
    });
    proxy.use((ctx, next) => {
      seen.push(`new:${ctx.tool?.name}`);
      return next();
    });
    proxy.on("call", (req) => {
      seen.push(`hook:${req.toolName}`);
    });
    proxy.on("tool:success", ({ ctx }) => {
      seen.push(`event:${ctx.tool?.name}`);
    });

    await proxy.callTool({ name: "github__create_issue" });

    expect(seen).toEqual(["hook:create_issue", "legacy:create_issue", "new:create_issue", "event:create_issue"]);
  });

  it("continues when middleware returns nothing", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    proxy.use(() => undefined);

    const result = await proxy.callTool({ name: "github__create_issue" });

    expect(result.content).toEqual([{ type: "text", text: "called:create_issue" }]);
    expect(transport.callTool).toHaveBeenCalledOnce();
  });

  it("returns a tool error for unknown upstream servers", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    const result = await proxy.callTool({ name: "notion__read_page" });

    expect(result).toEqual({
      content: [{ type: "text", text: 'Unknown MCP server "notion"' }],
      isError: true,
    });
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("rejects duplicate server names", () => {
    expect(
      () =>
        new McpProxy({
          servers: [
            new McpServer({ name: "github", transport: new MockTransport() }),
            new McpServer({ name: "github", transport: new MockTransport() }),
          ],
        }),
    ).toThrow(/Duplicate MCP server name/);
  });

  it("shows group-scoped MCP servers only to members", async () => {
    const alice = user("alice");
    const bob = user("bob");
    const linear = new McpServer({ name: "linear", transport: new MockTransport() });
    const proxy = new McpProxy({
      groups: [
        group({ id: "engineering", users: [alice], policy: Policy.allowAll("engineering"), servers: [linear] }),
        group({ id: "sales", users: [bob], policy: Policy.allowAll("sales") }),
      ],
    });

    await expect(proxy.listTools(undefined, { id: "alice" })).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: toProxyToolName("linear", "create_issue") })],
    });
    await expect(proxy.listTools(undefined, { id: "bob" })).resolves.toEqual({ tools: [] });
  });

  it("prevents non-members from calling group-scoped MCP servers", async () => {
    const alice = user("alice");
    const bob = user("bob");
    const transport = new MockTransport();
    const proxy = new McpProxy({
      groups: [
        group({ id: "engineering", users: [alice], policy: Policy.allowAll("engineering"), servers: [new McpServer({ name: "linear", transport })] }),
        group({ id: "sales", users: [bob], policy: Policy.allowAll("sales") }),
      ],
    });

    const result = await proxy.callTool({ name: toProxyToolName("linear", "create_issue") }, { id: "bob" });

    expect(result.isError).toBe(true);
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("isolates group-scoped middleware for shared MCP servers", async () => {
    const shared = new McpServer({ name: "linear", transport: new MockTransport() });
    const proxy = new McpProxy({
      groups: [
        group({ id: "engineering", users: [user("alice")], policy: Policy.allowAll("engineering"), servers: [shared] }),
        group({ id: "sales", users: [user("bob")], policy: Policy.allowAll("sales"), servers: [shared] }),
      ],
    });
    const seen: string[] = [];
    proxy.group("engineering").mcp("linear").use((ctx, next) => {
      seen.push(ctx.subject?.id ?? "unknown");
      return next();
    });

    await proxy.callTool({ name: toProxyToolName("linear", "create_issue") }, { id: "alice" });
    await proxy.callTool({ name: toProxyToolName("linear", "create_issue") }, { id: "bob" });

    expect(seen).toEqual(["alice"]);
  });

  it("keeps global MCP servers visible and callable", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    await expect(proxy.listTools()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: toProxyToolName("github", "create_issue") })],
    });
    await expect(proxy.callTool({ name: toProxyToolName("github", "create_issue") })).resolves.toMatchObject({
      content: [{ type: "text", text: "called:create_issue" }],
    });
  });

  it("validates duplicate and ambiguous scoped MCP bindings", () => {
    const alice = user("alice");

    expect(
      () =>
        new McpProxy({
          groups: [
            group({
              id: "engineering",
              users: [alice],
              policy: Policy.allowAll("engineering"),
              servers: [
                new McpServer({ name: "linear", transport: new MockTransport() }),
                new McpServer({ name: "linear", transport: new MockTransport() }),
              ],
            }),
          ],
        }),
    ).toThrow(/Duplicate MCP server name "linear" in group "engineering"/);

    expect(
      () =>
        new McpProxy({
          servers: [new McpServer({ name: "linear", transport: new MockTransport() })],
          groups: [
            group({
              id: "engineering",
              users: [alice],
              policy: Policy.allowAll("engineering"),
              servers: [new McpServer({ name: "linear", transport: new MockTransport() })],
            }),
          ],
        }),
    ).toThrow(/Ambiguous MCP server "linear"/);
  });
});
