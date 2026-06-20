import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileWithCallback, type SpawnOptions } from "node:child_process";
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

async function writeHealthyProject(root: string, authDirectory = ".fentaris"): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, authDirectory), { recursive: true });
  await writeFile(join(root, "README.md"), "# Demo\n");
  await writeFile(join(root, ".env"), "FENTARIS_AUTH_KEY=test-key\n");
  await writeFile(join(root, ".gitignore"), `${authDirectory}/\n`);
  await writeFile(join(root, "src", "index.ts"), "console.log('demo');\n");
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
    expect(rt.out.error).toHaveBeenCalledWith(expect.stringContaining("error: unrecognized subcommand 'auth'"));
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
    expect(rendered.files["src/index.ts"]).toContain("const app = fentaris();");
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
    expect(rt.out.log).toHaveBeenCalledWith("Value: <redacted>");
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
  });

  it("uses the selected manifest scope when secrets set omits the reference", async () => {
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
    rt.prompt = prompt(["secret-value"], ["github.token (default)"]);

    await expect(main(["secrets", "set"], rt)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.defaults["github.token"]).toBe("secret-value");
    expect(rt.prompt.select).toHaveBeenCalledWith("Secret reference", ["github.token (default)", "Add another reference"]);
    expect(rt.prompt.select).not.toHaveBeenCalledWith("Credential scope", ["default", "user", "group"]);
    expect(rt.out.log.mock.calls.flat().join("\n")).toContain("Stored github.token as default credential.");
  });

  it("prompts for reference, scope, and value when adding a custom secret reference", async () => {
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
    rt.prompt = prompt(["github.token", "alice", "secret-value"], ["Add another reference", "user"]);

    await expect(main(["secrets", "set"], rt)).resolves.toBe(0);

    const credentials = FentarisAuth.decryptCredentials(JSON.parse(await readFile(join(dir, ".fentaris", "credentials.enc.json"), "utf8")) as unknown, "test-key");
    expect(credentials.users.alice?.credentials["github.token"]).toBe("secret-value");
    expect(rt.prompt.select).toHaveBeenCalledWith("Secret reference", ["github.token (default)", "Add another reference"]);
    expect(rt.prompt.select).toHaveBeenCalledWith("Credential scope", ["default", "user", "group"]);
    expect(rt.out.log.mock.calls.flat().join("\n")).toContain("Stored github.token as user alice credential.");
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
});
