import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FentarisAuth, LocalOAuthTokenStore } from "@fentaris/core";
import { main } from "../src/index.js";
import type { Runtime } from "../src/index.js";
import { browserLaunchCommand, openOAuthCliContext } from "../src/domain/auth/oauth-login.js";
import { startAuthorizationServer } from "../../core/test/fixtures/oauth/authorizationServer.js";
import { startProtectedMcpServer } from "../../core/test/fixtures/oauth/protectedMcpServer.js";

const coreEntry = pathToFileURL(resolve(import.meta.dirname, "../../core/src/index.ts")).href;
const authKey = "test-key";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

function runtime(cwd: string, nonInteractive = false): Runtime & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    cwd,
    env: { FENTARIS_AUTH_KEY: authKey },
    out: { log: (line: unknown) => output.push(String(line)), error: (line: unknown) => errors.push(String(line)) },
    runner: async () => ({ code: 0 }),
    probe: () => true,
    nonInteractive,
    prompt: { text: async () => "", select: async (_q, choices: string[]) => choices[0]!, confirm: async () => true, close: () => undefined },
    output,
    errors,
  } as Runtime & { output: string[]; errors: string[] };
}

async function project(options: { upstreamUrl: string; oauthDeclaration?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fentaris-cli-oauth-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".fentaris"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "oauth-demo", version: "0.1.0", type: "module", dependencies: { "@fentaris/core": "^3.0.0" } }),
  );
  await writeFile(
    join(root, "fentaris.json"),
    JSON.stringify({ name: "oauth-demo", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: ".fentaris" }),
  );
  await writeFile(join(root, ".env"), `FENTARIS_AUTH_KEY=${authKey}\n`);
  await writeFile(
    join(root, ".fentaris", "credentials.enc.json"),
    JSON.stringify(FentarisAuth.encryptCredentials({ users: {}, groups: {}, defaults: {} }, authKey)),
  );
  await writeFile(
    join(root, "src", "index.ts"),
    `import { Policy, mcp, oauth, streamableHttp } from ${JSON.stringify(coreEntry)};
export default {
  policy: Policy.allowAll(),
  servers: [
    mcp("protected", {
      transport: streamableHttp({ url: ${JSON.stringify(options.upstreamUrl)}, network: { allowPrivateNetworkUrls: true } }),
      auth: ${options.oauthDeclaration ?? "oauth()"},
    }),
    mcp("plain", {
      transport: streamableHttp({ url: "https://plain.example.com/mcp" }),
    }),
  ],
};
`,
  );

  return root;
}

async function upstream(): Promise<{ url: string }> {
  const authServer = await startAuthorizationServer();
  cleanups.push(() => authServer.close());
  const protectedServer = await startProtectedMcpServer({ authorizationServer: authServer });
  cleanups.push(() => protectedServer.close());

  return { url: protectedServer.url };
}

