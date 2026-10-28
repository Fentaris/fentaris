import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolRequest, CallToolResult, GetPromptResult, ListPromptsResult, ListResourcesResult, ListToolsResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { approval, fentaris, group, McpServer, policy, user, type FentarisTransport, type IdentityStrategy, type McpProxyOptions } from "@fentaris/core";
import { main } from "../src/main.js";
import type { Runtime } from "../src/runtime.js";

/** Parsed JSON envelope; tests navigate it freely. */
type Json = ReturnType<typeof JSON.parse>;

export type TestRuntime = Runtime & { stdout: string; stderr: string; bytes: Uint8Array[]; opened: string[]; stdin: string };

export async function tempDirectory(cleanup: Array<() => Promise<void>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "frs-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function testRuntime(configDir: string, overrides: Partial<Runtime> & { env?: Record<string, string | undefined>; stdin?: string } = {}): TestRuntime {
  const runtime: TestRuntime = {
    stdout: "", stderr: "", bytes: [], opened: [], stdin: overrides.stdin ?? "",
    env: { FENTARIS_CLIENT_CONFIG_DIR: configDir, FENTARIS_CLIENT_CREDENTIAL_STORE: "file", ...overrides.env },
    platform: "linux",
    homedir: configDir,
    interactive: false,
    stdoutIsTTY: false,
    write(text) { runtime.stdout += text; },
    writeBytes(data) { runtime.bytes.push(data); },
    error(text) { runtime.stderr += text; },
    readStdin: async () => runtime.stdin,
    readSecret: async () => runtime.stdin,
    confirm: async () => false,
    openUrl: async (url) => { runtime.opened.push(url); },
    exec: async () => ({ code: 127, stdout: "", stderr: "not available" }),
    fetch: (input, init) => fetch(input, init),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "env" && key !== "stdin")),
  };
  return runtime;
}

/** Run one CLI invocation and reset the captured output. */
export async function run(runtime: TestRuntime, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string; json: Json }> {
  runtime.stdout = ""; runtime.stderr = "";
  const code = await main(argv, runtime);
  let json: Json = {};
  if (argv.includes("--json")) json = JSON.parse(runtime.stdout);
  return { code, stdout: runtime.stdout, stderr: runtime.stderr, json };
}

/** Upstream MCP server double with tools, resources, and prompts. */
export class DemoTransport implements FentarisTransport {
  readonly calls: CallToolRequest["params"][] = [];
  async listTools(): Promise<ListToolsResult> {
    return {
      tools: [
        { name: "echo", title: "Echo text", description: "Echo the provided text back. Useful for tests.", inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to echo." }, times: { type: "number" } }, required: ["text"] }, outputSchema: { type: "object", properties: { echoed: { type: "string" } } } },
        { name: "fail", description: "Always returns a tool error.", inputSchema: { type: "object" } },
        { name: "guarded", description: "Requires an approval that is always denied.", inputSchema: { type: "object" } },
        { name: "slow", description: "Takes a long time.", inputSchema: { type: "object" } },
        { name: "danger", description: "Never visible to alice.", inputSchema: { type: "object" } },
      ],
    };
  }
  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    this.calls.push(params);
    if (params.name === "fail") return { isError: true, content: [{ type: "text", text: "upstream exploded" }] };
    if (params.name === "slow") { await new Promise((resolve) => setTimeout(resolve, 2_000)); return { content: [{ type: "text", text: "late" }] }; }
    const text = String(params.arguments?.text ?? "");
    const times = typeof params.arguments?.times === "number" ? params.arguments.times : 1;
    return { content: [{ type: "text", text: text.repeat(times) }], structuredContent: { echoed: text.repeat(times) } };
  }
  async listResources(): Promise<ListResourcesResult> {
    return { resources: [{ uri: "file:///readme.md", name: "readme", mimeType: "text/markdown" }, { uri: "file:///logo.png", name: "logo", mimeType: "image/png" }] };
  }
  async readResource(params: { uri: string }): Promise<ReadResourceResult> {
    if (params.uri === "file:///logo.png") return { contents: [{ uri: params.uri, mimeType: "image/png", blob: Buffer.from([137, 80, 78, 71]).toString("base64") }] };
    return { contents: [{ uri: params.uri, mimeType: "text/markdown", text: "# Demo readme" }] };
  }
  async listPrompts(): Promise<ListPromptsResult> {
    return { prompts: [{ name: "review", description: "Review a pull request.", arguments: [{ name: "pr", required: true }, { name: "focus" }] }] };
  }
  async getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<GetPromptResult> {
    return { description: "Review prompt", messages: [{ role: "user", content: { type: "text", text: `Review PR ${params.arguments?.pr}${params.arguments?.focus ? ` focusing on ${params.arguments.focus}` : ""}` } }] };
  }
  async close() {}
}

export const API_KEYS: Record<string, string> = { "alice-key": "alice" };

/** API-key identity double: resolves the configured header to a declared user. */
export function apiKeyIdentity(header = "x-fentaris-api-key"): IdentityStrategy {
  return { name: "api-key", resolve: (request) => { const key = request.headers?.[header]; return typeof key === "string" && API_KEYS[key] ? { id: API_KEYS[key]! } : null; } };
}

export function alicePolicy(userId = "alice") {
  const rules = policy("cli-users").mcp("demo").allow("echo").mcp("demo").allow("fail").mcp("demo").allow("slow")
    .mcp("demo").allow("guarded", approval.deny("A human rejected this call."))
    .mcp("demo").allowCapability({ operation: "resources:list" }).mcp("demo").allowCapability({ operation: "resource:read" })
    .mcp("demo").allowCapability({ operation: "prompts:list" }).mcp("demo").allowCapability({ operation: "prompt:get" });
  return group({ id: "cli-users", users: [user(userId)], policy: rules });
}

export async function startProxy(cleanup: Array<() => Promise<void>>, options: Partial<McpProxyOptions> = {}): Promise<{ url: string; base: string; upstream: DemoTransport }> {
  const upstream = new DemoTransport();
  const app = fentaris({
    port: 0,
    identity: { strategy: apiKeyIdentity(), required: true },
    groups: [alicePolicy()],
    servers: [new McpServer({ name: "demo", transport: upstream })],
    ...options,
  } as McpProxyOptions);
  const server = await app.start();
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${base}/mcp`, base, upstream };
}
