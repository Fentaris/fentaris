import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileWithCallback, type SpawnOptions } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { FentarisAuth } from "@fentaris/core";
import {
  discoverProject,
  ensureEmptyTargetDirectory,
  isDirectCliInvocation,
  main,
  parseCommand,
  renderTemplate,
  resolveProjectName,
  selectPackageManager,
  type Prompt,
  type Runtime,
} from "../src/index.js";
import { defaultRuntime } from "../src/platform/runtime.js";
import { cliVersion } from "../src/shared/constants.js";

const execFile = promisify(execFileWithCallback);

function prompt(values: string[] = [], selections: string[] = []): Prompt {
  return {
    text: vi.fn(async () => values.shift() ?? ""),
    select: vi.fn(async <T extends string>(_question: string, choices: T[]) => (selections.shift() as T | undefined) ?? choices[0]),
    confirm: vi.fn(async () => true),
    close: vi.fn(),
  };
}

class FakeTtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  pauseCalls = 0;
  rawModeCalls: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeCalls.push(mode);
    return this;
  }

  override pause(): this {
    this.pauseCalls += 1;
    return super.pause() as this;
  }
}

class FakeTtyOutput extends Writable {
  isTTY = true;
  columns = 80;
  private readonly chunks: string[] = [];

  get text(): string {
    return this.chunks.join("");
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }
}

async function withFakeProcessIo<T>(input: FakeTtyInput, output: FakeTtyOutput, run: () => Promise<T>): Promise<T> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
  }
}

async function withFakeStdin<T>(input: PassThrough, run: () => Promise<T>): Promise<T> {
  const stdin = process.stdin;
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  }
}

async function writeHealthyProject(root: string, authDirectory = ".fentaris"): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, authDirectory), { recursive: true });
  await writeFile(join(root, "README.md"), "# Demo\n");
  await writeFile(join(root, ".env"), "FENTARIS_AUTH_KEY=test-key\n");
  await writeFile(join(root, ".gitignore"), `${authDirectory}/\n`);
  await writeFile(join(root, "src", "index.ts"), "import { Policy } from '@fentaris/core';\nPolicy.allowAll();\n");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "0.1.0",
      type: "module",
      scripts: { dev: "tsx src/index.ts", build: "tsc -p tsconfig.json", start: "node dist/index.js" },
      dependencies: { "@fentaris/core": "latest", tsx: "latest" },
      devDependencies: { typescript: "latest" },
    }),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
  );
  await writeFile(
    join(root, "fentaris.json"),
    JSON.stringify({ name: "demo", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: authDirectory }),
  );
  await writeFile(
    join(root, authDirectory, "credentials.enc.json"),
    JSON.stringify(FentarisAuth.encryptCredentials({ users: {}, groups: {}, defaults: {} }, "test-key")),
  );
}

function runtime(cwd: string, probes: Record<string, boolean> = {}): Runtime & { calls: Array<{ command: string; args: string[]; cwd?: string | URL; env?: NodeJS.ProcessEnv }> } {
  const calls: Array<{ command: string; args: string[]; cwd?: string | URL; env?: NodeJS.ProcessEnv }> = [];
  return {
    cwd,
    env: { FENTARIS_AUTH_KEY: "test-key" },
    out: { log: vi.fn(), error: vi.fn() },
    runner: vi.fn(async (command: string, args: string[], options?: SpawnOptions) => {
      calls.push({ command, args, cwd: options?.cwd, env: options?.env });
      return { code: 0 };
    }),
    probe: vi.fn((command: string) => probes[command] ?? false),
    prompt: prompt(["secret-value"]),
    calls,
  };
}

describe("default runtime prompts", () => {
  it("masks TTY secret input and accepts a follow-up confirmation", async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();

    await withFakeProcessIo(input, output, async () => {
      const rt = defaultRuntime();

      const secret = rt.prompt.text("Credential value", { secret: true });
      input.write("xyz\r");
      await expect(secret).resolves.toBe("xyz");

      const secretOutput = output.text;
      expect(secretOutput).toContain("***");
      expect(secretOutput).not.toContain("x");
      expect(secretOutput).not.toContain("y");
      expect(secretOutput).not.toContain("z");
      expect(input.pauseCalls).toBe(1);
      expect(input.rawModeCalls).toEqual([true, false]);

      const confirmed = rt.prompt.confirm("Store this credential?");
      input.write("yes\n");
      await expect(confirmed).resolves.toBe(true);
      rt.prompt.close();
      expect(input.pauseCalls).toBeGreaterThanOrEqual(2);
    });
  });

  it("fails closed for non-TTY secret prompts", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    await withFakeStdin(input, async () => {
      const rt = defaultRuntime();
      await expect(rt.prompt.text("Credential value", { secret: true })).rejects.toThrow("Secret prompts require an interactive terminal");
    });
  });

  it("selects TTY menu items with arrow keys", async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();

    await withFakeProcessIo(input, output, async () => {
      const rt = defaultRuntime();
      const selected = rt.prompt.select("Credential scope", ["default", "user", "group"]);
      input.write("\u001b[B\r");

      await expect(selected).resolves.toBe("user");
      expect(output.text).toContain("Credential scope");
      expect(output.text).toContain("Choose by number or exact label");
      expect(input.rawModeCalls).toEqual([true, false]);
    });
  });

  it("selects TTY menu items by number", async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();

    await withFakeProcessIo(input, output, async () => {
      const rt = defaultRuntime();
      const selected = rt.prompt.select("Credential scope", ["default", "user", "group"]);
      input.write("2\r");

      await expect(selected).resolves.toBe("user");
      expect(output.text).toContain("Choose by number or exact label");
      expect(input.rawModeCalls).toEqual([true, false]);
    });
  });

  it("selects the default menu item when line input is empty", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;

    await withFakeStdin(input, async () => {
      const rt = defaultRuntime();
      const selected = rt.prompt.select("Package manager", ["pnpm", "npm", "bun"]);
      input.write("\n");

      await expect(selected).resolves.toBe("pnpm");
      rt.prompt.close();
    });
  });

  it("selects TTY menu items by exact label", async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();

    await withFakeProcessIo(input, output, async () => {
      const rt = defaultRuntime();
      const selected = rt.prompt.select("Credential scope", ["default", "user", "group"]);
      input.write("group\r");

      await expect(selected).resolves.toBe("group");
      expect(input.rawModeCalls).toEqual([true, false]);
    });
  });

  it("scrolls long TTY select menus", async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();

    await withFakeProcessIo(input, output, async () => {
      const rt = defaultRuntime();
      const selected = rt.prompt.select("Group id", ["one", "two", "three", "four", "five"], { visibleItems: 3 });
      input.write("\u001b[B\u001b[B\u001b[B\u001b[B\r");

      await expect(selected).resolves.toBe("five");
      expect(output.text).toContain("↓ more");
      expect(output.text).toContain("↑ more");
    });
  });

  it("reports spawn errors as failed process results", async () => {
    const rt = defaultRuntime();

    await expect(rt.runner("fentaris-missing-command-for-tests", [], { stdio: "ignore" })).resolves.toEqual({ code: 1 });
  });
});

