import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpawnOptions } from "node:child_process";
import { pathToFileURL } from "node:url";
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

function prompt(values: string[] = []): Prompt {
  return {
    text: vi.fn(async () => values.shift() ?? ""),
    select: async <T extends string>(_question: string, choices: T[]) => choices[0],
    confirm: vi.fn(async () => true),
    close: vi.fn(),
  };
}

function runtime(cwd: string, probes: Record<string, boolean> = {}): Runtime & { calls: Array<{ command: string; args: string[]; cwd?: string | URL }> } {
  const calls: Array<{ command: string; args: string[]; cwd?: string | URL }> = [];
  return {
    cwd,
    env: { FENTARIS_AUTH_KEY: "test-key" },
    out: { log: vi.fn(), error: vi.fn() },
    runner: vi.fn(async (command: string, args: string[], options?: SpawnOptions) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { code: 0 };
    }),
    probe: vi.fn((command: string) => probes[command] ?? false),
    prompt: prompt(["secret-value"]),
    calls,
  };
}

describe("command routing helpers", () => {
  it("parses nested commands and options", () => {
    expect(parseCommand(["secrets", "set", "github.token", "--user", "alice"])).toEqual({
      name: "secrets",
      args: ["set", "github.token"],
      options: { user: "alice" },
    });
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
      authKey: "auth-key",
      guestApiKey: "guest-key",
      adminApiKey: "admin-key",
    });

    expect(Object.keys(rendered.files).sort()).toEqual([
      ".env.example",
      ".gitignore",
      "README.md",
      "demo-files/README.md",
      "fentaris.json",
      "package.json",
      "src/index.ts",
      "tsconfig.json",
    ]);
    expect(rendered.files[".gitignore"]).toContain(".fentaris/");
    expect(rendered.files["README.md"]).toContain("Quick start");
    expect(rendered.files["src/index.ts"]).toContain("https://mcp.specification.website/mcp");
    expect(rendered.files["src/index.ts"]).toContain("app.mcp(");
    expect(rendered.files["src/index.ts"]).toContain("credentialJson");
    expect(rendered.files["src/index.ts"]).toContain("rateLimitMiddleware");
    expect(rendered.files["src/index.ts"]).toContain("admin-full-access");

    const packageJson = JSON.parse(rendered.files["package.json"] ?? "{}") as { devDependencies?: Record<string, string> };
    expect(packageJson.devDependencies).toMatchObject({
      "@types/node": "latest",
      typescript: "latest",
    });
  });
});

describe("project commands", () => {
  it("initializes a project with dry-run install and git commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });

    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    const config = JSON.parse(await readFile(join(dir, "demo", "fentaris.json"), "utf8")) as { name: string };
    expect(config.name).toBe("demo");
    expect(rt.calls.some((call) => call.command === "git" && call.args[0] === "init")).toBe(true);
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

  it("validates check modes and strict warning exit behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir, { pnpm: true, git: true, docker: false });
    await expect(main(["init", "demo", "--skip-install"], rt)).resolves.toBe(0);

    rt.cwd = join(dir, "demo");
    await expect(main(["check", "--offline"], rt)).resolves.toBe(0);
    await expect(main(["check", "--offline", "--strict"], rt)).resolves.toBe(1);
    await expect(main(["doctor", "--strict"], rt)).resolves.toBe(1);
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
    await expect(main(["doctor", "--json"], rt)).resolves.toBe(1);

    const output = String(vi.mocked(rt.out.log).mock.calls.at(-1)?.[0]);
    expect(output).toContain('"group": "Config"');
    expect(output).toContain('"label": "@fentaris/core"');
    expect(output).toContain('"label": "lockfile"');
    expect(output).toContain('"label": "credential decrypt"');
    expect(output).not.toContain("test-key");
  });

  it("does not expose deploy before it is implemented", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fentaris-cli-"));
    const rt = runtime(dir);
    await expect(main(["deploy"], rt)).resolves.toBe(1);
    expect(rt.out.error).toHaveBeenCalledWith(expect.stringContaining('Unknown command "deploy"'));
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
});
