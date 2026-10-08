import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectVault } from "@fentaris/core";
import { main, parseCommand, type Runtime } from "../src/index.js";

const roots: string[] = [];
async function fixture(): Promise<Runtime> {
  const root = await mkdtemp(path.join(tmpdir(), "fentaris-vault-cli-")); roots.push(root);
  await writeFile(path.join(root, "fentaris.json"), JSON.stringify({ name: "test", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: ".fentaris" }));
  return { cwd: root, env: { FENTARIS_VAULT_KEY: "test-unlock" }, out: { log: vi.fn(), error: vi.fn() }, runner: vi.fn(async () => ({ code: 0 })), probe: vi.fn(() => true), prompt: { text: vi.fn(async () => ""), select: vi.fn(async (_question, choices) => choices[0]!), confirm: vi.fn(async () => true), close: vi.fn() } };
}
function output(rt: Runtime): string { return vi.mocked(rt.out.log).mock.calls.flat().join("\n"); }
function envelope(rt: Runtime) { return JSON.parse(String(vi.mocked(rt.out.log).mock.calls.at(-1)?.[0])); }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("shared progressive input", () => {
  it.each([
    [[], ["User", "Name"], ["pi-agent", "macbook"]],
    [["--user", "pi-agent"], ["Name"], ["macbook"]],
    [["--name", "macbook"], ["User"], ["pi-agent"]],
    [["--name", "macbook", "--user", "pi-agent"], [], []],
    [["--user", "pi-agent", "--name", "macbook"], [], []],
    [["--user", "--name", "macbook"], ["User"], ["pi-agent"]],
    [["--name", "--user", "pi-agent"], ["Name"], ["macbook"]],
  ])("preserves supplied fields and completes only missing fields: %j", async (flags, questions, answers) => {
    const rt = await fixture();
    vi.mocked(rt.prompt.text).mockImplementation(async () => answers.shift() ?? "");
    expect(await main(["auth", "keys", "create", ...flags], rt)).toBe(0);
    expect(vi.mocked(rt.prompt.text).mock.calls.map((call) => call[0])).toEqual(questions);
    const vault = await ProjectVault.open({ root: rt.cwd, env: rt.env });
    expect(await vault.keys()).toEqual([expect.objectContaining({ user: "pi-agent", name: "macbook" })]);
    expect(rt.prompt.confirm).not.toHaveBeenCalled();
  });
  it("requires explicit actions for the bare keys menu", async () => {
    const rt = await fixture(); vi.mocked(rt.prompt.select).mockResolvedValueOnce("List");
    expect(await main(["auth", "keys"], rt)).toBe(0);
    expect(rt.prompt.select).toHaveBeenCalledWith("Action", ["Create", "List", "Revoke"]);
    await expect(readFile(path.join(rt.cwd, ".fentaris/vault.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([["--json"], ["--non-interactive"], []].map((flags) => [flags]))("returns missing fields without prompting in machine mode: %j", async (flags) => {
    const rt = await fixture(); if (!flags.length) rt.nonInteractive = true;
    expect(await main(["auth", "keys", "create", ...flags], rt)).toBe(1);
    expect(rt.prompt.text).not.toHaveBeenCalled(); expect(rt.prompt.select).not.toHaveBeenCalled();
    if (flags.includes("--json")) expect(envelope(rt)).toMatchObject({ ok: false, error: { code: "MISSING_INPUT", missingFields: ["user", "name"], nextActions: [expect.stringContaining("--user")] } });
    else expect(vi.mocked(rt.out.error).mock.calls.flat().join(" ")).toContain("Missing required fields: user, name");
  });
  it("returns missing action for bare JSON keys without selecting a mutation", async () => {
    const rt = await fixture(); expect(await main(["auth", "keys", "--json"], rt)).toBe(1);
    expect(envelope(rt).error.missingFields).toEqual(["action"]); expect(rt.prompt.select).not.toHaveBeenCalled();
  });
  it.each([
    ["--user", "", "--name", "macbook"], ["--user", "invalid user", "--name", "macbook"], ["--user", "pi", "--name", "../macbook"], ["--user", "pi", "--name", "macbook", "--expires", "yesterday"],
  ].map((flags) => [flags]))("rejects invalid supplied values without silently replacing them: %j", async (flags) => {
    const rt = await fixture(); expect(await main(["auth", "keys", "create", ...flags], rt)).toBe(1);
    expect(rt.prompt.text).not.toHaveBeenCalled();
    await expect(readFile(path.join(rt.cwd, ".fentaris/vault.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects unknown, duplicate, and credential-value flags without exposing their inline values", async () => {
    const rt = await fixture();
    expect(await main(["secrets", "set", "token", "--value=argument-sensitive", "--json"], rt)).toBe(2);
    expect(output(rt)).not.toContain("argument-sensitive");
    expect(parseCommand(["auth", "keys", "create", "--user", "a", "--user", "b"])).toMatchObject({ kind: "parse-error" });
    expect(parseCommand(["auth", "keys", "create", "--unknown"])).toMatchObject({ kind: "parse-error" });
  });
  it("leaves no credential state or key after cancellation at a missing field or secret prompt", async () => {
    for (const argv of [["auth", "keys", "create", "--user", "pi"], ["secrets", "set", "token"]]) {
      const rt = await fixture(); vi.mocked(rt.prompt.text).mockRejectedValueOnce(new Error("Prompt cancelled."));
      expect(await main(argv, rt)).toBe(1);
      await expect(readFile(path.join(rt.cwd, ".fentaris/vault.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(rt.cwd, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("vault command outputs", () => {
  it("uses hidden input, accepts --stdin, and reports only metadata in subsequent JSON or inventory", async () => {
    const rt = await fixture(); vi.mocked(rt.prompt.text).mockResolvedValueOnce("hidden-sensitive");
    expect(await main(["secrets", "set", "github.work.token"], rt)).toBe(0);
    expect(rt.prompt.text).toHaveBeenCalledWith("Secret value", { secret: true });
    expect(output(rt)).not.toContain("hidden-sensitive");
    rt.stdin = Readable.from(["stdin-sensitive\n"]);
    expect(await main(["secrets", "set", "github.work.token", "--stdin", "--json"], rt)).toBe(0);
    expect(envelope(rt).data).toMatchObject({ reference: "github.work.token", stored: true, remoteValidity: "unverified" });
    expect(await main(["secrets", "get", "github.work.token", "--json", "--offline"], rt)).toBe(0);
    expect(envelope(rt).data.secret).toMatchObject({ state: "present", source: { type: "vault" }, consumers: [], updatedAt: expect.any(String) });
    expect(output(rt)).not.toContain("stdin-sensitive");
  });
  it("completes a bare set reference then asks for hidden input only", async () => {
    const rt = await fixture(); vi.mocked(rt.prompt.text).mockResolvedValueOnce("token").mockResolvedValueOnce("bare-sensitive");
    expect(await main(["secrets", "set"], rt)).toBe(0);
    expect(vi.mocked(rt.prompt.text).mock.calls.map((call) => call[0])).toEqual(["Secret reference", "Secret value"]);
  });
  it("returns bare inventories without implicitly writing and offers Done as the first action", async () => {
    const rt = await fixture();
    expect(await main(["secrets"], rt)).toBe(0);
    expect(rt.prompt.select).toHaveBeenCalledWith("Action", ["Done", "Set", "Get", "Remove", "Check"]);
    expect(await main(["auth", "--json"], rt)).toBe(0);
    expect(envelope(rt).data.users).toEqual([]);
    await expect(readFile(path.join(rt.cwd, ".fentaris/vault.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("identifies affected consumers, requires a destructive choice, and reports missing dependencies after removal", async () => {
    const rt = await fixture(); const vault = await ProjectVault.open({ root: rt.cwd, env: rt.env });
    await vault.set("token", "secret"); await vault.bind("token", { type: "vault" }, { consumer: { kind: "mcp", server: "github", account: "work" } });
    expect(await main(["secrets", "remove", "token", "--json"], rt)).toBe(1);
    expect(envelope(rt).error.nextActions[0]).toContain("github (work)");
    expect(rt.prompt.confirm).not.toHaveBeenCalled();
    vi.mocked(rt.prompt.confirm).mockResolvedValueOnce(false);
    expect(await main(["secrets", "remove", "token"], rt)).toBe(0);
    expect(await vault.resolve("token")).toBe("secret");
    expect(await main(["secrets", "remove", "token", "--force", "--json"], rt)).toBe(0);
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(1);
    expect(envelope(rt).data.issues[0]).toMatchObject({ reference: "token", state: "missing", consumers: [{ server: "github", account: "work", kind: "mcp" }] });
  });
  it("loads project .env with process precedence and explicitly binds environment references without copying them", async () => {
    const rt = await fixture(); delete rt.env.FENTARIS_VAULT_KEY;
    await writeFile(path.join(rt.cwd, ".env"), "TOKEN=dotenv-sensitive\n"); rt.env.TOKEN = "process-sensitive";
    expect(await main(["secrets", "set", "github.token", "--source", "environment", "--env", "TOKEN", "--json"], rt)).toBe(0);
    expect(await main(["secrets", "get", "github.token", "--json", "--offline"], rt)).toBe(0);
    expect(envelope(rt).data.secret).toMatchObject({ source: { type: "environment", name: "TOKEN" }, state: "present" });
    expect(output(rt)).not.toContain("sensitive");
    expect(await readFile(path.join(rt.cwd, ".fentaris/vault.json"), "utf8")).not.toContain("sensitive");
    expect(await readFile(path.join(rt.cwd, ".env"), "utf8")).toBe("TOKEN=dotenv-sensitive\n");
  });
  it("delivers generated incoming keys once, lists metadata, and revokes through their IDs", async () => {
    const rt = await fixture();
    expect(await main(["auth", "keys", "create", "--user", "pi", "--name", "macbook", "--json"], rt)).toBe(0);
    const created = envelope(rt).data; expect(created.sensitive).toBe(true);
    vi.mocked(rt.out.log).mockClear();
    expect(await main(["auth", "keys", "list", "--user", "pi", "--json"], rt)).toBe(0);
    expect(envelope(rt).data.keys[0]).toMatchObject({ id: created.key.id, user: "pi", name: "macbook" });
    expect(output(rt)).not.toContain(created.sensitiveValue);
    expect(await main(["auth", "--json"], rt)).toBe(0);
    expect(envelope(rt).data.users).toEqual([{ user: "pi", activeKeyCount: 1 }]);
    expect(await main(["auth", "keys", "revoke", created.key.id, "--json"], rt)).toBe(0);
    const vault = await ProjectVault.open({ root: rt.cwd, env: rt.env }); expect(await vault.authenticate(created.sensitiveValue)).toBeNull();
    expect(output(rt)).not.toContain(created.sensitiveValue);
  });
  it("does not contact providers offline and has no prompt or progress noise in JSON", async () => {
    const rt = await fixture(); const resolve = vi.fn(async () => "provider-sensitive"); rt.vaultOptions = { externalProviders: { cloud: { resolve } } };
    expect(await main(["secrets", "set", "token", "--source", "external", "--provider", "cloud", "--locator", "github", "--json"], rt)).toBe(0);
    vi.mocked(rt.out.log).mockClear();
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(0);
    expect(resolve).not.toHaveBeenCalled(); expect(envelope(rt).data.secrets[0].state).toBe("unverified");
    expect(vi.mocked(rt.out.log).mock.calls).toHaveLength(1);
    expect(rt.prompt.text).not.toHaveBeenCalled(); expect(rt.prompt.select).not.toHaveBeenCalled();
  });
});


describe("configuration and failure evidence", () => {
  it.each([
    '{dir:"other-vault"}', '{root:"/other-project"}', 'runtimeOptions', '{unlockKey:"configuration-sensitive"}',
  ])("does not satisfy a custom vault binding through the default CLI vault: %s", async (options) => {
    const rt = await fixture(); await mkdir(path.join(rt.cwd, "src"));
    const vault = await ProjectVault.open({ root: rt.cwd, env: rt.env }); await vault.set("token", "default-sensitive");
    await writeFile(path.join(rt.cwd, "src/index.ts"), `import {credentialVault,fentaris} from "@fentaris/core"; fentaris({defaults:{credentials:{token:credentialVault("token",${options})}}});`);
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(1);
    expect(envelope(rt).data.issues).toEqual([expect.objectContaining({ reference: "token", state: "unresolvable", configurationScopes: ["default"], nextActions: [expect.stringContaining("configured location")] })]);
    expect(await main(["secrets", "get", "token", "--offline", "--json"], rt)).toBe(0);
    expect(envelope(rt).data.bindings).toHaveLength(2);
    expect(output(rt)).not.toContain("sensitive");
    expect(await vault.resolve("token")).toBe("default-sensitive");
  });
  it("checks different sources and environment variables independently across credential scopes", async () => {
    const rt = await fixture(); await mkdir(path.join(rt.cwd, "src"));
    await writeFile(path.join(rt.cwd, "src/index.ts"), `
      import { credentialVault, credentialEnv, fentaris, group, user } from "@fentaris/core";
      fentaris({ defaults: { credentials: { token: credentialVault("token") } }, groups: [
        group({ id: "staff", credentials: { token: credentialEnv("STAFF_TOKEN") } }),
        group({ id: "other", credentials: { token: credentialEnv("OTHER_TOKEN") } })
      ], users: [user("pi", { credentials: { token: credentialEnv("STAFF_TOKEN") } })] });
      throw new Error("Configuration must not execute");
    `);
    const vault = await ProjectVault.open({ root: rt.cwd, env: rt.env });
    await vault.set("token", "vault-sensitive");
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(1);
    const data = envelope(rt).data;
    expect(data.secrets).toHaveLength(3);
    expect(data.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "token", source: { type: "environment", name: "STAFF_TOKEN" }, state: "missing", configurationScopes: ["group:staff", "user:pi"] }),
      expect.objectContaining({ reference: "token", source: { type: "environment", name: "OTHER_TOKEN" }, state: "missing" }),
    ]));
    expect(await main(["secrets", "get", "token", "--offline", "--json"], rt)).toBe(0);
    expect(envelope(rt).data.bindings).toHaveLength(3);
    rt.env.STAFF_TOKEN = "staff-sensitive";
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(1);
    expect(envelope(rt).data.issues).toEqual([expect.objectContaining({ source: { type: "environment", name: "OTHER_TOKEN" } })]);
    rt.env.OTHER_TOKEN = "other-sensitive";
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(0);
    expect(output(rt)).not.toContain("sensitive");
    expect((await vault.get("token"))?.source).toEqual({ type: "vault" });
  });
  it("does not treat an unregistered vault reference as satisfied by a direct environment declaration", async () => {
    const rt = await fixture(); await mkdir(path.join(rt.cwd, "src")); rt.env.STAFF_TOKEN = "environment-sensitive";
    await writeFile(path.join(rt.cwd, "src/index.ts"), `
      import {credentialVault,credentialEnv,fentaris,group} from "@fentaris/core";
      fentaris({defaults:{credentials:{token:credentialVault("token")}},groups:[group({id:"staff",credentials:{token:credentialEnv("STAFF_TOKEN")}})]});
    `);
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(1);
    expect(envelope(rt).data.secrets).toHaveLength(2);
    expect(envelope(rt).data.issues).toEqual([expect.objectContaining({ reference: "token", source: { type: "vault" }, state: "missing", configurationScopes: ["default"] })]);
    await expect(readFile(path.join(rt.cwd, ".fentaris/vault.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("reports explicitly configured missing references and consumers without importing configuration", async () => {
    const rt = await fixture(); await mkdir(path.join(rt.cwd, "src"));
    await writeFile(path.join(rt.cwd, "src/index.ts"), 'import { credentialVault, credentialEnv, fentaris } from "@fentaris/core";\nfentaris({defaults:{credentials:{token:credentialVault("github.work.token"),other:credentialEnv("OTHER_TOKEN")}}});\nthrow new Error("Configuration must never be executed for inventory");');
    expect(await main(["secrets", "check", "--offline", "--json"], rt)).toBe(1);
    expect(envelope(rt).data.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reference: "github.work.token", state: "missing", consumers: [{ kind: "configuration", server: "project-config" }] })]));
    rt.stdin = Readable.from(["config-sensitive"]);
    expect(await main(["secrets", "set", "github.work.token", "--stdin", "--json"], rt)).toBe(0);
    expect((await (await ProjectVault.open({root:rt.cwd,env:rt.env})).get("github.work.token"))?.consumers).toEqual([{ kind: "configuration", server: "project-config" }]);
    expect(await main(["secrets", "remove", "github.work.token", "--json"], rt)).toBe(1);
    expect(envelope(rt).error.missingFields).toEqual(["destructiveChoice"]);
  });
  it("shows configured incoming identities with zero active keys", async () => {
    const rt = await fixture(); await mkdir(path.join(rt.cwd, "src"));
    await writeFile(path.join(rt.cwd, "src/index.ts"), 'import {user} from "@fentaris/core"; user("pi-agent");');
    expect(await main(["auth", "--json"], rt)).toBe(0);
    expect(envelope(rt).data.users).toEqual([{ user: "pi-agent", activeKeyCount: 0 }]);
  });
  it("completes recognized omitted optional values and supports JSON before the command", async () => {
    const rt = await fixture(); vi.mocked(rt.prompt.text).mockResolvedValueOnce("2099-01-01T00:00:00Z");
    expect(await main(["auth", "keys", "create", "--user", "pi", "--name", "macbook", "--expires"], rt)).toBe(0);
    expect(rt.prompt.text).toHaveBeenCalledWith("Expiry", {secret:undefined});
    vi.mocked(rt.out.log).mockClear();
    expect(await main(["--json", "auth", "keys", "create", "--user"], rt)).toBe(1);
    expect(envelope(rt).error.missingFields).toEqual(["user", "name"]);
    expect(vi.mocked(rt.out.log).mock.calls).toHaveLength(1);
  });
  it("accurately reports persisted but unverified writes in JSON without a raw value", async () => {
    const rt = await fixture(); delete rt.env.FENTARIS_VAULT_KEY;
    let reads = 0;
    rt.vaultOptions = {credentialStore:{get:async()=>{ if(++reads>1) throw new Error("store unavailable"); return undefined;}, set:async()=>{}}};
    expect(await main(["auth", "keys", "create", "--user", "pi", "--name", "macbook", "--json"], rt)).toBe(1);
    expect(envelope(rt)).toMatchObject({ok:false,error:{stored:true,verified:false}});
    expect(output(rt)).not.toContain("fentaris_");
    const vault = await ProjectVault.open({root:rt.cwd,env:{}});
    expect(await vault.keys()).toEqual([expect.objectContaining({ user:"pi",name:"macbook" })]);
  });
});