describe("command routing helpers", () => {
  it("parses nested commands and options", () => {
    expect(parseCommand(["secrets", "set", "github.token", "--user", "alice", "--key", "test-key"])).toEqual({
      kind: "ok",
      path: ["secrets", "set"],
      command: {
        name: "secrets",
        args: ["set", "github.token"],
        options: { user: "alice", key: "test-key" },
      },
    });
  });

  it("parses dash-prefixed and inline option values", () => {
    expect(parseCommand(["secrets", "set", "github.token", "--value", "-secret-value"])).toEqual({
      kind: "ok",
      path: ["secrets", "set"],
      command: {
        name: "secrets",
        args: ["set", "github.token"],
        options: { value: "-secret-value" },
      },
    });

    expect(parseCommand(["secrets", "set", "github.token", "--value=-secret-value"])).toEqual({
      kind: "ok",
      path: ["secrets", "set"],
      command: {
        name: "secrets",
        args: ["set", "github.token"],
        options: { value: "-secret-value" },
      },
    });
  });

  it("parses stdin secret value option", () => {
    expect(parseCommand(["secrets", "set", "github.token", "--value-stdin"])).toEqual({
      kind: "ok",
      path: ["secrets", "set"],
      command: {
        name: "secrets",
        args: ["set", "github.token"],
        options: { "value-stdin": true },
      },
    });
  });

  it("parses auth api-key commands", () => {
    expect(parseCommand(["auth", "api-key", "add", "alice", "--value-stdin"])).toEqual({
      kind: "ok",
      path: ["auth", "api-key", "add"],
      command: {
        name: "auth",
        args: ["api-key", "add", "alice"],
        options: { "value-stdin": true },
      },
    });

    expect(parseCommand(["auth", "api-key", "list", "--user", "alice", "--json"])).toEqual({
      kind: "ok",
      path: ["auth", "api-key", "list"],
      command: {
        name: "auth",
        args: ["api-key", "list"],
        options: { user: "alice", json: true },
      },
    });
  });

  it("parses non-interactive on commands and nested commands", () => {
    expect(parseCommand(["--non-interactive", "check"])).toEqual({
      kind: "ok",
      path: ["check"],
      command: {
        name: "check",
        args: [],
        options: { "non-interactive": true },
      },
    });

    expect(parseCommand(["check", "--non-interactive"])).toEqual({
      kind: "ok",
      path: ["check"],
      command: {
        name: "check",
        args: [],
        options: { "non-interactive": true },
      },
    });

    expect(parseCommand(["secrets", "set", "github.token", "--value-stdin", "--non-interactive"])).toEqual({
      kind: "ok",
      path: ["secrets", "set"],
      command: {
        name: "secrets",
        args: ["set", "github.token"],
        options: { "value-stdin": true, "non-interactive": true },
      },
    });
  });

  it("parses short utility flags", () => {
    expect(parseCommand(["-v"])).toEqual({
      kind: "version",
    });
    expect(parseCommand(["-h"])).toEqual({
      kind: "help",
      path: [],
    });
  });

  it("routes root help and version flags", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const rt = runtime("/tmp");
      await expect(main(argv, rt)).resolves.toBe(0);
      expect(rt.out.log).toHaveBeenCalledWith(cliVersion);
    }

    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const rt = runtime("/tmp");
      await expect(main(argv, rt)).resolves.toBe(0);
      const output = vi.mocked(rt.out.log).mock.calls.flat().join("\n");
      expect(output).toContain("Usage: ");
      expect(output).toContain("fentaris [OPTIONS] [COMMAND]");
      expect(output).toContain("Project:");
      expect(output).toContain("\u001b[32minit");
    }
  });

  it("routes contextual command help", async () => {
    const check = runtime("/tmp");
    await expect(main(["check", "--help"], check)).resolves.toBe(0);
    expect(vi.mocked(check.out.log).mock.calls.flat().join("\n")).toContain("Usage: ");
    expect(vi.mocked(check.out.log).mock.calls.flat().join("\n")).toContain("fentaris check [OPTIONS]");

    const secretsSet = runtime("/tmp");
    await expect(main(["secrets", "set", "--help"], secretsSet)).resolves.toBe(0);
    const output = vi.mocked(secretsSet.out.log).mock.calls.flat().join("\n");
    expect(output).toContain("Usage: ");
    expect(output).toContain("fentaris secrets set [OPTIONS] [reference]");
    expect(output).toContain("Arguments:");
  });

  it("reports parser errors before running commands", async () => {
    const unknownOption = runtime("/tmp");
    await expect(main(["check", "--unknown"], unknownOption)).resolves.toBe(2);
    expect(vi.mocked(unknownOption.out.error).mock.calls.flat().join("\n")).toContain("error: unexpected argument '--unknown' found");
    expect(vi.mocked(unknownOption.out.log)).not.toHaveBeenCalled();

    const unknownCommand = runtime("/tmp");
    await expect(main(["nope"], unknownCommand)).resolves.toBe(2);
    expect(vi.mocked(unknownCommand.out.error).mock.calls.flat().join("\n")).toContain("error: unrecognized subcommand 'nope'");

    const unknownSecretsCommand = runtime("/tmp");
    await expect(main(["secrets", "nope"], unknownSecretsCommand)).resolves.toBe(2);
    expect(vi.mocked(unknownSecretsCommand.out.error).mock.calls.flat().join("\n")).toContain("Usage: fentaris secrets [OPTIONS] [COMMAND]");
  });

  it("formats runtime errors separately from parser errors", async () => {
    const rt = runtime("/tmp");
    await expect(main(["check"], rt)).resolves.toBe(1);
    expect(vi.mocked(rt.out.error).mock.calls.flat().join("\n")).toContain("Error: No Fentaris project found.");
  });

  it("rejects removed legacy auth commands", async () => {
    const rt = runtime("/tmp");
    await expect(main(["auth", "inspect", "--dir", ".fentaris", "--key", "test-key"], rt)).resolves.toBe(2);
    expect(rt.out.error).toHaveBeenCalledWith(expect.stringContaining("error: unrecognized subcommand 'inspect'"));
  });

  it("resolves provided and prompted project names", async () => {
    await expect(resolveProjectName("my-app", prompt())).resolves.toBe("my-app");
    await expect(resolveProjectName(undefined, prompt(["asked-app"]))).resolves.toBe("asked-app");
  });

  it("rejects non-empty target directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeFile(join(dir, "existing.txt"), "content");
    await expect(ensureEmptyTargetDirectory(dir)).rejects.toThrow("new or empty");
  });

  it("selects a package manager without prompting when only one exists", async () => {
    await expect(selectPackageManager((command) => command === "pnpm", prompt())).resolves.toBe("pnpm");
  });

  it("recognizes installed bin symlinks as direct CLI invocations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const entrypoint = join(dir, "dist-index.js");
    const bin = join(dir, "fentaris");
    await writeFile(entrypoint, "");
    await symlink(entrypoint, bin);

    expect(isDirectCliInvocation(pathToFileURL(entrypoint).href, bin)).toBe(true);
  });
});

