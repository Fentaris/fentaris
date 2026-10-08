import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { credentialVault, resolveCredentialSource } from "../../src/credentials/credentials.js";
import { createServer } from "node:http";
import { fentaris } from "../../src/proxy/McpProxy.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FentarisAuth, ProjectVault, projectVaultIdentityStrategy, loadProjectEnvironment, credential, Logger, VaultWriteVerificationError } from "@fentaris/core";
import { decryptEnvelope, encryptEnvelope, encryptedEnvelopeSchema } from "../../src/auth/envelope.js";

const roots: string[] = [];
const unlockKey = "test-vault-unlock-key";
async function fixture(env: NodeJS.ProcessEnv = { FENTARIS_VAULT_KEY: unlockKey }) {
  const root = await mkdtemp(path.join(tmpdir(), "fentaris-vault-")); roots.push(root);
  return { root, vault: await ProjectVault.open({ root, env }) };
}
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("project vault", () => {
  it("encrypts values separately, reports metadata, and preserves references/consumers on update and removal", async () => {
    const { root, vault } = await fixture();
    await vault.set("github.work.token", "first-sensitive-value");
    const consumer = { kind: "mcp", server: "github", account: "work" } as const;
    await vault.bind("github.work.token", { type: "vault" }, { consumer });
    await vault.set("github.work.token", "second-sensitive-value");
    const inventory = await vault.inventory({ offline: true });
    expect(inventory[0]).toMatchObject({ reference: "github.work.token", source: { type: "vault" }, state: "present", remoteValidity: "unverified", consumers: [consumer] });
    expect(JSON.stringify(inventory)).not.toContain("sensitive-value");
    expect(await readFile(path.join(root, ".fentaris/vault.json"), "utf8")).not.toContain("sensitive-value");
    expect(await vault.resolve("github.work.token")).toBe("second-sensitive-value");
    await expect(vault.remove("github.work.token")).rejects.toThrow("in use");
    await vault.remove("github.work.token", { force: true });
    expect(await vault.get("github.work.token")).toMatchObject({ state: "missing", consumers: [consumer], nextActions: ["fentaris secrets set github.work.token"] });
  });
  it("disconnects one of two consumers without deleting their shared value", async () => {
    const { vault } = await fixture();
    await vault.set("shared", "shared-value");
    const a = { kind: "mcp", server: "github", account: "a" } as const;
    const b = { ...a, account: "b" };
    await vault.bind("shared", { type: "vault" }, { consumer: a });
    await vault.bind("shared", { type: "vault" }, { consumer: b });
    await vault.detachConsumer("shared", a);
    expect(await vault.resolve("shared")).toBe("shared-value");
    expect((await vault.get("shared"))?.consumers).toEqual([b]);
  });
  it("requires explicit source changes and never falls back to environment or copies values", async () => {
    const { root } = await fixture();
    const vault = await ProjectVault.open({ root, env: { FENTARIS_VAULT_KEY: unlockKey, TOKEN: "env-sensitive" } });
    await vault.set("token", "vault-sensitive");
    await expect(vault.bind("token", { type: "environment", name: "TOKEN" })).rejects.toThrow("Explicitly");
    await vault.bind("token", { type: "environment", name: "TOKEN" }, { replaceSource: true });
    expect(await vault.resolve("token")).toBe("env-sensitive");
    await expect(vault.set("token", "new-sensitive")).rejects.toThrow("another source");
    await expect(vault.remove("token", { force: true })).rejects.toThrow("managed by");
    const missing = await ProjectVault.open({ root, env: { FENTARIS_VAULT_KEY: unlockKey } });
    expect(await missing.resolve("token")).toBeUndefined();
    expect((await missing.get("token"))?.state).toBe("missing");
  });
  it("allows environment-only metadata without creating an unlock key or copying .env values", async () => {
    const { root, vault } = await fixture({ TOKEN: "environment-only" });
    await vault.bind("github", { type: "environment", name: "TOKEN" });
    expect(await vault.resolve("github")).toBe("environment-only");
    const file = await readFile(path.join(root, ".fentaris/vault.json"), "utf8");
    expect(file).not.toContain("environment-only");
    expect(JSON.parse(file).encrypted).toBeUndefined();
    await expect(readFile(path.join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("supports an injected system store, and never regenerates missing keys over an existing vault", async () => {
    const { root } = await fixture();
    const keys = new Map<string, string>();
    const store = { get: vi.fn(async (id: string) => keys.get(id)), set: vi.fn(async (id: string, value: string) => { keys.set(id, value); }) };
    const vault = await ProjectVault.open({ root, env: {}, credentialStore: store });
    await vault.set("token", "secret");
    expect(store.set).toHaveBeenCalledTimes(1);
    const before = await readFile(vault.file, "utf8");
    keys.clear();
    expect((await vault.get("token"))?.state).toBe("locked");
    await expect(vault.set("token", "replacement")).rejects.toThrow("never be regenerated");
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(await readFile(vault.file, "utf8")).toBe(before);
    await expect(readFile(path.join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("documents an explicit unlock alternative and does not silently use plaintext on unsupported systems", async () => {
    const { root, vault } = await fixture({});
    await expect(vault.set("token", "secret")).rejects.toThrow("FENTARIS_VAULT_KEY");
    await expect(readFile(vault.file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("isolates projects, rejects copied identities, and treats symlink access as the same project", async () => {
    const a = await fixture(); const b = await fixture();
    await a.vault.set("token", "a-only");
    expect(await b.vault.resolve("token")).toBeUndefined();
    await mkdir(path.join(b.root, ".fentaris"));
    await cp(a.vault.file, b.vault.file);
    await expect(b.vault.inventory()).rejects.toThrow("another project");
    const link = path.join(b.root, "a-link"); await symlink(a.root, link);
    const aliased = await ProjectVault.open({ root: link, env: { FENTARIS_VAULT_KEY: unlockKey } });
    expect(await aliased.resolve("token")).toBe("a-only");
    await expect(ProjectVault.open({ root: a.root, dir: "../other" })).rejects.toThrow("inside its project");
  });
  it("does not invoke external providers offline and sanitizes arbitrary provider errors online", async () => {
    const { root } = await fixture();
    const resolve = vi.fn(async () => { throw new Error("Bearer provider-sensitive https://user:password@example.test/?token=secret"); });
    const vault = await ProjectVault.open({ root, env: {}, externalProviders: { cloud: { resolve } } });
    await vault.bind("token", { type: "external", provider: "cloud", locator: "github-token" });
    expect((await vault.get("token", { offline: true }))?.state).toBe("unverified");
    expect(resolve).not.toHaveBeenCalled();
    expect((await vault.get("token"))?.state).toBe("unresolvable");
    await expect(vault.resolve("token")).rejects.toThrow("error details were redacted");
  });
  it("keeps reference validation errors free of secret values", async () => {
    const { vault } = await fixture();
    await expect(vault.set("https://token-sensitive", "raw-sensitive")).rejects.toThrow("Secret reference must contain");
    expect(await vault.inventory()).toEqual([]);
  });
  it("migrates explicit scoped mappings and hashes legacy client values without modifying the recoverable original", async () => {
    const { root, vault } = await fixture();
    const old = { defaults: { token: "legacy-sensitive" }, groups: { staff: { token: "group-sensitive" } }, users: { pi: { credentials: {}, apiKeys: ["old-incoming-raw"] } } };
    const file = path.join(root, "legacy.enc.json");
    const contents = JSON.stringify(FentarisAuth.encryptCredentials(old, "old-unlock")); await writeFile(file, contents);
    const result = await vault.migrateLegacy({ file, key: "old-unlock", mappings: [{ reference: "token", scope: "default", target: "work.token" }, { reference: "token", scope: "group:staff", target: "staff.token" }], incomingKeys: true });
    expect(result).toEqual({ references: 2, keys: 1, verified: true, legacyPreserved: true });
    expect(await vault.resolve("work.token")).toBe("legacy-sensitive");
    expect(await vault.resolve("staff.token")).toBe("group-sensitive");
    expect(await vault.authenticate("old-incoming-raw")).toBe("pi");
    expect(await readFile(file, "utf8")).toBe(contents);
    expect(JSON.stringify(await vault.keys())).not.toContain("old-incoming-raw");
    await expect(vault.migrateLegacy({ file, key: "wrong", mappings: [] })).rejects.toThrow("Unable to decrypt");
    expect(await readFile(file, "utf8")).toBe(contents);
  });
  it("rejects duplicate/missing migration targets atomically without dropping existing data", async () => {
    const { root, vault } = await fixture();
    await vault.set("existing", "preserved");
    const file = path.join(root, "old.enc.json");
    await writeFile(file, JSON.stringify(FentarisAuth.encryptCredentials({ defaults: { a: "a-value" }, groups: {}, users: {} }, "old")));
    const before = await readFile(vault.file, "utf8");
    await expect(vault.migrateLegacy({ file, key: "old", mappings: [{ reference: "a", scope: "default", target: "new" }, { reference: "missing", scope: "default", target: "bad" }] })).rejects.toThrow("missing");
    expect(await readFile(vault.file, "utf8")).toBe(before);
    expect(await vault.resolve("new")).toBeUndefined();
  });
  it("preserves the saved vault on bad unlock keys and refuses concurrent writes", async () => {
    const { root, vault } = await fixture(); await vault.set("token", "preserved");
    const before = await readFile(vault.file, "utf8");
    const wrong = await ProjectVault.open({ root, env: { FENTARIS_VAULT_KEY: "wrong" } });
    await expect(wrong.set("token", "overwrite")).rejects.toThrow("Unable to unlock");
    expect(await readFile(vault.file, "utf8")).toBe(before);
    await writeFile(`${vault.file}.lock`, "locked");
    await expect(vault.set("token", "overwrite")).rejects.toThrow("write is in progress");
    expect(await readFile(vault.file, "utf8")).toBe(before);
  });
});

describe("incoming key lifecycle", () => {
  it("stores only a verifier, exposes the raw value once, and revokes by a stable ID immediately", async () => {
    const { vault } = await fixture();
    const created = await vault.createKey("pi-agent", "macbook");
    expect(created.key.id).toMatch(/^fk_/);
    expect(await vault.authenticate(created.sensitiveValue)).toBe("pi-agent");
    const inventory = JSON.stringify(await vault.keys());
    expect(inventory).not.toContain(created.sensitiveValue);
    const state = JSON.parse(await readFile(vault.file, "utf8"));
    const payload = decryptEnvelope(encryptedEnvelopeSchema.parse(state.encrypted), unlockKey, "failed") as { verifiers: Record<string, string> };
    expect(payload.verifiers[created.key.id]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain(created.sensitiveValue);
    const strategy = projectVaultIdentityStrategy(vault.options);
    expect(await strategy.resolve({ headers: { "x-fentaris-api-key": created.sensitiveValue } })).toEqual({ id: "pi-agent" });
    await vault.revokeKey(created.key.id);
    expect(await strategy.resolve({ headers: { "x-fentaris-api-key": created.sensitiveValue } })).toBeNull();
    expect((await vault.keys())[0]?.revokedAt).toBeDefined();
  });
  it("rejects expired and revoked keys, enforces future expiry, and preserves distinct named keys", async () => {
    const { vault } = await fixture();
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const a = await vault.createKey("pi", "a", "2030-01-01T00:01:00Z"); const b = await vault.createKey("pi", "b");
    await expect(vault.createKey("pi", "a")).rejects.toThrow("already exists");
    await expect(vault.createKey("pi", "invalid", "yesterday")).rejects.toThrow("future ISO");
    vi.setSystemTime(new Date("2030-01-01T00:02:00Z"));
    expect(await vault.authenticate(a.sensitiveValue)).toBeNull();
    expect(await vault.authenticate(b.sensitiveValue)).toBe("pi");
    await vault.revokeKey(b.key.id);
    expect(await vault.authenticate(b.sensitiveValue)).toBeNull();
    await expect(vault.revokeKey("unknown")).rejects.toThrow("not found");
  });
  it("detects tampered expiry or source metadata before authentication or resolution", async () => {
    const { vault } = await fixture(); const key = await vault.createKey("pi", "macbook");
    const state = JSON.parse(await readFile(vault.file, "utf8"));
    state.keys[0].expiresAt = "2099-01-01T00:00:00.000Z";
    await writeFile(vault.file, JSON.stringify(state));
    await expect(vault.authenticate(key.sensitiveValue)).rejects.toThrow("metadata was modified");
  });
  it("does not authorize access from possession of a secret reference", async () => {
    const { vault } = await fixture(); await vault.set("github.work.token", "upstream-token");
    expect(await vault.authenticate("github.work.token")).toBeNull();
    expect(await vault.authenticate("upstream-token")).toBeNull();
    // Existing policy is still the authority; the identity strategy does not assign groups or accounts.
    expect(typeof credential("github.work.token").reference).toBe("string");
  });
});

describe("environment precedence", () => {
  it("loads .env automatically and preserves exported values, including explicitly empty values", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, ".env"), 'TOKEN="dotenv-sensitive"\nMULTI="line1\\nline2"\n');
    expect(loadProjectEnvironment(root, { TOKEN: "exported" }).TOKEN).toBe("exported");
    expect(loadProjectEnvironment(root, { TOKEN: "" }).TOKEN).toBe("");
    expect(loadProjectEnvironment(root, {}).TOKEN).toBe("dotenv-sensitive");
  });
});


describe("OAuth lifecycle and recovery contracts", () => {
  const record = { tokens: { access_token: "oauth-access-sensitive", refresh_token: "oauth-refresh-sensitive", token_type: "Bearer", obtainedAt: 1000, expires_in: 3600 }, updatedAt: 1000 };
  it("isolates upstream accounts and session namespaces, refreshes atomically, and hides lifecycle data from secrets", async () => {
    const { root, vault } = await fixture();
    const work = vault.oauthStore("work"), personal = vault.oauthStore("personal");
    await work.set("github", "shared", record);
    await personal.set("github", "shared", { ...record, tokens: { ...record.tokens, access_token: "personal-sensitive" } });
    expect(await work.get("github", "user:work")).toBeUndefined();
    await work.update("github", "shared", (current) => ({ ...current, tokens: { ...current.tokens!, access_token: "refreshed-sensitive" } }));
    const reopened = await ProjectVault.open({ root, env: { FENTARIS_VAULT_KEY: unlockKey } });
    expect((await reopened.oauthStore("work").get("github", "shared"))?.tokens?.access_token).toBe("refreshed-sensitive");
    expect((await personal.get("github", "shared"))?.tokens?.access_token).toBe("personal-sensitive");
    expect(await vault.inventory()).toEqual([]);
    expect(JSON.stringify(await work.list())).not.toContain("sensitive");
    expect(await readFile(vault.file, "utf8")).not.toContain("sensitive");
    const before = await readFile(vault.file, "utf8");
    await expect(work.update("github", "shared", (current) => { throw new Error(`Failed: ${current.tokens!.access_token}`); })).rejects.toThrow("provider details were redacted");
    expect(await readFile(vault.file, "utf8")).toBe(before);
    await work.delete("github", "shared");
    expect(await work.get("github", "shared")).toBeUndefined();
    expect(await personal.get("github", "shared")).toBeDefined();
  });
  it("migrates legacy OAuth sessions only through explicit account mappings and preserves rollback", async () => {
    const { root, vault } = await fixture();
    const file = path.join(root, "old-oauth.enc.json");
    const original = JSON.stringify(encryptEnvelope({ github: { "user:alice": record } }, "old-key"));
    await writeFile(file, original);
    expect(await vault.migrateLegacyOAuth({ file, key: "old-key", mappings: [{ server: "github", session: "user:alice", account: "work" }] })).toEqual({ records: 1, verified: true, legacyPreserved: true });
    expect((await vault.oauthStore("work").get("github", "user:alice"))?.tokens?.refresh_token).toBe("oauth-refresh-sensitive");
    expect(await vault.oauthStore("alice").get("github", "user:alice")).toBeUndefined();
    const before = await readFile(vault.file, "utf8");
    await expect(vault.migrateLegacyOAuth({ file, key: "old-key", mappings: [{ server: "github", session: "user:alice", account: "work" }] })).rejects.toThrow("target exists");
    expect(await readFile(vault.file, "utf8")).toBe(before);
    expect(await readFile(file, "utf8")).toBe(original);
  });
  it("relocates only with explicit previous root and unlock, retains identity and a rollback snapshot", async () => {
    const original = await fixture(), moved = await fixture();
    await original.vault.set("token", "move-sensitive");
    await mkdir(path.join(moved.root, ".fentaris")); await cp(original.vault.file, moved.vault.file);
    const before = await readFile(moved.vault.file, "utf8");
    await expect(ProjectVault.relocate({ root: moved.root, previousRoot: original.root, unlockKey: "wrong" })).rejects.toThrow("unlock");
    expect(await readFile(moved.vault.file, "utf8")).toBe(before);
    const relocated = await ProjectVault.relocate({ root: moved.root, previousRoot: original.root, unlockKey });
    expect(await relocated.resolve("token")).toBe("move-sensitive");
    expect(JSON.parse(await readFile(relocated.file, "utf8")).projectId).toBe(JSON.parse(before).projectId);
    expect(JSON.parse(await readFile(relocated.file + ".relocation-backup", "utf8"))).toEqual(JSON.parse(before));
    expect(await original.vault.resolve("token")).toBe("move-sensitive");
  });
  it("rejects a vault-directory symlink escaping the project", async () => {
    const a = await fixture(), b = await fixture(); await symlink(b.root, path.join(a.root, ".fentaris"));
    await expect(ProjectVault.open({ root: a.root })).rejects.toThrow("outside");
  });
  it("detects a tampered source before calling an external provider or using environment", async () => {
    const { vault, root } = await fixture(); await vault.set("token", "sensitive");
    const state = JSON.parse(await readFile(vault.file, "utf8"));
    state.references[0].source = { type: "environment", name: "TOKEN" };
    await writeFile(vault.file, JSON.stringify(state));
    const modified = await ProjectVault.open({ root, env: { FENTARIS_VAULT_KEY: unlockKey, TOKEN: "redirected-sensitive" } });
    await expect(modified.resolve("token")).rejects.toThrow("metadata was modified");
    expect((await modified.get("token"))?.state).toBe("locked");
  });
  it("reports that a write succeeded when read-back verification fails", async () => {
    const { root } = await fixture();
    let reads = 0;
    const vault = await ProjectVault.open({ root, env: {}, credentialStore: { get: async () => { if (++reads > 1) throw new Error("system store went away"); return undefined; }, set: async () => {} } });
    await expect(vault.set("token", "saved-sensitive")).rejects.toMatchObject({ stored: true, verified: false, constructor: VaultWriteVerificationError });
    const recovered = await ProjectVault.open({ root, unlockKey: "unused" });
    expect(JSON.parse(await readFile(recovered.file, "utf8")).references[0].present).toBe(true);
    expect(await readFile(recovered.file, "utf8")).not.toContain("saved-sensitive");
  });
  it("sanitizes credential URLs, headers, and provider messages in normal structured logs", async () => {
    const write = vi.fn(); const logger = new Logger({ driver: { write } });
    logger.error("provider failed https://alice:password-sensitive@example.test?token=url-sensitive Authorization: Bearer header-sensitive x-fentaris-api-key: legacy-sensitive", { sensitiveValue: "one-time-sensitive", endpoint: "https://user:password-sensitive@example.test?api_key=query-sensitive", detail: "Bearer detail-sensitive", token: "token-sensitive" });
    expect(JSON.stringify(write.mock.calls)).not.toContain("-sensitive");
    expect(JSON.stringify(write.mock.calls)).toContain("redacted");
  });
});


describe("incoming keys through the HTTP runtime", () => {
  it("authenticates an incoming identity and rejects expired and revoked keys on later requests", async () => {
    const { vault } = await fixture();
    const clock = Date.now();
    const expiring = await vault.createKey("pi-agent", "temporary", new Date(clock + 60_000).toISOString());
    const permanent = await vault.createKey("pi-agent", "macbook");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as {port:number}).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const app = fentaris({port,host:"127.0.0.1",identity:{strategy:vault.identityStrategy(),required:true}});
    await app.start();
    const initialize = (value: string) => fetch(`http://127.0.0.1:${port}/mcp`, {method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","x-fentaris-api-key":value},signal:AbortSignal.timeout(3000),body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"vault-test",version:"1"}}})});
    try {
      const accepted = await initialize(permanent.sensitiveValue); expect(accepted.status).toBe(200); await accepted.body?.cancel();
      expect((await initialize("github.work.token")).status).toBe(401);
      await vault.revokeKey(permanent.key.id);
      expect((await initialize(permanent.sensitiveValue)).status).toBe(401);
      vi.spyOn(Date,"now").mockReturnValue(clock + 120_000);
      expect((await initialize(expiring.sensitiveValue)).status).toBe(401);
    } finally { await app.close(); }
  });
});


describe("shared SDK configuration and credential resolution", () => {
  it("resolves the vault source through the existing credential abstraction without environment fallback", async () => {
    const { root, vault } = await fixture(); await vault.set("github.work.token", "source-sensitive");
    const previous = process.env.FENTARIS_VAULT_KEY; process.env.FENTARIS_VAULT_KEY = unlockKey;
    try {
      expect(await resolveCredentialSource(credentialVault("github.work.token", {root}))).toBe("source-sensitive");
      await vault.remove("github.work.token");
      await expect(resolveCredentialSource(credentialVault("github.work.token", {root}))).rejects.toThrow("reference is missing");
    } finally { if(previous === undefined) delete process.env.FENTARIS_VAULT_KEY; else process.env.FENTARIS_VAULT_KEY = previous; }
  });
  it("loads project .env before SDK configuration evaluation without a launch wrapper", async () => {
    const {root} = await fixture(); await writeFile(path.join(root,"package.json"),'{"type":"module"}');
    await writeFile(path.join(root,".env"), 'FENTARIS_ENV_CONTRACT_TEST=dotenv-value\n');
    const entry = pathToFileURL(path.resolve(import.meta.dirname,"../../dist/index.js")).href;
    const config = path.join(root,"config.mjs");
    await writeFile(config, `import ${JSON.stringify(entry)}; export default process.env.FENTARIS_ENV_CONTRACT_TEST;`);
    const env = {...process.env}; delete env.FENTARIS_ENV_CONTRACT_TEST;
    const script = `import value from ${JSON.stringify(pathToFileURL(config).href)}; console.log(value);`;
    const execute = promisify(execFile);
    expect((await execute(process.execPath,["--input-type=module","--eval",script],{cwd:root,env,timeout:4000})).stdout.trim()).toBe("dotenv-value");
    expect((await execute(process.execPath,["--input-type=module","--eval",script],{cwd:root,env:{...env,FENTARIS_ENV_CONTRACT_TEST:"exported-value"},timeout:4000})).stdout.trim()).toBe("exported-value");
  });
  it("supports explicit external secret-manager resource paths", async () => {
    const {root} = await fixture(); const resolve = vi.fn(async()=>"external-sensitive");
    const vault = await ProjectVault.open({root,env:{},externalProviders:{cloud:{resolve}}});
    await vault.bind("github.work.token",{type:"external",provider:"cloud",locator:"projects/123/secrets/github-token/versions/latest"});
    expect(await vault.resolve("github.work.token")).toBe("external-sensitive");
    expect(resolve).toHaveBeenCalledWith("projects/123/secrets/github-token/versions/latest");
    expect(JSON.stringify(await vault.inventory({offline:true}))).not.toContain("external-sensitive");
  });
});
