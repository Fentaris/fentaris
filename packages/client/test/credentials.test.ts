import { afterEach, describe, expect, it } from "vitest";
import { openCredentialStore } from "../src/credentials.js";
import type { ExecResult } from "../src/runtime.js";
import { tempDirectory, testRuntime } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Call = { command: string; args: string[]; input?: string };

/** Simulates the macOS `security` tool and libsecret `secret-tool` with an in-memory keyring. */
function fakeKeyring(calls: Call[]) {
  const items = new Map<string, string>();
  return async (command: string, args: string[], input?: string): Promise<ExecResult> => {
    calls.push({ command, args, input });
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    if (command === "security") {
      if (args[0] === "help") return ok();
      if (args[0] === "-i") {
        const parts = (input ?? "").trim().split(/\s+/);
        items.set(parts[parts.indexOf("-a") + 1]!, parts[parts.indexOf("-w") + 1]!);
        return ok();
      }
      const account = args[args.indexOf("-a") + 1]!;
      if (args[0] === "find-generic-password") return items.has(account) ? ok(`${items.get(account)}\n`) : { code: 44, stdout: "", stderr: "not found" };
      if (args[0] === "delete-generic-password") return items.delete(account) ? ok() : { code: 44, stdout: "", stderr: "not found" };
    }
    if (command === "secret-tool") {
      if (args[0] === "--version") return ok("secret-tool 0.21");
      const account = args[args.indexOf("account") + 1]!;
      if (args[0] === "store") { items.set(account, input ?? ""); return ok(); }
      if (args[0] === "lookup") return items.has(account) ? ok(items.get(account)) : { code: 1, stdout: "", stderr: "" };
      if (args[0] === "clear") { items.delete(account); return ok(); }
    }
    return { code: 127, stdout: "", stderr: "missing" };
  };
}

describe("credential stores", () => {
  it.each([
    { platform: "darwin" as const, kind: "keychain", tool: "security", env: {} },
    { platform: "linux" as const, kind: "secret-service", tool: "secret-tool", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" } },
  ])("uses the $kind backend without secrets in argv", async ({ platform, kind, tool, env }) => {
    const calls: Call[] = [];
    const runtime = testRuntime(await tempDirectory(cleanup), { env: { FENTARIS_CLIENT_CREDENTIAL_STORE: undefined, ...env } });
    runtime.platform = platform;
    runtime.exec = fakeKeyring(calls);
    const store = await openCredentialStore(runtime);
    expect(store.kind).toBe(kind);
    const record = { type: "oauth" as const, accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: 1 };
    await store.set("team", record);
    expect(await store.get("team")).toEqual(record);
    expect(calls.filter((call) => call.command === tool).every((call) => !call.args.join(" ").includes("secret-"))).toBe(true);
    expect(calls.some((call) => (call.input ?? "").length > 0)).toBe(true);
    expect(await store.delete("team")).toBe(true);
    expect(await store.get("team")).toBeUndefined();
  });

  it("falls back to an owner-only file when no keyring is available", async () => {
    const dir = await tempDirectory(cleanup);
    const runtime = testRuntime(dir, { env: { FENTARIS_CLIENT_CREDENTIAL_STORE: undefined } });
    const store = await openCredentialStore(runtime);
    expect(store).toMatchObject({ kind: "file", location: `${dir}/credentials.json` });
  });
});
