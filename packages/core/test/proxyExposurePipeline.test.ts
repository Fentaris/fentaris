import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpProxy } from "../src/proxy/McpProxy.js";
import { McpServer } from "../src/server/McpServer.js";
import { Policy } from "../src/governance.js";
import type { ProxyExposureHandle, ProxyExposureTransport, ProxyRuntime } from "../src/types.js";
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
import type { FentarisTransport } from "../src/types.js";

class MockTransport implements FentarisTransport {
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => {
    return { content: [{ type: "text", text: `called:${params.name}` }] };
  });

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => {
    return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
  });

  readonly listResources = vi.fn(async (): Promise<ListResourcesResult> => {
    return { resources: [{ uri: "file:///readme.md", name: "readme" }] };
  });

  readonly readResource = vi.fn(async (params: ReadResourceRequest["params"]): Promise<ReadResourceResult> => {
    return { contents: [{ uri: params.uri, text: "readme" }] };
  });

  readonly listResourceTemplates = vi.fn(async (): Promise<ListResourceTemplatesResult> => {
    return { resourceTemplates: [{ uriTemplate: "file:///{path}", name: "file" }] };
  });

  readonly listPrompts = vi.fn(async (): Promise<ListPromptsResult> => {
    return { prompts: [{ name: "summarize", arguments: [{ name: "topic" }] }] };
  });

  readonly getPrompt = vi.fn(async (params: GetPromptRequest["params"]): Promise<GetPromptResult> => {
    return { messages: [{ role: "user", content: { type: "text", text: `prompt:${params.name}` } }] };
  });

  readonly complete = vi.fn(async (params: CompleteRequest["params"]): Promise<CompleteResult> => {
    return { completion: { values: [`complete:${"name" in params.ref ? params.ref.name : params.ref.uri}`] } };
  });

  async close(): Promise<void> {}
}

class ToolOnlyTransport implements FentarisTransport {
  readonly callTool = vi.fn(async (): Promise<CallToolResult> => {
    return { content: [{ type: "text", text: "ok" }] };
  });

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => {
    return { tools: [] };
  });

  async close(): Promise<void> {}
}

class InMemoryTransport implements Transport {
  peer?: InMemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

class PipelineProbeExposure implements ProxyExposureTransport<PipelineProbeHandle> {
  constructor(
    private readonly label: string,
    private readonly userId: string,
  ) {}

  async listen(runtime: ProxyRuntime): Promise<PipelineProbeHandle> {
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport.peer = serverTransport;
    serverTransport.peer = clientTransport;

    const sdkServer = runtime.createSdkServer({ id: this.userId }) as { connect(transport: Transport): Promise<void>; close(): Promise<void> };
    const client = new Client({ name: `probe-${this.label}`, version: "0.1.0" }, { capabilities: {} });

    await sdkServer.connect(serverTransport);
    await client.connect(clientTransport);

    return {
      client,
      close: async () => {
        await client.close();
        await sdkServer.close();
      },
    };
  }
}

type PipelineProbeHandle = ProxyExposureHandle & {
  client: Client;
};

function allowAllMcpOperations(): Policy {
  return Policy.allowAll().mcp("*").allowCapability({ operation: "*", target: "*" });
}

describe("proxy exposure pipeline", () => {
  it("starts each explicit exposure registered after the runtime is ready", async () => {
    const proxy = new McpProxy({
      policy: allowAllMcpOperations(),
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });

    const first = await proxy.listen(new PipelineProbeExposure("http", "http-user"));
    const second = await proxy.listen(new PipelineProbeExposure("stdio", "stdio-user"));

    await expect(first.client.listTools()).resolves.toMatchObject({
      tools: [{ name: "github__read" }],
    });
    await expect(second.client.listTools()).resolves.toMatchObject({
      tools: [{ name: "github__read" }],
    });

    await proxy.close();
  });

  it("uses the same listTools and callTool pipeline for HTTP, stdio, and SSE exposure transports", async () => {
    const upstream = new MockTransport();
    const proxy = new McpProxy({
      policy: allowAllMcpOperations(),
      servers: [new McpServer({ name: "github", transport: upstream })],
    });
    const seenUsers: string[] = [];

    proxy.use((request, context, next) => {
      seenUsers.push(`${context.user.id}:${request.proxyToolName}`);
      return next();
    });

    const handles = await Promise.all([
      proxy.listen(new PipelineProbeExposure("http", "http-user")),
      proxy.listen(new PipelineProbeExposure("stdio", "stdio-user")),
      proxy.listen(new PipelineProbeExposure("sse", "sse-user")),
    ]);

    for (const handle of handles) {
      await expect(handle.client.listTools()).resolves.toMatchObject({
        tools: [{ name: "github__read" }],
      });
      await expect(handle.client.callTool({ name: "github__read" })).resolves.toMatchObject({
        content: [{ text: "called:read" }],
      });
      expect(handle.client.getServerCapabilities()).toMatchObject({
        tools: {},
        resources: {},
        prompts: {},
        completions: {},
      });
      await expect(handle.client.listResources()).resolves.toMatchObject({
        resources: [{ uri: "fentaris://resources/github/file%3A%2F%2F%2Freadme.md", name: "readme" }],
      });
      await expect(
        handle.client.readResource({ uri: "fentaris://resources/github/file%3A%2F%2F%2Freadme.md" }),
      ).resolves.toMatchObject({
        contents: [{ uri: "fentaris://resources/github/file%3A%2F%2F%2Freadme.md", text: "readme" }],
      });
      await expect(handle.client.listResourceTemplates()).resolves.toMatchObject({
        resourceTemplates: [{ uriTemplate: "fentaris://resource-templates/github/file%3A%2F%2F%2F%7Bpath%7D" }],
      });
      await expect(handle.client.listPrompts()).resolves.toMatchObject({
        prompts: [{ name: "github__summarize" }],
      });
      await expect(handle.client.getPrompt({ name: "github__summarize" })).resolves.toMatchObject({
        messages: [{ content: { text: "prompt:summarize" } }],
      });
      await expect(
        handle.client.complete({
          ref: { type: "ref/prompt", name: "github__summarize" },
          argument: { name: "topic", value: "m" },
        }),
      ).resolves.toMatchObject({
        completion: { values: ["complete:summarize"] },
      });
    }

    expect(seenUsers).toEqual([
      "http-user:github__read",
      "http-user:resources:list",
      "http-user:resource:read",
      "http-user:resource-templates:list",
      "http-user:prompts:list",
      "http-user:prompt:get",
      "http-user:completion:complete",
      "stdio-user:github__read",
      "stdio-user:resources:list",
      "stdio-user:resource:read",
      "stdio-user:resource-templates:list",
      "stdio-user:prompts:list",
      "stdio-user:prompt:get",
      "stdio-user:completion:complete",
      "sse-user:github__read",
      "sse-user:resources:list",
      "sse-user:resource:read",
      "sse-user:resource-templates:list",
      "sse-user:prompts:list",
      "sse-user:prompt:get",
      "sse-user:completion:complete",
    ]);
    await proxy.close();
  });

  it("hides downstream server feature capabilities for tool-only upstream transports", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new ToolOnlyTransport() })],
    });
    const handle = await proxy.listen(new PipelineProbeExposure("tool-only", "user"));

    expect(handle.client.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(handle.client.getServerCapabilities()).not.toHaveProperty("resources");
    expect(handle.client.getServerCapabilities()).not.toHaveProperty("prompts");
    expect(handle.client.getServerCapabilities()).not.toHaveProperty("completions");

    await proxy.close();
  });
});