describe("project template", () => {
  it("renders expected files and ignores local secrets", () => {
    const rendered = renderTemplate({
      projectName: "demo",
      packageManager: "pnpm",
      port: 4000,
      proxyPath: "/mcp",
    });

    expect(Object.keys(rendered.files).sort()).toEqual([
      ".fentaris/secrets.manifest.json",
      ".gitignore",
      "README.md",
      "fentaris.json",
      "package.json",
      "src/index.ts",
      "tsconfig.json",
    ]);
    expect(rendered.files[".gitignore"]).toContain(".fentaris/");
    expect(rendered.files[".gitignore"]).toContain("!.fentaris/secrets.manifest.json");
    expect(rendered.files["README.md"]).toContain("Quick start");
    expect(rendered.files["README.md"]).not.toContain("demo user");
    expect(rendered.files["README.md"]).not.toContain("Secrets workflow");
    expect(rendered.files["src/index.ts"]).toContain("https://mcp.specification.website/mcp");
    expect(rendered.files["src/index.ts"]).toContain("app.mcp(");
    expect(rendered.files["src/index.ts"]).toContain("policy: Policy.allowAll()");
    expect(rendered.files["src/index.ts"]).not.toContain("user:");
    expect(rendered.files["src/index.ts"]).not.toContain("credentialJson");
    expect(rendered.files["src/index.ts"]).not.toContain("policy(");
    expect(rendered.files["src/index.ts"]).not.toContain("profiler()");

    const packageJson = JSON.parse(rendered.files["package.json"] ?? "{}") as { devDependencies?: Record<string, string> };
    expect(packageJson.devDependencies).toMatchObject({
      "@types/node": "latest",
      typescript: "latest",
    });
  });

  it("allows the generated secrets manifest to be committed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-template-gitignore-"));
    const rendered = renderTemplate({
      projectName: "demo",
      packageManager: "pnpm",
      port: 4000,
      proxyPath: "/mcp",
    });
    await mkdir(join(dir, ".fentaris"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), rendered.files[".gitignore"]);
    await writeFile(join(dir, ".fentaris", "secrets.manifest.json"), rendered.files[".fentaris/secrets.manifest.json"]);

    await execFile("git", ["init"], { cwd: dir });
    await expect(execFile("git", ["check-ignore", ".fentaris/secrets.manifest.json"], { cwd: dir })).rejects.toMatchObject({ code: 1 });
  });
});

