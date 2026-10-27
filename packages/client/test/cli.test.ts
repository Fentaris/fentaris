import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../src/cli.js";
import { EXIT_CODES } from "../src/errors.js";
import { parse } from "../src/framework.js";
import { VERSION } from "../src/session.js";
import { run, tempDirectory, testRuntime } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("command framework", () => {
  it("prints version and help without a project or profile", async () => {
    const runtime = testRuntime(await tempDirectory(cleanup));
    expect(await run(runtime, "--version")).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    const help = await run(runtime, "tools", "call", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: frs tools call <tool> [options]");
    expect(help.stdout).toContain("--args-file <PATH>");
    expect(help.stdout).toContain("Examples:\n  $ frs tools call");
    expect((await run(runtime)).stdout).toContain("Commands:\n  auth");
  });

  it("rejects unknown commands and options with usage errors", async () => {
    const runtime = testRuntime(await tempDirectory(cleanup));
    const unknown = await run(runtime, "tool", "list", "--json");
    expect(unknown.code).toBe(2);
    expect(unknown.json).toMatchObject({ ok: false, error: { code: "UNKNOWN_COMMAND", message: expect.stringContaining("Available: auth, tools, resources, prompts, profile") } });
    expect((await run(runtime, "tools", "list", "--limt", "5", "--json")).json.error.code).toBe("INVALID_ARGUMENTS");
    expect((await run(runtime, "tools", "search", "--json")).json.error.message).toContain("<query>");
    expect((await run(runtime, "tools", "list", "--timeout", "0", "--json")).json.error.code).toBe("INVALID_ARGUMENTS");
  });

  it("parses inline values, repeatable options, and the -- separator", () => {
    const parsed = parse(["tools", "call", "demo__x", "--arg=a=1", "--arg", "b=2", "--json"], ROOT);
    expect(parsed).toMatchObject({ kind: "run", args: ["demo__x"], options: { arg: ["a=1", "b=2"], json: true } });
    expect(parse(["tools", "search", "--", "--literal"], ROOT)).toMatchObject({ kind: "run", args: ["--literal"] });
    expect(() => parse(["tools", "call", "demo__x", "extra"], ROOT)).toThrow("Unexpected argument");
  });

  it("keeps the documented exit code contract", () => {
    expect(EXIT_CODES).toMatchObject({ TOOL_ERROR: 1, INVALID_ARGUMENTS: 2, NOT_FOUND: 2, NOT_LOGGED_IN: 3, AUTH_REQUIRED: 3, POLICY_DENIED: 4, PROXY_UNREACHABLE: 5, TIMEOUT: 6 });
  });
});
