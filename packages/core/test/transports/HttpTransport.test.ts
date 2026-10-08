import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../../src/transports/client/HttpTransport.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10" }]) }));

describe("HttpTransport", () => {
  it("posts listTools requests over HTTP with auth headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tools: [] }));
    const transport = new HttpTransport({
      baseUrl: "https://mcp.example/api",
      authToken: "secret",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await transport.listTools({ cursor: "next" });

    expect(result).toEqual({ tools: [] });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://mcp.example/api/listTools"), {
      signal: expect.any(AbortSignal),
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ params: { cursor: "next" } }),
    });
  });

  it("posts callTool requests and returns the upstream result", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    const transport = new HttpTransport({
      baseUrl: "https://mcp.example/api/",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await transport.callTool({ name: "search", arguments: { q: "fentaris" } });

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://mcp.example/api/callTool"), {
      signal: expect.any(AbortSignal),
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ params: { name: "search", arguments: { q: "fentaris" } } }),
    });
  });

  it("maps only explicit env headers and known auth env values", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tools: [] }));
    const transport = new HttpTransport({
      baseUrl: "https://mcp.example/api",
      envHeaderMap: {
        "x-tenant-id": "TENANT_ID",
      },
      fetch: fetchMock as unknown as typeof fetch,
    }).withEnv({
      AUTH_TOKEN: "auth-token",
      GITHUB_TOKEN: "github-token",
      TENANT_ID: "tenant-1",
    });

    await transport.listTools();

    expect(fetchMock).toHaveBeenCalledWith(new URL("https://mcp.example/api/listTools"), {
      signal: expect.any(AbortSignal),
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer auth-token",
        "x-tenant-id": "tenant-1",
      },
      body: JSON.stringify({}),
    });
  });

  it("blocks private upstream URLs unless explicitly allowed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tools: [] }));
    const blocked = new HttpTransport({
      baseUrl: "http://169.254.169.254/latest",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(blocked.listTools()).rejects.toThrow(/Blocked upstream URL/);
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = new HttpTransport({
      baseUrl: "http://169.254.169.254/latest",
      network: { allowedPrivateHosts: ["169.254.169.254"] },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(allowed.listTools()).resolves.toEqual({ tools: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight HTTP request when temporary discovery closes it", async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => {
      signal = options.signal;
      signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    }));
    const transport = new HttpTransport({ baseUrl: "https://mcp.example/api", fetch: fetchMock as typeof fetch });
    const rejected = expect(transport.listTools()).rejects.toThrow("request aborted");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await transport.close();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("blocks private IPv4 addresses encoded as IPv4-mapped IPv6 literals", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tools: [] }));

    for (const baseUrl of [
      "http://[::ffff:7f00:1]/latest",
      "http://[::ffff:a9fe:a9fe]/latest",
      "http://[::ffff:c0a8:101]/latest",
    ]) {
      const transport = new HttpTransport({
        baseUrl,
        fetch: fetchMock as unknown as typeof fetch,
      });

      await expect(transport.listTools()).rejects.toThrow(/Blocked upstream URL/);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  } as Response;
}