describe("fentaris auth login", () => {
  it("stores tokens after a completed browser login and reports status and logout", async () => {
    const target = await upstream();
    const root = await project({ upstreamUrl: target.url });
    const rt = runtime(root);

    // The browser step is simulated: follow the printed URL and let the loopback
    // listener receive the redirect, exactly as a browser would.
    const login = main(["auth", "login", "protected", "--as", "user:alice", "--print-url", "--json"], rt);
    await vi.waitFor(() => expect(rt.output.some((line) => line.includes("/authorize?"))).toBe(true), { timeout: 5000 });
    const authorizationUrl = rt.output.find((line) => line.includes("/authorize?")) as string;
    const redirect = await fetch(authorizationUrl, { redirect: "manual" });
    await fetch(redirect.headers.get("location") as string);

    expect(await login).toBe(0);
    expect(rt.output.join("\n")).toContain('"status": "authenticated"');

    const store = new LocalOAuthTokenStore({ dir: join(root, ".fentaris"), key: authKey });
    expect((await store.get("protected", "user:alice"))?.tokens?.access_token).toBeTruthy();

    const statusRuntime = runtime(root);
    expect(await main(["auth", "status", "protected", "--json"], statusRuntime)).toBe(0);
    expect(JSON.parse(statusRuntime.output.join("\n")).data).toMatchObject([
      { server: "protected", session: "user:alice", status: "authenticated" },
    ]);

    const logoutRuntime = runtime(root);
    expect(await main(["auth", "logout", "protected", "--as", "user:alice", "--json"], logoutRuntime)).toBe(0);
    expect(JSON.parse(logoutRuntime.output.join("\n")).data).toMatchObject({ server: "protected", status: "requires-login" });
    expect(await store.get("protected", "user:alice")).toBeUndefined();
  }, 20_000);

  it("never opens a browser with --print-url or --non-interactive", async () => {
    const target = await upstream();
    const root = await project({ upstreamUrl: target.url });
    const rt = runtime(root, true);

    const run = main(["auth", "login", "protected", "--as", "user:alice", "--json"], rt);
    await vi.waitFor(() => expect(rt.output.some((line) => line.startsWith("http"))).toBe(true), { timeout: 5000 });
    const authorizationUrl = rt.output.find((line) => line.includes("/authorize?")) as string;
    const redirect = await fetch(authorizationUrl, { redirect: "manual" });
    await fetch(redirect.headers.get("location") as string);

    expect(await run).toBe(0);
    expect(rt.output.some((line) => line.includes("/authorize?"))).toBe(true);
  }, 20_000);

  it("uses a fixed loopback redirect port when --port is given", async () => {
    const target = await upstream();
    const root = await project({ upstreamUrl: target.url });
    const rt = runtime(root);
    const port = 45_231;

    const run = main(["auth", "login", "protected", "--as", "user:alice", "--print-url", "--port", String(port), "--json"], rt);
    await vi.waitFor(() => expect(rt.output.some((line) => line.includes("/authorize?"))).toBe(true), { timeout: 5000 });
    const authorizationUrl = rt.output.find((line) => line.includes("/authorize?")) as string;
    expect(decodeURIComponent(authorizationUrl)).toContain(`http://127.0.0.1:${port}/callback`);
    const redirect = await fetch(authorizationUrl, { redirect: "manual" });
    await fetch(redirect.headers.get("location") as string);

    expect(await run).toBe(0);
  }, 20_000);

  it("fails with a clear diagnostic for a non-OAuth server and an invalid selector", async () => {
    const target = await upstream();
    const root = await project({ upstreamUrl: target.url });

    const nonOauth = runtime(root);
    expect(await main(["auth", "login", "plain", "--json"], nonOauth)).toBe(1);
    expect(nonOauth.errors.join("\n")).toContain('not declared with oauth()');

    const badSelector = runtime(root);
    expect(await main(["auth", "status", "protected", "--as", "group:admins", "--json"], badSelector)).toBe(1);
    expect(badSelector.errors.join("\n")).toContain("is not supported");
  }, 20_000);

  it("fails before any network call when no store key is available", async () => {
    const target = await upstream();
    const root = await project({ upstreamUrl: target.url });
    const rt = runtime(root, true);
    rt.env = {};
    await rm(join(root, ".env"));

    expect(await main(["auth", "status", "--json"], rt)).toBe(1);
  }, 20_000);

  it("stops waiting for the callback after --timeout instead of blocking", async () => {
    const target = await upstream();
    const root = await project({ upstreamUrl: target.url });
    const rt = runtime(root, true);

    const started = Date.now();
    // Nobody opens the printed URL: the command must give up on its own.
    expect(await main(["auth", "login", "protected", "--timeout", "1", "--json"], rt)).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(rt.errors.join("\n")).toMatch(/Timed out waiting/i);
  }, 30_000);

  it("rejects an invalid --timeout value", async () => {
    const target = await upstream();
    const root = await project({ upstreamUrl: target.url });
    const rt = runtime(root, true);

    expect(await main(["auth", "login", "protected", "--timeout", "0", "--json"], rt)).toBe(1);
    expect(rt.errors.join("\n")).toContain("Invalid --timeout value");
  }, 20_000);

  it("launches Windows OAuth URLs without cmd.exe parsing", () => {
    const url = "https://login.example/authorize?client_id=fentaris&code_challenge=abc";
    expect(browserLaunchCommand("win32", url)).toEqual([
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
    ]);
  });
});