describe("project commands", () => {
  it("initializes a project with dry-run install and git when available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });

    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    const config = JSON.parse(await readFile(join(dir, "demo", "fentaris.json"), "utf8")) as { name: string };
    expect(config.name).toBe("demo");
    expect(rt.calls.some((call) => call.command === "git" && call.args[0] === "init")).toBe(true);
  });

  it("supports non-interactive init when scaffold inputs are explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, npm: true, bun: true, git: true, docker: false });

    await expect(
      main(["init", "demo", "--non-interactive", "--package-manager", "npm", "--port", "4321", "--path", "/agent", "--skip-install", "--skip-git"], rt),
    ).resolves.toBe(0);

    const config = JSON.parse(await readFile(join(dir, "demo", "fentaris.json"), "utf8")) as {
      packageManager: string;
      port: number;
      path: string;
    };
    expect(config.packageManager).toBe("npm");
    expect(config.port).toBe(4321);
    expect(config.path).toBe("/agent");
    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(rt.prompt.select).not.toHaveBeenCalled();
    expect(rt.calls.some((call) => call.command === "npm" && call.args[0] === "install")).toBe(false);
    expect(rt.calls.some((call) => call.command === "git" && call.args[0] === "init")).toBe(false);
  });

  it("fails init before installing when an explicit package manager is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, npm: true, bun: false, git: true, docker: false });

    await expect(main(["init", "demo", "--package-manager", "bun"], rt)).resolves.toBe(1);

    expect(rt.out.error).toHaveBeenCalledWith(expect.stringContaining("Package manager 'bun' was not found."));
    expect(rt.calls.some((call) => call.command === "bun" && call.args[0] === "install")).toBe(false);
  });

  it("allows unavailable explicit package managers when install is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, npm: true, bun: false, git: true, docker: false });

    await expect(main(["init", "demo", "--package-manager", "bun", "--skip-install", "--skip-git"], rt)).resolves.toBe(0);

    const config = JSON.parse(await readFile(join(dir, "demo", "fentaris.json"), "utf8")) as { packageManager: string };
    expect(config.packageManager).toBe("bun");
    expect(rt.calls.some((call) => call.command === "bun" && call.args[0] === "install")).toBe(false);
  });

  it("fails non-interactive init when the project name is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });

    await expect(main(["init", "--non-interactive", "--skip-install"], rt)).resolves.toBe(1);

    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(rt.out.error).toHaveBeenCalledWith(expect.stringContaining("Project name is required for non-interactive init"));
  });

  it("skips git initialization when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });

    await expect(main(["init", "demo", "--skip-install", "--skip-git"], rt)).resolves.toBe(0);

    expect(rt.calls.some((call) => call.command === "git" && call.args[0] === "init")).toBe(false);
  });

  it("skips git initialization when git is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: false, docker: false });

    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    expect(rt.calls.some((call) => call.command === "git" && call.args[0] === "init")).toBe(false);
  });

  it("discovers projects from nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const srcDir = join(dir, "src", "nested");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(dir, "fentaris.json"),
      JSON.stringify({ name: "demo", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: ".fentaris" }),
    );

    await expect(discoverProject(srcDir)).resolves.toMatchObject({ root: dir });
  });

  it("runs dev through the discovered package manager", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo", "src");
    await expect(main(["dev"], rt)).resolves.toBe(0);

    expect(rt.calls.some((call) => call.command === "pnpm" && call.args.join(" ") === "dev")).toBe(true);
  });

  it("loads the discovered project .env when running dev", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(join(dir, ".env"), "FENTARIS_AUTH_KEY=from-dotenv\nFENTARIS_GUEST_API_KEY=guest-demo\n");
    const rt = runtime(join(dir, "src"), { pnpm: true });
    delete rt.env.FENTARIS_AUTH_KEY;

    await expect(main(["dev"], rt)).resolves.toBe(0);

    const devCall = rt.calls.find((call) => call.command === "pnpm" && call.args.join(" ") === "dev");
    expect(devCall?.cwd).toBe(dir);
    expect(devCall?.env?.FENTARIS_AUTH_KEY).toBe("from-dotenv");
    expect(devCall?.env?.FENTARIS_GUEST_API_KEY).toBe("guest-demo");
  });

  it("keeps exported environment variables ahead of project .env values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(join(dir, ".env"), "FENTARIS_AUTH_KEY=from-dotenv\n");
    const rt = runtime(dir, { pnpm: true });
    rt.env.FENTARIS_AUTH_KEY = "from-shell";

    await expect(main(["dev"], rt)).resolves.toBe(0);

    const devCall = rt.calls.find((call) => call.command === "pnpm" && call.args.join(" ") === "dev");
    expect(devCall?.env?.FENTARIS_AUTH_KEY).toBe("from-shell");
  });

  it("builds a deterministic local artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    await expect(main(["build"], rt)).resolves.toBe(0);

    const manifest = JSON.parse(await readFile(join(dir, "demo", ".fentaris", "build", "manifest.json"), "utf8")) as { entrypoint: string };
    expect(manifest.entrypoint).toBe("src/index.ts");
    expect(rt.calls.some((call) => call.command === "pnpm" && call.args.join(" ") === "run build")).toBe(true);
    const output = vi.mocked(rt.out.log).mock.calls.flat().join("\n");
    expect(output).toContain("TypeScript output: dist/index.js");
    expect(output).toContain("Fentaris metadata: .fentaris/build");
    expect(output).toContain("Run with: node dist/index.js");
  });

  it("builds when local .env is absent but runtime secrets are provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await rm(join(dir, ".env"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["build"], rt)).resolves.toBe(0);

    expect(rt.calls.some((call) => call.command === "pnpm" && call.args.join(" ") === "run build")).toBe(true);
  });

  it("validates check modes and strict warning exit behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    await writeFile(join(rt.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    rt.env.FENTARIS_AUTH_KEY = "ambient-shell-key";
    await expect(main(["check", "--offline"], rt)).resolves.toBe(0);
    await expect(main(["check", "--offline", "--strict"], rt)).resolves.toBe(0);
    await expect(main(["doctor", "--strict"], rt)).resolves.toBe(1);
  });

  it("warns during check when the entrypoint has no explicit proxy policy controls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(join(dir, "src", "index.ts"), "console.log('open proxy');\n");
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["check", "--offline"], rt)).resolves.toBe(0);
    const output = vi.mocked(rt.out.log).mock.calls.map((call) => String(call[0])).join("\n");

    expect(output).toContain("proxy policy");
    expect(output).toContain("No global policy, group policy, or explicit allow-all development policy detected.");
    expect(output).toContain("Fentaris denies proxy calls by default.");

    vi.mocked(rt.out.log).mockClear();
    await expect(main(["check", "--offline", "--strict"], rt)).resolves.toBe(1);
  });

  it("accepts an explicit allow-all development policy during doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { Policy, fentaris } from "@fentaris/core";
const app = fentaris({ policy: Policy.allowAll() });
void app;
`,
    );
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["doctor"], rt)).resolves.toBe(0);
    const output = vi.mocked(rt.out.log).mock.calls.map((call) => String(call[0])).join("\n");

    expect(output).toContain("Doctor");
    expect(output).not.toContain("No global policy, group policy, or explicit allow-all development policy detected.");
  });

  it("prints compact doctor output with summary and issues only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    vi.mocked(rt.out.log).mockClear();

    await expect(main(["doctor"], rt)).resolves.toBe(0);

    const output = vi.mocked(rt.out.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("All checks passed");
    expect(output).not.toContain("Issues");
    expect(output).not.toMatch(/\bbun\b/i);

    vi.mocked(rt.out.log).mockClear();
    rt.probe = vi.fn((command: string) => ({ pnpm: true, git: true, docker: false })[command] ?? false);
    await expect(main(["doctor"], rt)).resolves.toBe(0);

    const issueOutput = vi.mocked(rt.out.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(issueOutput).toContain("1 warning");
    expect(issueOutput).toContain("Issues");
    expect(issueOutput).toContain("Docker");
    expect(issueOutput).not.toContain("Node.js");

    vi.mocked(rt.out.log).mockClear();
    await expect(main(["doctor", "--verbose"], rt)).resolves.toBe(0);

    const verboseOutput = vi.mocked(rt.out.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(verboseOutput).toContain("Passed");
    expect(verboseOutput).toContain("Node.js");
  });

  it("points missing credential stores to secrets set when an auth key is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await rm(join(dir, ".fentaris", "credentials.enc.json"));
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { credential, fentaris } from "@fentaris/core";
const app = fentaris({ defaults: { credentials: { "github.token": credential("github.token") } } });
void app;
`,
    );
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["doctor", "--json"], rt)).resolves.toBe(0);

    const output = String(vi.mocked(rt.out.log).mock.calls.at(-1)?.[0]);
    expect(output).toContain('"label": "credentials.enc.json"');
    expect(output).toContain('Run fentaris secrets set <reference> to create local credentials.');
    expect(output).not.toContain('Run fentaris init to create local credentials.');
  });

  it("does not infer auth from an ambient auth key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    rt.env.FENTARIS_AUTH_KEY = "ambient-shell-key";
    await writeFile(join(rt.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    await expect(main(["check", "--offline", "--strict"], rt)).resolves.toBe(0);
    await expect(main(["doctor", "--json"], rt)).resolves.toBe(0);

    const output = String(vi.mocked(rt.out.log).mock.calls.at(-1)?.[0]);
    expect(output).not.toContain('"label": "local auth directory"');
    expect(output).not.toContain('"label": "credentials.enc.json"');
    expect(output).not.toContain('"label": "FENTARIS_AUTH_KEY"');
  });

  it("does not infer auth from a generated .fentaris directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    delete rt.env.FENTARIS_AUTH_KEY;
    await mkdir(join(rt.cwd, ".fentaris"), { recursive: true });
    await writeFile(join(rt.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    await expect(main(["check", "--offline", "--strict"], rt)).resolves.toBe(0);
    await expect(main(["doctor", "--json"], rt)).resolves.toBe(0);

    const output = String(vi.mocked(rt.out.log).mock.calls.at(-1)?.[0]);
    expect(output).not.toContain('"label": "credentials.enc.json"');
    expect(output).not.toContain('"label": "FENTARIS_AUTH_KEY"');
  });

  it("uses runtime auth keys for strict project checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["check", "--offline", "--strict"], rt)).resolves.toBe(0);
  });

  it("checks and fixes .gitignore entries for custom auth directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir, "secrets");
    await writeFile(join(dir, ".gitignore"), ".fentaris/\n");
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["doctor", "--fix"], rt)).resolves.toBe(0);

    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain("secrets/*\n");
    expect(gitignore).toContain("!secrets/secrets.manifest.json\n");
    expect(rt.prompt.confirm).toHaveBeenCalledWith("Apply fix for .gitignore auth entry?");
  });

  it("prompts before applying doctor fixes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["doctor", "--fix"], rt)).resolves.toBe(0);

    expect(rt.prompt.confirm).toHaveBeenCalledWith("Apply fix for CLI local directory?");
    await expect(readdir(join(dir, ".fentaris"))).resolves.toEqual([]);
  });

  it("reports invalid fentaris.json diagnostics without throwing discovery errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeFile(join(dir, "fentaris.json"), JSON.stringify({ name: "demo", packageManager: "yarn", entrypoint: "/tmp/app.ts", port: 90_000, path: "mcp", authDir: "." }));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });

    await expect(main(["doctor", "--json"], rt)).resolves.toBe(1);

    const output = String(vi.mocked(rt.out.log).mock.calls[0]?.[0]);
    expect(output).toContain('"label": "project root"');
    expect(output).toContain("not valid");
  });

  it("emits richer doctor diagnostics for generated projects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: true });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    await expect(main(["doctor", "--json"], rt)).resolves.toBe(0);

    const output = String(vi.mocked(rt.out.log).mock.calls.at(-1)?.[0]);
    expect(output).toContain('"group": "Config"');
    expect(output).toContain('"label": "@fentaris/core"');
    expect(output).toContain('"label": "lockfile"');
    expect(output).not.toContain('"label": "credential decrypt"');
    expect(output).not.toContain("test-key");
  });

  it("does not expose deploy before it is implemented", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir);
    await expect(main(["deploy"], rt)).resolves.toBe(2);
    expect(rt.out.error).toHaveBeenCalledWith(expect.stringContaining("error: unrecognized subcommand 'deploy'"));
  });
});

