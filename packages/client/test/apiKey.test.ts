import { createServer, type IncomingHttpHeaders } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, startProxy, tempDirectory, testRuntime } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function loggedIn() {
  const proxy = await startProxy(cleanup);
  const dir = await tempDirectory(cleanup);
  const runtime = testRuntime(dir, { stdin: "alice-key\n" });
  const login = await run(runtime, "auth", "login", proxy.url, "--with-api-key", "--json");
  expect(login.code).toBe(0);
  return { proxy, dir, runtime };
}

describe("API key login and governed usage", () => {
  it("fails with NOT_LOGGED_IN before any login", async () => {
    const runtime = testRuntime(await tempDirectory(cleanup));
    const result = await run(runtime, "tools", "list", "--json");
    expect(result.code).toBe(3);
    expect(result.json).toMatchObject({ ok: false, error: { code: "NOT_LOGGED_IN" }, warnings: [], nextActions: [{ command: "frs auth login <url>" }] });
  });

  it("stores a verified key in an owner-only file and never prints it", async () => {
    const { proxy, dir, runtime } = await loggedIn();
    const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    expect(config).toMatchObject({ version: 1, activeProfile: "default", profiles: { default: { url: proxy.url, method: "api-key" } } });
    expect(JSON.stringify(config)).not.toContain("alice-key");
    expect((await stat(join(dir, "credentials.json"))).mode & 0o777).toBe(0o600);
    const status = await run(runtime, "auth", "status", "--json");
    expect(status.code).toBe(0);
    expect(status.json.data).toMatchObject({ profile: "default", url: proxy.url, method: "api-key", verified: true, storage: { kind: "file" } });
    expect(status.stdout).not.toContain("alice-key");
  });

  it("rejects an invalid key without storing anything", async () => {
    const proxy = await startProxy(cleanup);
    const dir = await tempDirectory(cleanup);
    const result = await run(testRuntime(dir, { stdin: "wrong" }), "auth", "login", proxy.url, "--with-api-key", "--json");
    expect(result.code).toBe(3);
    expect(result.json.error.code).toBe("UNAUTHORIZED");
    await expect(stat(join(dir, "config.json"))).rejects.toThrow();
  });

  it("lists only policy-visible tools with bounded pages", async () => {
    const { runtime } = await loggedIn();
    const all = await run(runtime, "tools", "list", "--json");
    expect(all.json.data.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["demo__echo", "demo__fail", "demo__guarded", "demo__slow"]);
    const first = await run(runtime, "tools", "list", "--mcp", "demo", "--limit", "3", "--json");
    expect(first.json.data.tools).toHaveLength(3);
    expect(first.json.pagination).toMatchObject({ limit: 3, total: 4 });
    const second = await run(runtime, "tools", "list", "--mcp", "demo", "--limit", "3", "--cursor", first.json.pagination.nextCursor, "--json");
    expect(second.json.data.tools).toHaveLength(1);
    expect(second.json.pagination.nextCursor).toBeNull();
    expect((await run(runtime, "tools", "list", "--mcp", "other", "--json")).json.data.tools).toEqual([]);
    const compact = await run(runtime, "tools", "list", "--compact", "--limit", "1", "--json");
    expect(Object.keys(compact.json.data.tools[0]).sort()).toEqual(["description", "name", "server"]);
  });

  it("searches, inspects, and returns targeted schemas", async () => {
    const { runtime } = await loggedIn();
    const search = await run(runtime, "tools", "search", "echo", "--json");
    expect(search.json.data.tools[0]).toMatchObject({ name: "demo__echo", server: "demo" });
    expect(search.json.data.tools[0]).not.toHaveProperty("inputSchema");
    expect(search.json.nextActions[0].command).toBe("frs tools schema demo__echo --input --json");
    const first = await run(runtime, "tools", "search", "demo", "--limit", "2", "--json");
    expect(first.json.pagination).toMatchObject({ limit: 2, total: 4, nextCursor: expect.any(String) });
    expect(first.json.nextActions.at(-1).command).toBe(`frs tools search demo --limit 2 --cursor ${first.json.pagination.nextCursor}`);
    const rest = await run(runtime, "tools", "search", "demo", "--limit", "2", "--cursor", first.json.pagination.nextCursor, "--json");
    expect(rest.json.data.tools).toHaveLength(2);
    expect(rest.json.pagination.nextCursor).toBeNull();
    const get = await run(runtime, "tools", "get", "demo__echo", "--json");
    expect(get.json.data.arguments).toEqual([{ name: "text", type: "string", required: true, description: "Text to echo." }, { name: "times", type: "number", required: false }]);
    const schema = await run(runtime, "tools", "schema", "demo__echo", "--input", "--json");
    expect(schema.json.data).toEqual({ name: "demo__echo", inputSchema: expect.objectContaining({ required: ["text"] }) });
    const missing = await run(runtime, "tools", "schema", "demo__danger", "--json");
    expect(missing.code).toBe(2);
    expect(missing.json.error.code).toBe("NOT_FOUND");
  });

  it("calls tools with every argument source and maps tool errors and denials", async () => {
    const { runtime, proxy } = await loggedIn();
    const json = await run(runtime, "tools", "call", "demo__echo", "--args", "{\"text\":\"hi\"}", "--json");
    expect(json.json).toMatchObject({ ok: true, data: { content: [{ type: "text", text: "hi" }], structuredContent: { echoed: "hi" }, isError: false } });
    const human = await run(runtime, "tools", "call", "demo__echo", "--arg", "text=ab", "--arg", "times=2");
    expect(human.stdout).toBe("abab\n");
    runtime.stdin = "{\"text\":\"stdin\"}";
    expect((await run(runtime, "tools", "call", "demo__echo", "--args-file", "-", "--raw")).stdout).toContain("\"echoed\":\"stdin\"");

    const before = proxy.upstream.calls.length;
    const conflict = await run(runtime, "tools", "call", "demo__echo", "--args", "{}", "--arg", "text=x", "--json");
    expect(conflict.code).toBe(2);
    expect(conflict.json.error.code).toBe("INVALID_ARGUMENTS");
    expect((await run(runtime, "tools", "call", "demo__echo", "--args", "[1]", "--json")).json.error.code).toBe("INVALID_ARGUMENTS");
    expect(proxy.upstream.calls.length).toBe(before);

    const failed = await run(runtime, "tools", "call", "demo__fail");
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("upstream exploded\n");
    expect(failed.stderr).toContain("[TOOL_ERROR]");
    const denied = await run(runtime, "tools", "call", "demo__guarded", "--json");
    expect(denied.code).toBe(4);
    expect(denied.json.error).toMatchObject({ code: "POLICY_DENIED", message: expect.stringContaining("A human rejected this call.") });
    expect(proxy.upstream.calls.some((call) => call.name === "guarded")).toBe(false);
    const hidden = await run(runtime, "tools", "call", "demo__danger", "--json");
    expect(hidden.code).toBe(4);
    expect(hidden.json.error.code).toBe("POLICY_DENIED");
    expect((await run(runtime, "tools", "call", "nope", "--json")).json.error.code).toBe("INVALID_ARGUMENTS");
  });

  it("times out long calls with exit code 6", async () => {
    const { runtime } = await loggedIn();
    const result = await run(runtime, "tools", "call", "demo__slow", "--timeout", "300", "--json");
    expect(result.code).toBe(6);
    expect(result.json.error.code).toBe("TIMEOUT");
  });

  it("lists and reads resources, including binary safety", async () => {
    const { runtime, dir } = await loggedIn();
    const list = await run(runtime, "resources", "list", "--mcp", "demo", "--json");
    const uris = list.json.data.resources.map((resource: { uri: string }) => resource.uri);
    expect(list.json.data.resources[0].server).toBe("demo");
    const readme = uris.find((uri: string) => uri.includes("readme"));
    const logo = uris.find((uri: string) => uri.includes("logo"));
    expect((await run(runtime, "resources", "read", readme)).stdout).toBe("# Demo readme\n");
    runtime.stdoutIsTTY = true;
    const refused = await run(runtime, "resources", "read", logo);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--output-file");
    const file = join(dir, "logo.png");
    const saved = await run(runtime, "resources", "read", logo, "--output-file", file, "--json");
    expect(saved.json.data).toMatchObject({ outputFile: file, mimeType: "image/png", bytes: 4 });
    expect([...await readFile(file)]).toEqual([137, 80, 78, 71]);
  });

  it("lists prompts and validates required arguments before rendering", async () => {
    const { runtime } = await loggedIn();
    const list = await run(runtime, "prompts", "list", "--json");
    expect(list.json.data.prompts).toEqual([expect.objectContaining({ name: "demo__review", server: "demo" })]);
    const missing = await run(runtime, "prompts", "get", "demo__review", "--json");
    expect(missing.code).toBe(2);
    expect(missing.json.error).toMatchObject({ code: "INVALID_ARGUMENTS", details: { missing: ["pr"] } });
    const prompt = await run(runtime, "prompts", "get", "demo__review", "--arg", "pr=12", "--arg", "focus=tests", "--json");
    expect(prompt.json.data.messages[0].content.text).toBe("Review PR 12 focusing on tests");
  });

  it("logs out, manages profiles, and supports environment-only credentials", async () => {
    const { runtime, proxy } = await loggedIn();
    const logout = await run(runtime, "auth", "logout", "--json");
    expect(logout.json.data).toEqual({ profile: "default", removed: true });
    expect((await run(runtime, "tools", "list", "--json")).json.error.code).toBe("NOT_LOGGED_IN");
    const profiles = await run(runtime, "profile", "list", "--json");
    expect(profiles.json.data.profiles).toEqual([{ name: "default", url: proxy.url, method: "api-key", active: true, loggedIn: false }]);
    expect((await run(runtime, "profile", "remove", "default", "--json")).json.error.code).toBe("INVALID_ARGUMENTS");
    expect((await run(runtime, "profile", "remove", "default", "--yes", "--json")).json.data.removed).toBe(true);

    const envDir = await tempDirectory(cleanup);
    const env = testRuntime(envDir, { env: { FENTARIS_URL: proxy.url, FENTARIS_API_KEY: "alice-key" } });
    expect((await run(env, "tools", "call", "demo__echo", "--arg", "text=env", "--json")).json.data.structuredContent).toEqual({ echoed: "env" });
    await expect(stat(join(envDir, "config.json"))).rejects.toThrow();
  });

  it("reports an unreachable proxy with exit code 5", async () => {
    const runtime = testRuntime(await tempDirectory(cleanup), { env: { FENTARIS_URL: "http://127.0.0.1:9/mcp", FENTARIS_API_KEY: "x" } });
    const result = await run(runtime, "tools", "list", "--json");
    expect(result.code).toBe(5);
    expect(result.json.error.code).toBe("PROXY_UNREACHABLE");
  });

  it("never forwards the API key through a redirect to another origin", async () => {
    const received: IncomingHttpHeaders[] = [];
    const elsewhere = createServer((req, res) => { received.push(req.headers); res.writeHead(404).end(); });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => elsewhere.close(() => resolve())));
    const target = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/mcp`;
    const redirecting = createServer((_req, res) => { res.writeHead(307, { location: target }).end(); });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => redirecting.close(() => resolve())));
    const url = `http://127.0.0.1:${(redirecting.address() as { port: number }).port}/mcp`;

    const result = await run(testRuntime(await tempDirectory(cleanup), { env: { FENTARIS_URL: url, FENTARIS_API_KEY: "alice-key" } }), "tools", "list", "--json");
    expect(result.code).toBe(5);
    expect(result.json.error.message).toContain("not followed");
    expect(received).toEqual([]);
  });
});
