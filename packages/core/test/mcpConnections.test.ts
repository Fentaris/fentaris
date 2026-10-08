import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bearer, mcp } from "../src/server/McpServer.js";
import { credential as ref, credentialEnv } from "../src/credentials/index.js";
import { McpDiscoveryService } from "../src/mcp/discovery.js";
import { MemoryOAuthTokenStore } from "../src/auth/oauth/store.js";
import { oauth, oauthSessionKeyFor } from "../src/auth/oauth/dsl.js";
import { OAuthManager } from "../src/auth/oauth/manager.js";
import { McpVaultOAuthTokenStore, mcpOAuthSecretReference } from "../src/mcp/vaultOAuthStore.js";
import { applyMcpConnectionState, readMcpConnectionState, writeMcpConnectionState, updateMcpConnectionState } from "../src/mcp/projectState.js";
import { loadProjectEnvironment, applyProjectEnvironment } from "../src/environment.js";
import { fentaris, Policy, streamableHttp, stdio, LocalSecretsBackend, validateFentarisConfig } from "../src/index.js";
import type { FentarisTransport } from "../src/types/transport.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const tool = { name: "search", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const } };
function transport(run = async () => ({ tools: [tool] })): FentarisTransport {
  return { listTools: vi.fn(run), callTool: vi.fn(async () => ({ content: [] })), close: vi.fn(async () => undefined) };
}
async function directory() { const dir = await mkdtemp(join(tmpdir(), "fentaris-mcp-")); cleanups.push(() => rm(dir, { force: true, recursive: true })); return dir; }