describe("secrets", () => {
  it("stores redacted user secrets in FentarisAuth-compatible credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const project = join(dir, "project");
    const authDir = join(project, ".fentaris", "auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(project, "fentaris.config.json"),
      JSON.stringify({ name: "demo", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: ".fentaris/auth" }),
    );
    await writeFile(
      join(authDir, "credentials.enc.json"),
      JSON.stringify(FentarisAuth.encryptCredentials({ users: {}, groups: {}, defaults: {} }, "test-key")),
    );
    await writeFile(join(authDir, "upstream-auth.json"), JSON.stringify({ servers: {} }));

    const rt = runtime(project);
    await expect(main(["secrets", "set", "github.token", "--user", "alice"], rt)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(authDir, "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.users.alice?.credentials["github.token"]).toBe("secret-value");
    const output = vi.mocked(rt.out.log).mock.calls.flat().join("\n");
    expect(output).toContain("Review");
    expect(output).toContain("Value: <redacted>");
    expect(rt.prompt.confirm).toHaveBeenCalledWith("Store this credential?");
  });

  it("accepts an explicit local encryption key for secrets set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const project = join(dir, "project");
    const authDir = join(project, ".fentaris");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(project, "fentaris.json"),
      JSON.stringify({ name: "demo", packageManager: "pnpm", entrypoint: "src/index.ts", port: 4000, path: "/mcp", authDir: ".fentaris" }),
    );

    const rt = runtime(project);
    delete rt.env.FENTARIS_AUTH_KEY;
    await expect(main(["secrets", "set", "github.token", "--key", "test-key", "--value", "-secret-value"], rt)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(authDir, "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.defaults["github.token"]).toBe("-secret-value");
    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(rt.out.error.mock.calls.flat().join("\n")).toContain("--key exposes");
    expect(rt.out.error.mock.calls.flat().join("\n")).toContain("--value exposes");
  });

  it("reads secret values from stdin without prompting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const input = new PassThrough();
    input.end("stdin-secret\n");

    const rt = runtime(dir);
    await withFakeStdin(input, async () => {
      await expect(main(["secrets", "set", "github.token", "--value-stdin"], rt)).resolves.toBe(0);
    });

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.defaults["github.token"]).toBe("stdin-secret");
    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(rt.prompt.confirm).not.toHaveBeenCalled();
  });

  it("supports non-interactive secrets set when all input is explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const input = new PassThrough();
    input.end("stdin-secret\n");

    const rt = runtime(dir);
    await withFakeStdin(input, async () => {
      await expect(main(["secrets", "set", "github.token", "--value-stdin", "--non-interactive"], rt)).resolves.toBe(0);
    });

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.defaults["github.token"]).toBe("stdin-secret");
    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(rt.prompt.select).not.toHaveBeenCalled();
    expect(rt.prompt.confirm).not.toHaveBeenCalled();
  });

  it("adds and lists user API keys without storing raw values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const input = new PassThrough();
    input.end("alice-api-key\n");

    const rt = runtime(dir);
    await withFakeStdin(input, async () => {
      await expect(main(["auth", "api-key", "add", "alice", "--value-stdin"], rt)).resolves.toBe(0);
    });

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.users.alice?.apiKeys).toHaveLength(1);
    expect(credentials.users.alice?.apiKeys[0]).toMatch(/^sha256:/);
    expect(credentials.users.alice?.apiKeys[0]).not.toBe("alice-api-key");
    expect(FentarisAuth.compareApiKey(credentials.users.alice?.apiKeys[0] ?? "", "alice-api-key")).toBe(true);

    const listRuntime = runtime(dir);
    await expect(main(["auth", "api-key", "list"], listRuntime)).resolves.toBe(0);
    const output = listRuntime.out.log.mock.calls.flat().join("\n");
    expect(output).toContain("alice");
    expect(output).toContain("1 key");
    expect(output).not.toContain("alice-api-key");
  });

  it("does not duplicate existing user API keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const input = new PassThrough();
      input.end("alice-api-key\n");
      const rt = runtime(dir);
      await withFakeStdin(input, async () => {
        await expect(main(["auth", "api-key", "add", "alice", "--value-stdin"], rt)).resolves.toBe(0);
      });
    }

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.users.alice?.apiKeys).toHaveLength(1);
  });

  it("removes user API keys by value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const credentialsPath = join(dir, ".fentaris", "credentials.enc.json");
    await writeFile(
      credentialsPath,
      JSON.stringify(
        FentarisAuth.encryptCredentials(
          {
            users: { alice: { apiKeys: [FentarisAuth.hashApiKey("alice-api-key")], credentials: {} } },
            groups: {},
            defaults: {},
          },
          "test-key",
        ),
      ),
    );

    const input = new PassThrough();
    input.end("alice-api-key\n");
    const rt = runtime(dir);
    await withFakeStdin(input, async () => {
      await expect(main(["auth", "api-key", "remove", "alice", "--value-stdin"], rt)).resolves.toBe(0);
    });

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(credentialsPath, "utf8")) as unknown, "test-key");
    expect(credentials.users.alice).toBeUndefined();
  });

  it("generates user API keys and prints them once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const rt = runtime(dir);

    await expect(main(["auth", "api-key", "add", "alice", "--generate"], rt)).resolves.toBe(0);

    const output = rt.out.log.mock.calls.flat().join("\n");
    const match = output.match(/Generated key:[^\n]* ([A-Za-z0-9_-]+)/);
    expect(match?.[1]).toBeTruthy();
    const generated = match?.[1] ?? "";
    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(FentarisAuth.compareApiKey(credentials.users.alice?.apiKeys[0] ?? "", generated)).toBe(true);
  });

  it("fails non-interactive secrets set instead of prompting for missing input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const rt = runtime(dir);

    await expect(main(["secrets", "set", "--non-interactive"], rt)).resolves.toBe(1);

    expect(rt.out.error).toHaveBeenCalledWith(expect.stringContaining("Command requires interactive input"));
    expect(rt.prompt.text).not.toHaveBeenCalled();
    expect(rt.prompt.select).not.toHaveBeenCalled();
    expect(rt.prompt.confirm).not.toHaveBeenCalled();
  });

  it("prompts for reference, scope, and value when secrets set omits the reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { credential, fentaris, mcp } from "@fentaris/core";
const app = fentaris({ defaults: { credentials: { "github.token": credential("github.token") } } });
app.mcp("github", { transport: { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} } });
`,
    );

    const rt = runtime(dir);
    rt.prompt = prompt(["alice", "secret-value"], ["github.token (default)", "user"]);

    await expect(main(["secrets", "set"], rt)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.users.alice?.credentials["github.token"]).toBe("secret-value");
    expect(rt.prompt.select).toHaveBeenCalledWith("Secret reference", ["github.token (default)", "Add another reference"]);
    expect(rt.prompt.select).toHaveBeenCalledWith("Credential scope", ["default", "user", "group"]);
    expect(rt.prompt.confirm).toHaveBeenCalledWith("Store this credential?");
    const output = rt.out.log.mock.calls.flat().join("\n");
    expect(output).toContain("Stored github.token as user alice credential.");
    expect(output.match(/Credential scope/g) ?? []).toHaveLength(0);
  });

  it("selects known user ids from the project entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { credential, fentaris, group, Policy, user } from "@fentaris/core";
const app = fentaris({
  defaults: { credentials: { "github.token": credential("github.token") } },
  groups: [group({ id: "support", users: [user("bob")], policy: Policy.allowAll() })],
});
void app;
`,
    );

    const rt = runtime(dir);
    rt.prompt = prompt(["secret-value"], ["github.token (default)", "user", "bob"]);

    await expect(main(["secrets", "set"], rt)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.users.bob?.credentials["github.token"]).toBe("secret-value");
    expect(rt.prompt.select).toHaveBeenCalledWith("User id", ["bob", "Add another user id"], { visibleItems: 8 });
    expect(rt.prompt.text).toHaveBeenCalledTimes(1);
  });

  it("selects known group ids and supports manual group id entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { credential, fentaris, group, Policy, user } from "@fentaris/core";
const app = fentaris({
  defaults: { credentials: { "github.token": credential("github.token") } },
  groups: [group({ id: "support", users: [user("bob")], policy: Policy.allowAll() })],
});
void app;
`,
    );

    const knownGroup = runtime(dir);
    knownGroup.prompt = prompt(["secret-value"], ["github.token (default)", "group", "support"]);

    await expect(main(["secrets", "set"], knownGroup)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.groups.support?.["github.token"]).toBe("secret-value");
    expect(knownGroup.prompt.select).toHaveBeenCalledWith("Group id", ["support", "Add another group id"], { visibleItems: 8 });

    const manualGroup = runtime(dir);
    manualGroup.prompt = prompt(["custom", "secret-value"], ["github.token (default)", "group", "Add another group id"]);

    await expect(main(["secrets", "set"], manualGroup)).resolves.toBe(0);

    const updatedCredentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(updatedCredentials.groups.custom?.["github.token"]).toBe("secret-value");
  });

  it("does not store a prompted secret when the review is declined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);

    const rt = runtime(dir);
    rt.prompt.confirm = vi.fn(async () => false);

    await expect(main(["secrets", "set", "github.token"], rt)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.defaults["github.token"]).toBeUndefined();
    expect(rt.out.log.mock.calls.flat().join("\n")).toContain("Secret was not stored.");
  });

  it("lists stored secret references without values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { credential, fentaris, mcp } from "@fentaris/core";
const app = fentaris({ defaults: { credentials: { "github.token": credential("github.token") } } });
app.mcp("github", { transport: { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} } });
`,
    );
    const backendDir = join(dir, ".fentaris");
    const credentials = FentarisAuth.decryptCredentials(
      JSON.parse(await readFile(join(backendDir, "credentials.enc.json"), "utf8")) as unknown,
      "test-key",
    );
    credentials.defaults["github.token"] = "secret";
    await writeFile(join(backendDir, "credentials.enc.json"), JSON.stringify(FentarisAuth.encryptCredentials(credentials, "test-key")));

    const rt = runtime(dir);
    await expect(main(["secrets", "list"], rt)).resolves.toBe(0);
    const output = rt.out.log.mock.calls.flat().join("\n");
    expect(output).toContain("github.token");
    expect(output).toContain("set");
    expect(output).not.toContain("secret");
  });

  it("does not satisfy required user credentials with stored API keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, ".fentaris", "secrets.manifest.json"),
      JSON.stringify({ version: 1, references: [{ ref: "alice", scope: "user:alice" }] }),
    );
    const input = new PassThrough();
    input.end("alice-api-key\n");

    const rt = runtime(dir);
    await withFakeStdin(input, async () => {
      await expect(main(["auth", "api-key", "add", "alice", "--value-stdin"], rt)).resolves.toBe(0);
    });

    const listRuntime = runtime(dir);
    await expect(main(["secrets", "list", "--json"], listRuntime)).resolves.toBe(0);
    const output = JSON.parse(listRuntime.out.log.mock.calls.flat().join("\n")) as {
      secrets: Array<{ ref: string; scope: string; kind: string; status: string }>;
    };
    expect(output.secrets).toEqual(
      expect.arrayContaining([
        { ref: "alice", scope: "user:alice", kind: "credential", status: "missing" },
        { ref: "alice", scope: "user:alice", kind: "apiKey", status: "1 key" },
      ]),
    );
  });

  it("generates and checks the secrets manifest from the entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { bearer, credential, fentaris, mcp } from "@fentaris/core";
const app = fentaris({});
app.mcp("github", { transport: { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} }, auth: bearer(credential("github.token")) });
`,
    );

    const rt = runtime(dir);
    await expect(main(["secrets", "manifest"], rt)).resolves.toBe(0);
    const manifest = JSON.parse(await readFile(join(dir, ".fentaris", "secrets.manifest.json"), "utf8")) as { references: Array<{ ref: string }> };
    expect(manifest.references).toEqual([{ ref: "github.token", scope: "default" }]);
    await expect(main(["secrets", "manifest", "--check"], rt)).resolves.toBe(0);
  });

  it("generates scoped secret refs and credential env vars from the entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { bearer, credential, credentialEnv, fentaris, group, mcp, user } from "@fentaris/core";
const app = fentaris({
  users: [user("alice", { credentials: { "linear.env": credentialEnv("LINEAR_TOKEN"), "linear.token": credential("linear.token") } })],
  groups: [group({ id: "support", credentials: { "github.token": credentialEnv("SUPPORT_GITHUB_TOKEN") } })],
});
app.mcp("github", { transport: { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} }, auth: bearer(credential("default.token")) });
`,
    );

    const rt = runtime(dir);
    await expect(main(["secrets", "manifest"], rt)).resolves.toBe(0);
    const manifest = JSON.parse(await readFile(join(dir, ".fentaris", "secrets.manifest.json"), "utf8")) as {
      references: Array<{ ref: string; scope: string }>;
      envVars: string[];
    };
    expect(manifest.references).toEqual([
      { ref: "default.token", scope: "default" },
      { ref: "github.token", scope: "group:support" },
      { ref: "linear.env", scope: "user:alice" },
      { ref: "linear.token", scope: "user:alice" },
    ]);
    expect(manifest.envVars).toEqual(["LINEAR_TOKEN", "SUPPORT_GITHUB_TOKEN"]);
  });

  it("wraps invalid secrets manifest JSON errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(join(dir, ".fentaris", "secrets.manifest.json"), "{ nope");

    const rt = runtime(dir);
    await expect(main(["secrets", "list"], rt)).resolves.toBe(1);
    const output = rt.out.error.mock.calls.flat().join("\n");
    expect(output).toContain("Unable to parse secrets manifest");
    expect(output).not.toContain("SyntaxError");
  });

  it("creates the auth directory when generating the secrets manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await rm(join(dir, ".fentaris"), { recursive: true, force: true });
    await writeFile(
      join(dir, "src", "index.ts"),
      `import { bearer, credential, fentaris, mcp } from "@fentaris/core";
const app = fentaris({});
app.mcp("github", { transport: { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} }, auth: bearer(credential("github.token")) });
`,
    );

    const rt = runtime(dir);
    await expect(main(["secrets", "manifest"], rt)).resolves.toBe(0);
    await expect(readFile(join(dir, ".fentaris", "secrets.manifest.json"), "utf8")).resolves.toContain("github.token");
  });

  it("reports missing secrets via secrets doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, ".fentaris", "secrets.manifest.json"),
      JSON.stringify({ version: 1, references: [{ ref: "github.token", scope: "default" }] }),
    );

    const rt = runtime(dir);
    await expect(main(["secrets", "doctor"], rt)).resolves.toBe(0);
    const output = rt.out.log.mock.calls.flat().join("\n");
    expect(output).toContain("github.token");
    expect(output).toContain("missing");
    expect(output).toContain("fentaris secrets set github.token");
  });

  it("uses an explicit key for secrets doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    await writeFile(
      join(dir, ".fentaris", "secrets.manifest.json"),
      JSON.stringify({ version: 1, references: [{ ref: "github.token", scope: "default" }] }),
    );
    const credentials = { users: {}, groups: {}, defaults: { "github.token": "secret" } };
    await writeFile(join(dir, ".fentaris", "credentials.enc.json"), JSON.stringify(FentarisAuth.encryptCredentials(credentials, "explicit-key")));

    const rt = runtime(dir);
    delete rt.env.FENTARIS_AUTH_KEY;
    await expect(main(["secrets", "doctor", "--key", "explicit-key"], rt)).resolves.toBe(0);
    expect(rt.out.log.mock.calls.flat().join("\n")).toContain("All secrets checks passed.");
  });

  it("unsets stored credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);
    const backendDir = join(dir, ".fentaris");
    const credentials = FentarisAuth.decryptCredentials(
      JSON.parse(await readFile(join(backendDir, "credentials.enc.json"), "utf8")) as unknown,
      "test-key",
    );
    credentials.defaults["github.token"] = "secret";
    await writeFile(join(backendDir, "credentials.enc.json"), JSON.stringify(FentarisAuth.encryptCredentials(credentials, "test-key")));

    const rt = runtime(dir);
    await expect(main(["secrets", "unset", "github.token"], rt)).resolves.toBe(0);
    const updated = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(backendDir, "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(updated.defaults["github.token"]).toBeUndefined();
  });

  it("reports when unset removes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    await writeHealthyProject(dir);

    const rt = runtime(dir);
    await expect(main(["secrets", "unset", "github.token"], rt)).resolves.toBe(0);
    expect(rt.out.log.mock.calls.flat().join("\n")).toContain("No github.token credential found");
  });
});
