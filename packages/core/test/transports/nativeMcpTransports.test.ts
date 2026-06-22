import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../../src/transports/client/HttpTransport.js";
import { SseMcpTransport } from "../../src/transports/client/SseMcpTransport.js";
import { StdioTransport } from "../../src/transports/client/StdioTransport.js";
import { StreamableHttpMcpTransport } from "../../src/transports/client/StreamableHttpMcpTransport.js";
import { MissingHttpTransportCredentialError } from "../../src/transportAuth.js";

const fakes = vi.hoisted(() => {
  const clientInstances: FakeClient[] = [];
  const stdioTransports: FakeStdioTransport[] = [];
  const streamableTransports: FakeStreamableTransport[] = [];
  const sseTransports: FakeSseTransport[] = [];
  let serverCapabilities: Record<string, object> = {
    completions: {},
    prompts: {},
    resources: {},
    tools: {},
  };

  class FakeClient {
    readonly close = vi.fn(async () => undefined);
    readonly connect = vi.fn(async (transport: unknown) => {
      this.transport = transport;
    });
    transport: unknown;

    constructor(
      readonly clientInfo: unknown,
      readonly options: unknown,
    ) {
      clientInstances.push(this);
    }

    getServerCapabilities(): Record<string, object> {
      return serverCapabilities;
    }

    async listTools(params: unknown): Promise<unknown> {
      return { tools: [{ name: `listed:${JSON.stringify(params ?? {})}`, inputSchema: { type: "object" } }] };
    }

    async callTool(params: unknown): Promise<unknown> {
      return { content: [{ type: "text", text: `called:${JSON.stringify(params)}` }] };
    }

    async listResources(params: unknown): Promise<unknown> {
      return { resources: [{ uri: `resource:${JSON.stringify(params ?? {})}`, name: "resource" }] };
    }

    async readResource(params: unknown): Promise<unknown> {
      return { contents: [{ uri: "file:///readme.md", text: `read:${JSON.stringify(params)}` }] };
    }

    async listResourceTemplates(params: unknown): Promise<unknown> {
      return { resourceTemplates: [{ uriTemplate: `template:${JSON.stringify(params ?? {})}`, name: "template" }] };
    }

    async listPrompts(params: unknown): Promise<unknown> {
      return { prompts: [{ name: `prompt:${JSON.stringify(params ?? {})}` }] };
    }

    async getPrompt(params: unknown): Promise<unknown> {
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `prompt:${JSON.stringify(params)}` },
          },
        ],
      };
    }

    async complete(params: unknown): Promise<unknown> {
      return { completion: { values: [`complete:${JSON.stringify(params)}`] } };
    }
  }

  class FakeStdioTransport {
    constructor(readonly options: unknown) {
      stdioTransports.push(this);
    }
  }

  class FakeStreamableTransport {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly url: URL,
      readonly options: { requestInit?: RequestInit },
    ) {
      streamableTransports.push(this);
    }
  }

  class FakeSseTransport {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly url: URL,
      readonly options: { requestInit?: RequestInit },
    ) {
      sseTransports.push(this);
    }
  }

  return {
    FakeClient,
    FakeStdioTransport,
    FakeStreamableTransport,
    FakeSseTransport,
    clientInstances,
    stdioTransports,
    streamableTransports,
    sseTransports,
    setServerCapabilities(capabilities: Record<string, object>) {
      serverCapabilities = capabilities;
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: fakes.FakeClient,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: fakes.FakeStdioTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: fakes.FakeStreamableTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: fakes.FakeSseTransport,
}));

