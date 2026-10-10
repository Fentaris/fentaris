import { execFile as execFileWithCallback, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { main, renderTemplate, type Runtime } from "../src/index.js";
import { writeTemplate } from "../src/domain/template/template.js";
import { remoteMcpUrl } from "../src/shared/constants.js";

const execFile = promisify(execFileWithCallback);
const coreRoot = fileURLToPath(new URL("../../core/", import.meta.url));
const tsc = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const nodeTypes = fileURLToPath(new URL("../node_modules/@types/node", import.meta.url));
const require = createRequire(import.meta.url);
// Exercise the real tsx watcher already installed through the locked Vite toolchain.
const viteRequire = createRequire(createRequire(require.resolve("vitest/package.json")).resolve("vite/package.json"));
const tsxCli = viteRequire.resolve("tsx/cli");

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback port.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function upstreamFixture(): { server: Server; methods: string[] } {
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const message = JSON.parse(body) as { id?: number; method: string };
    methods.push(message.method);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "read", description: "Read fixture data", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "fixture result" }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  return { server, methods };
}

async function generatedProject(port: number, upstreamUrl: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fentaris-generated-discovery-"));
  const { files } = renderTemplate({ projectName: "discovery-demo", packageManager: "pnpm", port, proxyPath: "/mcp", coreVersionRange: "workspace:*" });
  files["src/index.ts"] = files["src/index.ts"].replace(`url: "${remoteMcpUrl}",`, `url: "${upstreamUrl}", network: { allowPrivateNetworkUrls: true },`);
  await writeTemplate(root, files);
  await mkdir(join(root, "node_modules", "@fentaris"), { recursive: true });
  await symlink(coreRoot, join(root, "node_modules", "@fentaris", "core"), "dir");
  await mkdir(join(root, "node_modules", "@types"), { recursive: true });
  await symlink(nodeTypes, join(root, "node_modules", "@types", "node"), "dir");
  return root;
}

function runtime(cwd: string): Runtime {
  return {
    cwd,
    env: { FENTARIS_AUTH_KEY: "test-key" },
    out: { log: vi.fn(), error: vi.fn() },
    runner: vi.fn(async () => ({ code: 0 })),
    probe: vi.fn(() => false),
    prompt: { text: vi.fn(async () => ""), select: vi.fn(async (_question, choices) => choices[0]), confirm: vi.fn(async () => false), close: vi.fn() },
  };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

describe("generated project tool discovery", () => {
  it.each(["local", "team"] as const)("loads .env in the generated %s dev script, including after a restart", async (template) => {
    const root = await mkdtemp(join(tmpdir(), "fentaris-generated-watch-"));
    const { files } = renderTemplate({ projectName: "watch-demo", packageManager: "pnpm", port: 3000, proxyPath: "/mcp", template });
    files["src/index.ts"] = "console.log('initial=' + process.env.FENTARIS_TEST_DOTENV);\n";
    await writeTemplate(root, files);
    await writeFile(join(root, ".env"), "FENTARIS_TEST_DOTENV=loaded\n");
    const manifest = JSON.parse(files["package.json"]) as { scripts: { dev: string } };
    const [command, ...arguments_] = manifest.scripts.dev.split(" ");
    expect(command).toBe("tsx");
    const env = { ...process.env };
    delete env.FENTARIS_TEST_DOTENV;
    const child = spawn(process.execPath, [tsxCli, ...arguments_], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    try {
      await vi.waitFor(() => expect(output).toContain("initial=loaded"), { timeout: 5_000 });
      await writeFile(join(root, "src", "index.ts"), "console.log('restarted=' + process.env.FENTARIS_TEST_DOTENV);\n");
      await vi.waitFor(() => expect(output).toContain("restarted=loaded"), { timeout: 5_000 });
    } finally {
      await stop(child);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("imports config without contacting upstreams or starting a listener, then lists tools offline", async () => {
    const occupiedPort = createServer();
    const port = await listen(occupiedPort);
    const upstream = upstreamFixture();
    const upstreamPort = await listen(upstream.server);
    const root = await generatedProject(port, `http://127.0.0.1:${upstreamPort}/mcp`);
    try {
      const entrypoint = pathToFileURL(join(root, "src/index.ts")).href;
      await execFile(process.execPath, ["--input-type=module", "-e", `const module = await import(${JSON.stringify(entrypoint)}); if (module.fentarisConfig.servers[0].name !== "specification") process.exitCode = 1;`], { cwd: root, timeout: 5_000 });
      expect(upstream.methods).toEqual([]);

      const rt = runtime(root);
      expect(await main(["mcp", "tools", "specification", "--json"], rt)).toBe(0);
      const envelope = JSON.parse(vi.mocked(rt.out.log).mock.calls[0][0]);
      expect(envelope, JSON.stringify(envelope)).toMatchObject({ outcome: "success", connections: [{ server: "specification", tools: [{ name: "specification__read" }] }] });
      expect(upstream.methods).toContain("tools/list");
      expect(rt.out.error).not.toHaveBeenCalled();
    } finally {
      await close(upstream.server);
      await close(occupiedPort);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["src/index.ts", "dist/index.js"])("starts the proxy when %s is executed directly", async (entrypoint) => {
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    const upstream = upstreamFixture();
    const upstreamPort = await listen(upstream.server);
    const root = await generatedProject(port, `http://127.0.0.1:${upstreamPort}/mcp`);
    let child: ChildProcess | undefined;
    let output = "";
    try {
      if (entrypoint.startsWith("dist/")) {
        try {
          await execFile(tsc, ["-p", "tsconfig.json"], { cwd: root, timeout: 10_000 });
        } catch (error) {
          const result = error as { stdout?: string; stderr?: string };
          throw new Error(`${result.stdout ?? ""}${result.stderr ?? ""}`, { cause: error });
        }
      }
      child = spawn(process.execPath, [entrypoint], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { output += chunk.toString(); });

      await vi.waitFor(async () => {
        if (child?.exitCode !== null) throw new Error(output);
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
        });
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain("protocolVersion");
      }, { timeout: 5_000, interval: 50 });
      expect(output).toContain(String(port));
    } finally {
      if (child) await stop(child);
      await close(upstream.server);
      await rm(root, { recursive: true, force: true });
    }
  });
});
