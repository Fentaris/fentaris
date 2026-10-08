import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FentarisAuth, LocalSecretsBackend, LocalOAuthTokenStore, McpVaultOAuthTokenStore } from "@fentaris/core";
import { main } from "../src/index.js";
import { parseCommand } from "../src/shared/parse.js";
import type { Runtime } from "../src/shared/types.js";
import { startAuthorizationServer } from "../../core/test/fixtures/oauth/authorizationServer.js";
import { startProtectedMcpServer } from "../../core/test/fixtures/oauth/protectedMcpServer.js";

const core = pathToFileURL(resolve(import.meta.dirname, "../../core/src/index.ts")).href;
const key = "mcp-regression-test-unlock-key";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function runtime(cwd: string, interactive = false) {
  const output: string[] = []; const errors: string[] = [];
  const rt: Runtime = { cwd, env: { FENTARIS_AUTH_KEY: key }, interactive, out: { log: (v) => output.push(String(v)), error: (v) => errors.push(String(v)) }, runner: async () => ({ code: 0 }), probe: () => true,
    prompt: { text: vi.fn(async () => "hidden-value"), select: vi.fn(async (_q, choices) => choices[0]), confirm: vi.fn(async () => true), close: vi.fn() }, progress: vi.fn(() => vi.fn()) };
  return { ...rt, output, errors };
}
async function project(config: string, defaults: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "fentaris-mcp-cli-")); cleanups.push(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "src")); await mkdir(join(root, ".fentaris"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mcp-test", type: "module", dependencies: { "@fentaris/core": "workspace:*" } }));
  await writeFile(join(root, "fentaris.json"), JSON.stringify({ name: "mcp-test", entrypoint: "src/index.ts", packageManager: "pnpm", authDir: ".fentaris", port: 4000, path: "/mcp" }));
  await writeFile(join(root, ".env"), `MCP_297_CONFIG_IMPORT_VALUE=loaded\nFENTARIS_AUTH_KEY=${key}\n`);
  await writeFile(join(root, ".fentaris", "credentials.enc.json"), JSON.stringify(FentarisAuth.encryptCredentials({ defaults, users: {}, groups: {} }, key)));
  await writeFile(join(root, "src", "index.ts"), `import { mcp, bearer, credential, credentialEnv, oauth, streamableHttp } from ${JSON.stringify(core)};
const captured = process.env.MCP_297_CONFIG_IMPORT_VALUE;
class Fake {
  constructor(user = {}) { this.user = user; }
  withUser(user) { return new Fake(user); }
  async listTools() { return { tools: [{ name: captured + '_search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, outputSchema: { type: 'object' } }] }; }
  async callTool() { return { content: [] }; }
  async close() {}
}
export default ${config};\n`);
  return root;
}
const plain = `{ servers: [mcp('mail', { transport: new Fake(), accounts: { gabry848: {}, gino: {} } })] }`;
const bearerConfig = `{ servers: [mcp('github', { transport: new Fake(), accounts: { work: { auth: bearer(credential('github.token')) }, home: { auth: bearer(credential('github.token')) } } })] }`;
function json(rt: ReturnType<typeof runtime>) { return JSON.parse(rt.output.at(-1)!); }

describe("fentaris mcp", () => {
  it("lists all named accounts without --as, loads .env before config import, and emits one stable JSON result", async () => {
    const root = await project(plain); const rt = runtime(root);
    expect(await main(["mcp", "--json"], rt)).toBe(0);
    expect(json(rt)).toMatchObject({ version: 1, outcome: "success", connections: [{ server: "mail", account: "gabry848", toolCount: 1 }, { server: "mail", account: "gino", toolCount: 1 }] });
    expect(json(rt).connections[0].tools[0].name).toBe("mail__loaded_search");
    expect(rt.output).toHaveLength(1); expect(rt.progress).not.toHaveBeenCalled(); expect(rt.prompt.select).not.toHaveBeenCalled();
  });
  it.each([["mcp", "--json"], ["mcp", "auth", "get", "delayed", "--json"]])("keeps environment and transports alive through async %j", async (...args) => {
    const root = await project(`(() => {
      let closed = false;
      class Delayed extends Fake {
        withUser(user) { return new Delayed(user); }
        async listTools() {
          await new Promise(resolve => setTimeout(resolve, 20));
          if (closed) throw new Error('Transport closed during discovery');
          if (process.env.MCP_297_CONFIG_IMPORT_VALUE !== 'loaded') throw new Error('Project environment restored too early');
          return super.listTools();
        }
        async close() { closed = true; }
      }
      return { servers: [mcp('delayed', { transport: new Delayed() })] };
    })()`);
    const rt = runtime(root);
    expect(await main(args, rt)).toBe(0);
    expect(json(rt).connections[0]).toMatchObject({ connectivity: "reachable", toolCount: 1 });
    expect(process.env.MCP_297_CONFIG_IMPORT_VALUE).toBeUndefined();
  });
  it("retains dotenv-only credential sources through asynchronous account connect", async () => {
    const root = await project(`{ servers: [mcp('github', { transport: new Fake(), auth: bearer(credential('env-token')) })], defaults: { credentials: { 'env-token': credentialEnv('MCP_297_LIFETIME_TOKEN') } } }`);
    await writeFile(join(root, ".env"), (await readFile(join(root, ".env"), "utf8")) + "MCP_297_LIFETIME_TOKEN=dotenv-only-token\n");
    const rt = runtime(root, true);
    vi.mocked(rt.prompt.select).mockImplementation(async (_question, choices) => {
      await new Promise(resolve => setTimeout(resolve, 20)); return choices[0];
    });
    expect(await main(["mcp", "auth", "connect"], rt)).toBe(0);
    expect(rt.output.join("\n")).toContain("already has credentials");
    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(process.env.MCP_297_LIFETIME_TOKEN).toBeUndefined();
    expect(rt.output.join("\n")).not.toContain("dotenv-only-token");
  });
  it("keeps tool filters optional, selects the correct account for get/schema, and requires selection when ambiguous", async () => {
    const rt = runtime(await project(plain));
    expect(await main(["mcp", "tools", "--json"], rt)).toBe(0); expect(json(rt).connections).toHaveLength(2);
    expect(await main(["mcp", "tools", "get", "mail__loaded_search", "--json"], rt)).toBe(1);
    expect(json(rt).error).toMatchObject({ code: "MISSING_INPUT", missingFields: ["account"], nextCommand: expect.stringContaining("--account") });
    expect(await main(["mcp", "tools", "schema", "mail__loaded_search", "--account", "gino", "--input", "--json"], rt)).toBe(0);
    expect(json(rt).connections[0].account).toBe("gino"); expect(json(rt).data.inputSchema.properties.query.type).toBe("string"); expect(json(rt).data.outputSchema).toBeUndefined();
    expect(await main(["mcp", "tools", "schema", "mail__loaded_search", "--account", "gino", "--output", "--json"], rt)).toBe(0); expect(json(rt).data.outputSchema.type).toBe("object");
  });
  it("removes tools without an alias, including help, and rejects downstream selectors and unknown flags", async () => {
    const rt = runtime(await project(plain));
    for (const args of [["tools", "list", "--json"], ["help", "tools", "--json"], ["mcp", "--bogus", "--json"], ["mcp", "--account", "user:alice", "--json"]]) expect(await main(args, rt)).toBeGreaterThan(0);
    expect(rt.prompt.text).not.toHaveBeenCalled(); expect(rt.prompt.select).not.toHaveBeenCalled();
  });
  it("reports explicit empty inventory and clears transient progress on partial discovery", async () => {
    const empty = runtime(await project("{}")); expect(await main(["mcp"], empty)).toBe(0); expect(empty.output.join("\n")).toContain("No MCP servers are configured");
    const rt = runtime(await project(`{ servers: [mcp('good', { transport: new Fake() }), mcp('bad', { transport: { listTools: async () => { throw new Error('token=do-not-leak') }, callTool: async () => ({}), close: async () => {} } })] }`), true);
    expect(await main(["mcp", "tools"], rt)).toBe(3); expect(rt.output.join("\n")).toContain("good__loaded_search"); expect(rt.output.join("\n")).toContain("upstream connection is unavailable"); expect(rt.output.join("\n")).not.toContain("do-not-leak");
    expect(rt.progress).toHaveBeenCalledTimes(1); const clear = vi.mocked(rt.progress!).mock.results[0].value; expect(clear).toHaveBeenCalledTimes(1);
  });
  it("marks offline tools as cached with age and never treats absent metadata as zero tools", async () => {
    const rt = runtime(await project(plain));
    expect(await main(["mcp", "tools", "--offline", "--json"], rt)).toBe(0); expect(json(rt).connections[0]).toMatchObject({ toolCount: null, connectivity: "unverified" });
    expect(await main(["mcp", "tools", "--json"], rt)).toBe(0);
    expect(await main(["mcp", "tools", "--offline", "--json"], rt)).toBe(0); expect(json(rt).connections[0]).toMatchObject({ toolCount: 1, toolMetadata: { source: "cached", ageMs: expect.any(Number) }, connectivity: "unverified" });
  });
  it("reuses named secrets, preserves source values and other accounts on disconnect, and refuses implicit overwrite", async () => {
    const root = await project(bearerConfig, { shared: "sensitive-token" }); const rt = runtime(root);
    expect(await main(["mcp", "auth", "connect", "github", "--account", "work", "--secret", "shared", "--json"], rt)).toBe(0);
    const state = JSON.parse(await readFile(join(root, ".fentaris", "mcp-connections.json"), "utf8")); expect(state.connections[0].bindings.bearer).toBe("shared");
    expect(await main(["mcp", "auth", "connect", "github", "--account", "work", "--json"], rt)).toBe(0); expect(json(rt).data.status).toBe("already-connected");
    expect(await main(["mcp", "auth", "connect", "github", "--account", "home", "--secret", "shared", "--json"], rt)).toBe(0);
    expect(await main(["mcp", "auth", "disconnect", "github", "--account", "work", "--json"], rt)).toBe(0); expect(json(rt).data.sharedSecretsPreserved).toBe(true);
    expect(await new LocalSecretsBackend({ dir: join(root, ".fentaris"), key }).resolve("shared")).toBe("sensitive-token");
    expect(await main(["mcp", "get", "github", "--account", "home", "--json"], rt)).toBe(0);
    expect(rt.output.join("\n")).not.toContain("sensitive-token");
  });
  it("preserves only supplied flags regardless of order and asks only for missing fields", async () => {
    const rt = runtime(await project(bearerConfig, { "github.token": "present" }), true);
    expect(await main(["mcp", "auth", "connect", "--account", "work"], rt)).toBe(0);
    expect(rt.prompt.select).toHaveBeenCalledExactlyOnceWith("MCP server", ["github"]);
    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(parseCommand(["mcp", "--account", "work", "auth", "connect", "github"])).toMatchObject({ kind: "ok", command: { args: ["auth", "connect", "github"], options: { account: "work" } } });
    expect(parseCommand(["mcp", "auth", "connect", "--secret", "shared"])).toMatchObject({ kind: "ok", command: { options: { secret: "shared" } } });
  });
  it("completes missing flag values interactively and reports all missing fields without prompts in JSON/non-TTY", async () => {
    const rt = runtime(await project(bearerConfig, { "github.token": "present" }), true); vi.mocked(rt.prompt.text).mockResolvedValue("work");
    expect(await main(["mcp", "auth", "connect", "github", "--account"], rt)).toBe(0); expect(rt.prompt.text).toHaveBeenCalledExactlyOnceWith("Value for --account", { secret: false });
    const scripted = runtime(rt.cwd);
    expect(await main(["mcp", "auth", "connect", "github", "--account", "--json"], scripted)).toBe(1); expect(json(scripted).error.missingFields).toEqual(["account"]); expect(scripted.prompt.text).not.toHaveBeenCalled();
    expect(await main(["mcp", "auth", "connect", "--json"], scripted)).toBe(1); expect(json(scripted).error.nextCommand).toContain("fentaris mcp auth connect");
  });
  it("bare auth remains a read-only non-TTY view and a menu action requires an explicit mutation confirmation", async () => {
    const root = await project(bearerConfig, { "github.token": "present" }); const rt = runtime(root);
    expect(await main(["mcp", "auth", "--offline", "--json"], rt)).toBe(0); expect(rt.prompt.select).not.toHaveBeenCalled();
    const interactive = runtime(root, true); vi.mocked(interactive.prompt.select).mockImplementation(async (question, choices) => (question === "Action" ? "disconnect" : choices[0]) as typeof choices[number]); vi.mocked(interactive.prompt.confirm).mockResolvedValue(false);
    expect(await main(["mcp", "auth", "--account", "work"], interactive)).toBe(1);
    expect(interactive.prompt.confirm).toHaveBeenCalled(); await expect(readFile(join(root, ".fentaris", "mcp-connections.json"))).rejects.toThrow();
  });
  it("credential bundles collect all missing hidden input before writing and cancellation leaves no connection record", async () => {
    const root = await project(`{ servers: [mcp('bundle', { transport: new Fake(), env: { CLIENT_ID: credential('bundle.id'), CLIENT_SECRET: credential('bundle.secret') } })] }`); const rt = runtime(root, true);
    vi.mocked(rt.prompt.text).mockResolvedValueOnce("first-value").mockRejectedValueOnce(new Error("Prompt cancelled."));
    expect(await main(["mcp", "auth", "connect", "bundle"], rt)).toBe(1);
    const store = new LocalSecretsBackend({ dir: join(root, ".fentaris"), key }); expect(await store.has("bundle.id", { kind: "default" })).toBe(false); await expect(readFile(join(root, ".fentaris", "mcp-connections.json"))).rejects.toThrow();
    expect(rt.output.join("\n") + rt.errors.join("\n")).not.toContain("first-value");
  });
  it("performs real browser OAuth through the vault, discovers tools, and remotely revokes only the selected account", async () => {
    const authorization = await startAuthorizationServer(); cleanups.push(() => authorization.close());
    const protectedServer = await startProtectedMcpServer({ authorizationServer: authorization }); cleanups.push(() => protectedServer.close());
    const root = await project(`{ servers: [mcp('mail', { transport: streamableHttp({ url: ${JSON.stringify(protectedServer.url)}, network: { allowPrivateNetworkUrls: true } }), accounts: { work: { auth: oauth() }, home: { auth: oauth() } } })] }`);
    const rt = runtime(root);
    const login = main(["mcp", "auth", "connect", "mail", "--account", "work", "--print-url", "--json"], rt);
    await vi.waitFor(() => expect(rt.errors.some((line) => line.includes("/authorize?"))).toBe(true), { timeout: 5000 });
    await fetch(rt.errors.find((line) => line.includes("/authorize?"))!);
    expect(await login).toBe(0); expect(rt.output).toHaveLength(1); expect(json(rt).data.status).toBe("connected");
    expect(await main(["mcp", "tools", "mail", "--account", "work", "--json"], rt)).toBe(0); expect(json(rt).connections[0].authentication.state).toBe("authorized");
    const refs = await new LocalSecretsBackend({ dir: join(root, ".fentaris"), key }).listRefs(); expect(refs.some((entry) => entry.ref.startsWith("fentaris.internal.oauth."))).toBe(false);
    expect(await main(["mcp", "auth", "disconnect", "mail", "--account", "work", "--json"], rt)).toBe(0); expect(json(rt).data.remoteRevocation).toBe("revoked");
    expect(await main(["mcp", "auth", "get", "mail", "--account", "home", "--json"], rt)).toBe(1); expect(json(rt).connections[0].authentication.state).toBe("missing");
    for (const sensitive of authorization.sensitiveValues) if (sensitive) expect(rt.output.join("\n")).not.toContain(sensitive);
  });
  it("requires an explicit migration source and retains the original encrypted authorization", async () => {
    const root = await project(`{ servers: [mcp('mail', { transport: streamableHttp({ url: 'https://example.com/mcp' }), auth: oauth() })] }`);
    const legacy = new LocalOAuthTokenStore({ dir: join(root, ".fentaris"), key });
    await legacy.set("mail", "user:old-client", { updatedAt: 1, tokens: { access_token: "legacy-secret", token_type: "Bearer", obtainedAt: 1 } });
    const rt = runtime(root); expect(await main(["mcp", "--offline", "--json"], rt)).toBe(0); expect(json(rt).connections[0].authentication.state).toBe("migration-required");
    expect(await main(["mcp", "auth", "migrate", "mail", "--account", "default", "--from-session", "user:old-client", "--json"], rt)).toBe(0); expect(json(rt).data.legacyPreserved).toBe(true);
    expect((await legacy.get("mail", "user:old-client"))?.tokens?.access_token).toBe("legacy-secret"); expect(rt.output.join("\n")).not.toContain("legacy-secret");
  });
  it("refreshes expired named OAuth tokens through the vault and preserves prior authorization after cancellation", async () => {
    const authorization = await startAuthorizationServer(); cleanups.push(() => authorization.close());
    const protectedServer = await startProtectedMcpServer({ authorizationServer: authorization }); cleanups.push(() => protectedServer.close());
    const root = await project(`{ servers: [mcp('mail', { transport: streamableHttp({ url: ${JSON.stringify(protectedServer.url)}, network: { allowPrivateNetworkUrls: true } }), accounts: { work: { auth: oauth() } } })] }`);
    const rt = runtime(root);
    const login = main(["mcp", "auth", "connect", "mail", "--print-url", "--json"], rt);
    await vi.waitFor(() => expect(rt.errors.some((line) => line.includes("/authorize?"))).toBe(true));
    await fetch(rt.errors.find((line) => line.includes("/authorize?"))!); expect(await login).toBe(0);
    const backend = new LocalSecretsBackend({ dir: join(root, ".fentaris"), key });
    const vault = new McpVaultOAuthTokenStore({ vault: { resolve: (ref) => backend.resolve(ref), set: (ref, value) => backend.setInternal(ref, value) }, connections: [{ server: "mail", account: "work" }] });
    const original = (await vault.get("mail", "account:work"))!;
    await vault.set("mail", "account:work", { ...original, tokens: { ...original.tokens!, obtainedAt: 0, expires_in: 1 } });
    authorization.expireAccessTokens();
    const requests = authorization.tokenRequests;
    expect(await main(["mcp", "tools", "mail", "--json"], rt)).toBe(0);
    expect(authorization.tokenRequests).toBeGreaterThan(requests);
    const refreshed = await vault.get("mail", "account:work"); expect(refreshed?.tokens?.access_token).not.toBe(original.tokens?.access_token);
    const before = await readFile(join(root, ".fentaris", "mcp-connections.json"), "utf8");
    rt.errors.length = 0;
    const cancelled = main(["mcp", "auth", "connect", "mail", "--reauth", "--print-url", "--json"], rt);
    await vi.waitFor(() => expect(rt.errors.some((line) => line.includes("/authorize?"))).toBe(true));
    const authUrl = new URL(rt.errors.find((line) => line.includes("/authorize?"))!); const callback = authUrl.searchParams.get("redirect_uri")!;
    process.emit("SIGINT"); expect(await cancelled).toBe(1);
    expect(await vault.get("mail", "account:work")).toEqual(refreshed);
    expect(await readFile(join(root, ".fentaris", "mcp-connections.json"), "utf8")).toBe(before);
    await expect(fetch(callback)).rejects.toThrow();
    authorization.toggles.rejectRegistration = true;
    expect(await main(["mcp", "auth", "connect", "mail", "--reauth", "--print-url", "--json"], rt)).toBe(1);
    expect(json(rt).error.message).toContain("provider could not start OAuth");
    expect(await vault.get("mail", "account:work")).toEqual(refreshed);
  });
  it("uses a preregistered loopback callback's exact port and path and rejects incompatible redirects", async () => {
    const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const redirect = `http://127.0.0.1:${port}/registered/callback`;
    const authorization = await startAuthorizationServer(); cleanups.push(() => authorization.close());
    authorization.preregister({ client_id: "registered", redirect_uris: [redirect] });
    const protectedServer = await startProtectedMcpServer({ authorizationServer: authorization }); cleanups.push(() => protectedServer.close());
    const root = await project(`{ servers: [mcp('mail', { transport: streamableHttp({ url: ${JSON.stringify(protectedServer.url)}, network: { allowPrivateNetworkUrls: true } }), auth: oauth({ registration: 'preregistered', clientId: 'registered', redirectUrl: ${JSON.stringify(redirect)} }) })] }`);
    const rt = runtime(root);
    expect(await main(["mcp", "auth", "connect", "mail", "--print-url", "--port", String(port + 1), "--json"], rt)).toBe(1);
    expect(json(rt).error.message).toContain("--port must match");
    const login = main(["mcp", "auth", "connect", "mail", "--print-url", "--json"], rt);
    await vi.waitFor(() => expect(rt.errors.some((line) => line.includes("/authorize?"))).toBe(true));
    const url = rt.errors.find((line) => line.includes("/authorize?"))!;
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(redirect);
    expect((await fetch(url)).status).toBe(200); expect(await login).toBe(0);
    await expect(fetch(redirect)).rejects.toThrow();
    const hosted = runtime(await project(`{ servers: [mcp('hosted', { transport: streamableHttp({ url: 'https://example.com/mcp' }), auth: oauth({ redirectUrl: 'https://example.com/callback' }) })] }`));
    expect(await main(["mcp", "auth", "connect", "hosted", "--print-url", "--json"], hosted)).toBe(1);
    expect(json(hosted).error.message).toContain("HTTP loopback redirect");
  });
  it("performs client-credentials OAuth without a terminal, browser, or implicit incoming identity", async () => {
    const authorization = await startAuthorizationServer(); cleanups.push(() => authorization.close());
    authorization.preregister({ client_id: "service", client_secret: "service-secret", redirect_uris: [], grant_types: ["client_credentials"] });
    const protectedServer = await startProtectedMcpServer({ authorizationServer: authorization }); cleanups.push(() => protectedServer.close());
    const root = await project(`{ servers: [mcp('service', { transport: streamableHttp({ url: ${JSON.stringify(protectedServer.url)}, network: { allowPrivateNetworkUrls: true } }), accounts: { bot: { auth: oauth.clientCredentials({ clientId: 'service', clientSecret: credential('service.clientSecret') }) } } })] }`, { 'service.clientSecret': 'service-secret' });
    const rt = runtime(root);
    expect(await main(["mcp", "auth", "connect", "service", "--json", "--non-interactive"], rt)).toBe(0);
    expect(json(rt).data.status).toBe("connected"); expect(rt.prompt.text).not.toHaveBeenCalled(); expect(rt.errors).toEqual([]);
    expect(await main(["mcp", "tools", "service", "--json"], rt)).toBe(0);
  });
  it("explains no-auth/managed flows and never disables an unauthenticated connection on disconnect", async () => {
    const rt = runtime(await project(`{ servers: [mcp('local', { transport: new Fake() }), mcp('managed', { transport: new Fake(), auth: { type: 'managed' } })] }`));
    expect(await main(["mcp", "auth", "disconnect", "local", "--json"], rt)).toBe(0); expect(json(rt).data.status).toBe("unnecessary");
    expect(await main(["mcp", "auth", "connect", "managed", "--json"], rt)).toBe(0); expect(json(rt).data.status).toBe("server-managed");
    expect(await main(["mcp", "get", "local", "--json"], rt)).toBe(0);
  });
  it("loads project environment in normal Node startup without an env-file wrapper", async () => {
    const root = await project(plain);
    const entrypoint = pathToFileURL(resolve(import.meta.dirname, "../../core/dist/index.js")).href;
    const env = { ...process.env }; delete env.MCP_297_CONFIG_IMPORT_VALUE;
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(entrypoint)}; console.log(process.env.MCP_297_CONFIG_IMPORT_VALUE);`], { cwd: root, env });
    expect(child.stdout.trim()).toBe("loaded");
    const override = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(entrypoint)}; console.log(process.env.MCP_297_CONFIG_IMPORT_VALUE);`], { cwd: root, env: { ...env, MCP_297_CONFIG_IMPORT_VALUE: "existing" } });
    expect(override.stdout.trim()).toBe("existing");
  });

  it("replaces only the selected account's credentials when its original reference is shared", async () => {
    const root = await project(bearerConfig, { "github.token": "shared-old" }); const rt = runtime(root, true);
    vi.mocked(rt.prompt.text).mockResolvedValue("replacement");
    expect(await main(["mcp", "auth", "connect", "github", "--account", "work", "--reauth"], rt)).toBe(0);
    const state = JSON.parse(await readFile(join(root, ".fentaris", "mcp-connections.json"), "utf8"));
    expect(state.connections[0].bindings.bearer).toBe("github.work.token");
    const store = new LocalSecretsBackend({ dir: join(root, ".fentaris"), key });
    expect(await store.resolve("github.token")).toBe("shared-old"); expect(await store.resolve("github.work.token")).toBe("replacement");
    expect(await main(["mcp", "get", "github", "--account", "home", "--json"], rt)).toBe(0);
  });
  it("prompts for an explicit missing vault key without writing it to project environment", async () => {
    const root = await project(`{ servers: [mcp('github', { transport: new Fake(), auth: bearer(credential('new.token')) })] }`);
    await rm(join(root, ".fentaris", "credentials.enc.json")); await writeFile(join(root, ".env"), "MCP_297_CONFIG_IMPORT_VALUE=loaded\n");
    const rt = runtime(root, true); rt.env = {};
    vi.mocked(rt.prompt.text).mockResolvedValueOnce("new-value").mockResolvedValueOnce(key);
    expect(await main(["mcp", "auth", "connect", "github"], rt)).toBe(0);
    expect(rt.prompt.text).toHaveBeenNthCalledWith(2, "Project vault unlock key", { secret: true });
    expect(await readFile(join(root, ".env"), "utf8")).not.toContain(key);
    expect(await new LocalSecretsBackend({ dir: join(root, ".fentaris"), key }).resolve("new.token")).toBe("new-value");
  });
  it("returns explicit empty inventory and rejects retired commands/unknown flags in one JSON result", async () => {
    const rt = runtime(await project(`{ servers: [] }`));
    expect(await main(["mcp", "tools", "--json"], rt)).toBe(0); expect(json(rt).summary.message).toBe("No MCP servers are configured.");
    rt.output.length = 0;
    expect(await main(["tools", "list", "--json"], rt)).toBe(2); expect(rt.output).toHaveLength(1); expect(json(rt).error.code).toBe("INVALID_INPUT");
    rt.output.length = 0;
    expect(await main(["mcp", "--unknown", "--json"], rt)).toBe(2); expect(rt.output).toHaveLength(1); expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(parseCommand(["mcp", "auth", "connect", "--account", "-h"])).toMatchObject({ kind: "help" });
  });

  it("reports every missing bundle field and reuses explicit named references for each configured slot", async () => {
    const root = await project(`{ servers: [mcp('bundle', { transport: new Fake(), env: { CLIENT_ID: credential('bundle.id'), CLIENT_SECRET: credential('bundle.secret') } })] }`, { "shared.id": "id-value", "shared.secret": "secret-value" });
    const rt = runtime(root);
    expect(await main(["mcp", "auth", "connect", "bundle", "--json"], rt)).toBe(1);
    expect(json(rt).error.missingFields).toEqual(["credential:bundle.id", "credential:bundle.secret"]);
    expect(json(rt).error.nextCommand).toContain("--credential CLIENT_ID=bundle.id"); expect(json(rt).error.nextCommand).toContain("--credential CLIENT_SECRET=bundle.secret");
    expect(await main(["mcp", "auth", "connect", "bundle", "--credential", "CLIENT_ID=shared.id", "--credential", "CLIENT_SECRET=shared.secret", "--json"], rt)).toBe(0);
    const state = JSON.parse(await readFile(join(root, ".fentaris", "mcp-connections.json"), "utf8"));
    expect(state.connections[0].bindings).toEqual({ CLIENT_ID: "shared.id", CLIENT_SECRET: "shared.secret" });
    expect(rt.output.join("\n")).not.toContain("secret-value");
    expect(await main(["mcp", "auth", "connect", "bundle", "--credential", "BOGUS=shared.id", "--json"], rt)).toBe(1);
  });
  it("preserves supplied secret/account flags in complete noninteractive recovery commands without exposing keys", async () => {
    const rt = runtime(await project(bearerConfig, { shared: "token" }));
    expect(await main(["mcp", "auth", "connect", "--secret", "shared", "--account", "work", "--key", key, "--json"], rt)).toBe(1);
    expect(json(rt).error.nextCommand).toContain("--secret shared"); expect(json(rt).error.nextCommand).toContain("--account work");
    expect(json(rt).error.nextCommand).not.toContain(key); expect(json(rt).error.nextCommand).toContain("--key <VAULT_UNLOCK_KEY>"); expect(rt.prompt.text).not.toHaveBeenCalled();
  });

});