describe("named upstream MCP connections", () => {
  it("splits upstream accounts without requiring a downstream identity, keeps healthy results, and cleans failed checks", async () => {
    const good = transport();
    const bad = transport(async () => { throw new Error("provider accidentally includes access_token=do-not-print"); });
    const service = new McpDiscoveryService({ servers: [mcp("mail", { transport: good, accounts: { alice: {}, bob: {} } }), mcp("bad", { transport: bad })] }, { secrets: async () => undefined });
    const result = await service.discover({ timeoutMs: 50 });
    expect(result).toMatchObject({ outcome: "partial", exitCode: 3, summary: { succeeded: 2, failed: 1, tools: 2 } });
    expect(result.connections.map((row) => [row.server, row.account, row.toolCount])).toEqual([["mail", "alice", 1], ["mail", "bob", 1], ["bad", "default", null]]);
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(good.close).toHaveBeenCalled(); expect(bad.close).toHaveBeenCalled();
  });
  it("distinguishes cached descriptions from verified tools in a partial live summary", async () => {
    const result = await new McpDiscoveryService({ servers: [mcp("good", { transport: transport() }), mcp("bad", { transport: transport(async () => { throw new Error("offline"); }) })] }, { secrets: async () => undefined }).discover({ cache: { "bad\u0000default": { checkedAt: 1, tools: [{ ...tool, name: "bad__search", upstreamName: "search" }] } } });
    expect(result).toMatchObject({ outcome: "partial", summary: { tools: 2, verifiedTools: 1, cachedTools: 1 } });
  });
  it("never routes runtime operations to the first account and respects connection restrictions in addition to policy", async () => {
    const work = transport(); const personal = transport();
    const server = mcp("mail", { transport: transport(), accounts: { work: { transport: work, allowedUsers: ["agent"] }, personal: { transport: personal } } });
    await expect(server.callTool({ name: "search" }, { id: "agent" })).rejects.toThrow("explicit upstream account");
    await expect(server.callTool({ name: "search" }, { id: "intruder", upstreamAccounts: { mail: "work" } })).rejects.toThrow("not permitted");
    await server.callTool({ name: "search" }, { id: "agent", upstreamAccounts: { mail: "work" } });
    expect(work.callTool).toHaveBeenCalledTimes(1); expect(personal.callTool).not.toHaveBeenCalled();
    const app = fentaris({ servers: [server], policy: new Policy({ name: "deny" }) }); cleanups.push(() => app.close());
    await expect(app.callTool({ name: "mail__search" }, { id: "agent", upstreamAccounts: { mail: "work" } })).resolves.toMatchObject({ isError: true });
    expect(work.callTool).toHaveBeenCalledTimes(1);
  });
  it("uses the selected account for tool detail discovery and sanitizes credential-bearing endpoints", async () => {
    const source = streamableHttp({ url: "https://user:secret@example.com/mcp?api_key=secret" });
    const offline = await new McpDiscoveryService({ servers: [mcp("endpoint", { transport: source })] }, { secrets: async () => undefined }).discover({ offline: true });
    expect(offline.connections[0].endpoint).toBe("https://example.com/mcp");
    const server = mcp("mail", { transport: source, accounts: { first: { transport: transport() }, second: { transport: transport(async () => ({ tools: [{ ...tool, name: "other" }] })) } } });
    const result = await new McpDiscoveryService({ servers: [server] }, { secrets: async () => undefined }).discover({ account: "second" });
    expect(result.connections).toHaveLength(1); expect(result.connections[0].tools[0].name).toBe("mail__other");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("offline reads never contact upstreams and cached zero is distinguished from unavailable metadata", async () => {
    const upstream = transport(); const server = mcp("local", { transport: upstream });
    const service = new McpDiscoveryService({ servers: [server] }, { secrets: async () => undefined });
    const uncached = await service.discover({ offline: true });
    expect(uncached.connections[0]).toMatchObject({ connectivity: "unverified", toolCount: null, toolMetadata: { source: "unavailable" } });
    const cached = await service.discover({ offline: true, cache: { "local\u0000default": { checkedAt: Date.now() - 5000, tools: [] } } });
    expect(cached.connections[0]).toMatchObject({ toolCount: 0, toolMetadata: { source: "cached" } });
    expect(cached.connections[0].toolMetadata.ageMs).toBeGreaterThanOrEqual(5000);
    expect(upstream.listTools).not.toHaveBeenCalled();
  });
  it("keeps configuration validity, missing/expired/invalid authorization, and connectivity separate", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set("expired", "account:default", { updatedAt: 1, tokens: { access_token: "expired", token_type: "Bearer", obtainedAt: 0, expires_in: 1 } });
    await store.set("rejected", "account:default", { updatedAt: Date.now(), tokens: { access_token: "rejected", token_type: "Bearer", obtainedAt: Date.now() } });
    const http = (name: string) => mcp(name, { transport: streamableHttp({ url: "http://127.0.0.1:9999/mcp", network: { allowPrivateNetworkUrls: true }, fetch: async () => new Response("Unauthorized", { status: 401 }) }), auth: oauth() });
    const service = new McpDiscoveryService({ servers: [http("missing"), http("expired"), http("rejected"), mcp("invalid", { transport: {} as FentarisTransport })] }, { secrets: async () => undefined, oauthStore: store });
    const result = await service.discover({ timeoutMs: 100 });
    expect(result.connections[0]).toMatchObject({ configuration: { valid: true }, authentication: { state: "missing" }, connectivity: "not-checked", toolCount: null });
    expect(result.connections[1]).toMatchObject({ configuration: { valid: true }, authentication: { state: "expired" } });
    expect(result.connections[2]).toMatchObject({ configuration: { valid: true }, authentication: { state: "invalid" } });
    expect(result.connections[3]).toMatchObject({ configuration: { valid: false }, toolCount: null });
  });
  it("labels managed authentication without inventing an identity or remote verification", async () => {
    const result = await new McpDiscoveryService({ servers: [mcp("managed", { transport: transport(), auth: { type: "managed" } })] }, { secrets: async () => undefined }).discover();
    expect(result.connections[0].authentication).toMatchObject({ state: "server-managed", verified: false });
    expect(result.connections[0].authentication.providerIdentity).toBeUndefined();
  });
  it("bounds hanging checks, closes transports, and reports an explicit no-tools state", async () => {
    const hanging = transport(() => new Promise(() => undefined));
    const empty = transport(async () => ({ tools: [] }));
    const result = await new McpDiscoveryService({ servers: [mcp("hanging", { transport: hanging }), mcp("empty", { transport: empty })] }, { secrets: async () => undefined }).discover({ timeoutMs: 20 });
    expect(result.connections[0]).toMatchObject({ connectivity: "timeout", toolCount: null, error: { code: "TIMEOUT" } });
    expect(result.connections[1]).toMatchObject({ toolCount: 0, recovery: [expect.stringContaining("exposes no tools")] });
    expect(hanging.close).toHaveBeenCalled();
  });
  it("keeps OAuth accounts outside downstream user scopes and preserves legacy tokens during explicit migration", async () => {
    expect(oauthSessionKeyFor({ ...oauth(), account: "work" }, { id: "downstream" })).toBe("account:work");
    const manager = new OAuthManager(); manager.register("mail", { auth: { ...oauth(), account: "work" }, serverUrl: "https://example.com/mcp" });
    expect(manager.sessionKeyFor("mail", { id: "client", upstreamAccounts: { mail: "work" } })).toBe("account:work");
    const values = new Map<string, string>(); const legacy = new MemoryOAuthTokenStore();
    const record = { updatedAt: 1, tokens: { access_token: "secret", token_type: "Bearer", obtainedAt: 1 } };
    await legacy.set("mail", "user:alice", record);
    const vault = new McpVaultOAuthTokenStore({ vault: { resolve: async (ref) => values.get(ref), set: async (ref, value) => { values.set(ref, value); } }, connections: [{ server: "mail", account: "work" }, { server: "mail", account: "home" }], legacyStore: legacy });
    expect(await vault.get("mail", "account:work")).toBeUndefined();
    await vault.set("mail", "account:work", record); await vault.set("mail", "account:home", record);
    await vault.delete("mail", "account:work");
    expect((await vault.get("mail", "account:home"))?.tokens?.access_token).toBe("secret");
    expect((await legacy.get("mail", "user:alice"))?.tokens?.access_token).toBe("secret");
    expect(values.has(mcpOAuthSecretReference("mail", "work"))).toBe(true);
    expect(JSON.stringify(await vault.list())).not.toContain("secret");
  });
  it("writes and applies only public account bindings and blocks disconnected runtime use", async () => {
    const dir = await directory();
    const state = { version: 1 as const, connections: [{ server: "github", account: "work", bindings: { bearer: "github.work.token" }, updatedAt: 1, disconnected: true }], sources: { "github.work.token": { type: "environment" as const, name: "GITHUB_TOKEN" } } };
    await writeMcpConnectionState(dir, state);
    const server = mcp("github", { transport: streamableHttp({ url: "https://example.com/mcp" }), accounts: { work: { auth: bearer(ref("placeholder")) } } });
    applyMcpConnectionState([server], readMcpConnectionState(dir));
    expect(server.account("work").getCredentialBindings()[0].credential.reference).toBe("github.work.token");
    await expect(server.listTools(undefined, { upstreamAccounts: { github: "work" } })).rejects.toThrow("disconnected");
    expect(await readFile(join(dir, "mcp-connections.json"), "utf8")).not.toContain("Bearer");
  });
  it("loads .env with Node syntax and preserves defined process values, including empty strings", async () => {
    const dir = await directory(); await writeFile(join(dir, ".env"), 'MCP_TEST_VALUE="from file"\nMCP_TEST_MULTILINE="first\nsecond"\n');
    expect(loadProjectEnvironment(dir, { MCP_TEST_VALUE: "" })).toMatchObject({ MCP_TEST_VALUE: "", MCP_TEST_MULTILINE: "first\nsecond" });
    vi.stubEnv("MCP_TEST_VALUE", "from process"); applyProjectEnvironment(dir); expect(process.env.MCP_TEST_VALUE).toBe("from process"); vi.unstubAllEnvs(); delete process.env.MCP_TEST_MULTILINE;
  });
  it("does not invent provider identity and calls explicit inspection only for successful live checks", async () => {
    const identity = vi.fn(async () => ({ identity: { email: "provider@example.com" }, permissions: ["mail.read"] }));
    const service = new McpDiscoveryService({ servers: [mcp("mail", { transport: transport(), accounts: { localAlias: { inspectIdentity: identity } } })] }, { secrets: async () => undefined });
    const offline = await service.discover({ offline: true });
    expect(identity).not.toHaveBeenCalled(); expect(offline.connections[0].authentication.providerIdentity).toBeUndefined();
    const live = await service.discover();
    expect(live.connections[0].authentication).toMatchObject({ providerIdentity: { email: "provider@example.com" }, permissions: ["mail.read"] });
  });
  it("distinguishes a locked local vault from an unreachable upstream without contacting it", async () => {
    const upstream = transport();
    const result = await new McpDiscoveryService({ servers: [mcp("private", { transport: upstream, auth: bearer(ref("token")) })] }, { secrets: async () => { throw new Error("locked vault"); } }).discover();
    expect(result.connections[0]).toMatchObject({ configuration: { valid: true }, connectivity: "not-checked", status: "Credentials unavailable", error: { code: "CREDENTIALS_UNAVAILABLE" } });
    expect(upstream.listTools).not.toHaveBeenCalled();
  });
  it("serializes concurrent encrypted writes without dropping unrelated shared values or exposing OAuth records", async () => {
    const dir = await directory(); const key = "concurrent-test-key";
    await Promise.all(Array.from({ length: 8 }, (_, index) => new LocalSecretsBackend({ dir, key }).set(`ref.${index}`, `value.${index}`, { kind: "default" })));
    const store = new LocalSecretsBackend({ dir, key });
    for (let index = 0; index < 8; index++) expect(await store.resolve(`ref.${index}`)).toBe(`value.${index}`);
    expect(await readFile(join(dir, "credentials.enc.json"), "utf8")).not.toContain("value.");
  });
  it("terminates a real hanging stdio handshake when bounded discovery finishes", async () => {
    const dir = await directory(); const pidFile = join(dir, "child.pid");
    const script = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const upstream = stdio({ command: process.execPath, args: ["--input-type=module", "-e", script] });
    cleanups.push(() => upstream.close());
    const result = await new McpDiscoveryService({ servers: [mcp("hanging", { transport: upstream })] }, { secrets: async () => undefined }).discover({ timeoutMs: 1000 });
    expect(result.connections[0]).toMatchObject({ connectivity: "timeout", toolCount: null });
    const pid = Number(await readFile(pidFile, "utf8"));
    cleanups.push(async () => { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
  });

  it("preserves healthy inventory beside invalid aliases and validates account-specific OAuth configuration", async () => {
    const store = new MemoryOAuthTokenStore();
    const result = await new McpDiscoveryService({ servers: [mcp("bad", { transport: transport(), accounts: { 'user:client': {} } }), mcp("good", { transport: transport() })] }, { secrets: async () => undefined, oauthStore: store }).discover();
    expect(result.outcome).toBe("partial"); expect(result.connections[0].configuration.valid).toBe(false); expect(result.connections[1].status).toBe("Ready");
    const validation = validateFentarisConfig({ servers: [mcp("service", { transport: streamableHttp({ url: "https://example.com/mcp" }), accounts: { bot: { auth: oauth.clientCredentials({ clientId: "service", clientSecret: ref("service.secret") }) } } })] });
    expect(validation.errors.some((error) => error.code === "FENTARIS_CONFIG_OAUTH_CLIENT_SECRET_UNRESOLVED")).toBe(false);
    const unsupported = validateFentarisConfig({ servers: [mcp("bad", { transport: transport(), accounts: { work: { auth: oauth() } } })] });
    expect(unsupported.errors.some((error) => error.code === "FENTARIS_CONFIG_OAUTH_TRANSPORT_UNSUPPORTED")).toBe(true);
  });
  it("reserves OAuth lifecycle references from ordinary secret writes and deletes", async () => {
    const store = new LocalSecretsBackend({ dir: await directory(), key: "test-key" });
    const reference = mcpOAuthSecretReference("mail", "work");
    await store.setInternal(reference, "lifecycle");
    await expect(store.set(reference, "overwrite", { kind: "default" })).rejects.toThrow("managed by MCP");
    await expect(store.unset(reference, { kind: "default" })).rejects.toThrow("Disconnect");
    expect(await store.resolve(reference)).toBe("lifecycle"); expect(await store.listRefs()).toEqual([]);
  });

  it("cancels pending native HTTP/OAuth requests when a temporary account closes", async () => {
    let signal: AbortSignal | null | undefined;
    const source = streamableHttp({ url: "http://127.0.0.1:9999/mcp", network: { allowPrivateNetworkUrls: true }, fetch: async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("closed request")), { once: true }));
    } });
    const fetchFn = source.createGuardedFetch();
    const pending = expect(fetchFn("http://127.0.0.1:9999/token")).rejects.toThrow("closed request");
    await vi.waitFor(() => expect(signal).toBeDefined());
    await source.close(); await pending; expect(signal?.aborted).toBe(true);
    expect(() => fetchFn("http://127.0.0.1:9999/token")).toThrow();
  });

  it("observes account connect/disconnect bindings on a running proxy without damaging another connection", async () => {
    const dir = await directory(); const key = "runtime-binding-test-key";
    vi.stubEnv("FENTARIS_AUTH_KEY", key); vi.stubEnv("MCP_RUNNING_TOKEN", "original"); cleanups.push(async () => vi.unstubAllEnvs());
    const calls: string[] = [];
    class Upstream {
      constructor(private readonly user: Record<string, unknown> = {}) {}
      withUser(user: Record<string, unknown>) { return new Upstream(user); }
      async listTools() { return { tools: [tool] }; }
      async callTool() { calls.push((this.user.__fentarisUpstreamEnv as Record<string, string>).AUTHORIZATION); return { content: [] }; }
      async close() {}
    }
    const server = mcp("github", { transport: new Upstream(), auth: bearer(ref("original")), accounts: { work: {}, home: {} } });
    const app = fentaris({ servers: [server], defaults: { credentials: { original: credentialEnv("MCP_RUNNING_TOKEN") } }, oauth: { authDir: dir } }); cleanups.push(() => app.close());
    const user = (account: string) => ({ id: "client", upstreamAccounts: { github: account } });
    expect((await app.callTool({ name: "github__search" }, user("work"))).isError).not.toBe(true);
    const store = new LocalSecretsBackend({ dir, key }); await store.set("replacement", "new", { kind: "default" });
    const state = { version: 1 as const, connections: [{ server: "github", account: "work", disconnected: true, bindings: { bearer: "replacement" }, updatedAt: 1 }], sources: { replacement: { type: "vault" as const } } };
    await writeMcpConnectionState(dir, state);
    expect((await app.callTool({ name: "github__search" }, user("work"))).isError).toBe(true);
    expect((await app.callTool({ name: "github__search" }, user("home"))).isError).not.toBe(true);
    state.connections[0].disconnected = false; state.connections[0].updatedAt = 2; await writeMcpConnectionState(dir, state);
    expect((await app.callTool({ name: "github__search" }, user("work"))).isError).not.toBe(true);
    expect(calls).toEqual(["Bearer original", "Bearer original", "Bearer new"]);
  });

  it("serializes concurrent account registry updates while retaining every independent connection", async () => {
    const dir = await directory();
    await Promise.all(["one", "two", "three"].map((account) => updateMcpConnectionState(dir, (state) => {
      state.connections.push({ server: "mail", account, updatedAt: Date.now() }); return state;
    })));
    expect(readMcpConnectionState(dir).connections.map((entry) => entry.account).sort()).toEqual(["one", "three", "two"]);
  });

  it("starts with an explicitly bound vault source even when its previous environment source is unavailable", async () => {
    const dir = await directory(); const key = "source-binding-test-key";
    vi.stubEnv("FENTARIS_AUTH_KEY", key); vi.stubEnv("MCP_297_MISSING_SOURCE", undefined); cleanups.push(async () => vi.unstubAllEnvs());
    await new LocalSecretsBackend({ dir, key }).set("token", "vault-value", { kind: "default" });
    await writeMcpConnectionState(dir, { version: 1, connections: [{ server: "github", account: "work", bindings: { bearer: "token" }, updatedAt: 1 }], sources: { token: { type: "vault" } } });
    const source = streamableHttp({ url: "https://example.com/mcp" });
    const app = fentaris({ servers: [mcp("github", { transport: source, accounts: { work: { auth: bearer(ref("token")) } } })], defaults: { credentials: { token: credentialEnv("MCP_297_MISSING_SOURCE") } }, oauth: { authDir: dir } }); cleanups.push(() => app.close());
    await expect(app.start({ host: "127.0.0.1", port: 0 })).resolves.toHaveProperty("listening", true);
  });

});