describe("native MCP upstream transports", () => {
  beforeEach(() => {
    fakes.clientInstances.length = 0;
    fakes.stdioTransports.length = 0;
    fakes.streamableTransports.length = 0;
    fakes.sseTransports.length = 0;
    fakes.setServerCapabilities({
      completions: {},
      prompts: {},
      resources: {},
      tools: {},
    });
  });

  it("lists tools over native Streamable HTTP with resolved auth headers", async () => {
    const transport = new StreamableHttpMcpTransport({
      url: "http://mcp.example/mcp",
      auth: {
        headers: { "x-static": "1" },
        bearerToken: ({ user }) => user.tokens?.github,
      },
    }).withUser({ tokens: { github: "token" } });

    await expect(transport.listTools({ cursor: "next" })).resolves.toMatchObject({
      tools: [{ name: 'listed:{"cursor":"next"}' }],
    });
    expect(fakes.streamableTransports[0]?.url.href).toBe("http://mcp.example/mcp");
    expect(fakes.streamableTransports[0]?.options.requestInit?.headers).toEqual({
      "x-static": "1",
      authorization: "Bearer token",
    });
  });

  it("calls tools over native HTTPS Streamable HTTP and closes client resources", async () => {
    const transport = new StreamableHttpMcpTransport({ url: "https://mcp.example/mcp" });

    await expect(transport.callTool({ name: "search", arguments: { q: "fentaris" } })).resolves.toMatchObject({
      content: [{ text: 'called:{"name":"search","arguments":{"q":"fentaris"}}' }],
    });
    await transport.close();

    expect(fakes.streamableTransports[0]?.url.protocol).toBe("https:");
    expect(fakes.clientInstances[0]?.close).toHaveBeenCalledOnce();
    expect(fakes.streamableTransports[0]?.close).toHaveBeenCalledOnce();
  });

  it("lists and calls tools over native SSE with shared auth", async () => {
    const transport = new SseMcpTransport({
      url: "https://mcp.example/sse",
      auth: {
        apiKey: { header: "x-api-key", resolve: ({ user }) => user.secrets?.apiKey },
      },
    }).withUser({ secrets: { apiKey: "secret" } });

    await expect(transport.listTools()).resolves.toMatchObject({ tools: [{ name: "listed:{}" }] });
    await expect(transport.callTool({ name: "read" })).resolves.toMatchObject({
      content: [{ text: 'called:{"name":"read"}' }],
    });
    await transport.close();

    expect(fakes.sseTransports[0]?.options.requestInit?.headers).toEqual({ "x-api-key": "secret" });
    expect(fakes.sseTransports[0]?.close).toHaveBeenCalledOnce();
  });

  it("forwards resources, prompts, and completion over native stdio", async () => {
    const transport = new StdioTransport({ command: "node", args: ["server.js"] });

    await expect(transport.listResources({ cursor: "r1" })).resolves.toMatchObject({
      resources: [{ uri: 'resource:{"cursor":"r1"}' }],
    });
    await expect(transport.readResource({ uri: "file:///readme.md" })).resolves.toMatchObject({
      contents: [{ text: 'read:{"uri":"file:///readme.md"}' }],
    });
    await expect(transport.listResourceTemplates({ cursor: "t1" })).resolves.toMatchObject({
      resourceTemplates: [{ uriTemplate: 'template:{"cursor":"t1"}' }],
    });
    await expect(transport.listPrompts({ cursor: "p1" })).resolves.toMatchObject({
      prompts: [{ name: 'prompt:{"cursor":"p1"}' }],
    });
    await expect(transport.getPrompt({ name: "summarize", arguments: { topic: "mcp" } })).resolves.toMatchObject({
      messages: [{ content: { text: 'prompt:{"name":"summarize","arguments":{"topic":"mcp"}}' } }],
    });
    await expect(
      transport.complete({
        ref: { type: "ref/prompt", name: "summarize" },
        argument: { name: "topic", value: "m" },
      }),
    ).resolves.toMatchObject({
      completion: {
        values: [
          'complete:{"ref":{"type":"ref/prompt","name":"summarize"},"argument":{"name":"topic","value":"m"}}',
        ],
      },
    });

    expect(fakes.stdioTransports[0]?.options).toMatchObject({ command: "node", args: ["server.js"] });
  });

  it("returns empty list responses and rejects single-item operations for unsupported capabilities", async () => {
    fakes.setServerCapabilities({ tools: {} });
    const transport = new StreamableHttpMcpTransport({ url: "https://mcp.example/mcp" });

    await expect(transport.listResources()).resolves.toEqual({ resources: [] });
    await expect(transport.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
    await expect(transport.listPrompts()).resolves.toEqual({ prompts: [] });
    await expect(transport.readResource({ uri: "file:///readme.md" })).rejects.toThrow(/does not support resources/);
    await expect(transport.getPrompt({ name: "summarize" })).rejects.toThrow(/does not support prompts/);
    await expect(
      transport.complete({
        ref: { type: "ref/prompt", name: "summarize" },
        argument: { name: "topic", value: "m" },
      }),
    ).rejects.toThrow(/does not support completions/);
  });

  it("fails before upstream requests when required credentials are missing", async () => {
    const transport = new SseMcpTransport({
      url: "https://mcp.example/sse",
      auth: {
        apiKey: { header: "x-api-key", resolve: ({ user }) => user.secrets?.apiKey },
      },
    }).withUser({ secrets: {} });

    await expect(transport.listTools()).rejects.toBeInstanceOf(MissingHttpTransportCredentialError);
    expect(fakes.sseTransports).toHaveLength(0);
  });

  it("blocks Streamable HTTP upstream URLs that resolve to private addresses unless allowed", async () => {
    const blocked = new StreamableHttpMcpTransport({
      url: "https://mcp.example/mcp",
      network: {
        lookup: async () => [{ address: "10.0.0.8" }],
      },
    });

    await expect(blocked.listTools()).rejects.toThrow(/Blocked upstream URL/);
    expect(fakes.streamableTransports).toHaveLength(0);

    const allowed = new StreamableHttpMcpTransport({
      url: "https://mcp.example/mcp",
      network: {
        allowedPrivateHosts: ["mcp.example"],
        lookup: async () => [{ address: "10.0.0.8" }],
      },
    });

    await expect(allowed.listTools()).resolves.toMatchObject({ tools: [{ name: "listed:{}" }] });
    expect(fakes.streamableTransports).toHaveLength(1);
  });

  it("blocks SSE upstream localhost URLs by default", async () => {
    const transport = new SseMcpTransport({ url: "http://localhost/sse" });

    await expect(transport.listTools()).rejects.toThrow(/Blocked upstream URL/);
    expect(fakes.sseTransports).toHaveLength(0);
  });

  it("keeps the simple REST-like HttpTransport distinct from native MCP Streamable HTTP", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tools: [] }) }) as Response);
    const transport = new HttpTransport({ baseUrl: "https://api.example/simple", fetch: fetchMock as unknown as typeof fetch });

    await transport.listTools();

    expect(fetchMock).toHaveBeenCalledWith(new URL("https://api.example/simple/listTools"), expect.any(Object));
    expect(fakes.streamableTransports).toHaveLength(0);
  });
});
