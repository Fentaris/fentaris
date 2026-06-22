#!/usr/bin/env node
import { constants, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ParsedArgs = {
  command: "install" | "list" | "help";
  dest?: string;
  force: boolean;
  dryRun: boolean;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledSkillsDir = join(packageRoot, "skills");

function usage(): string {
  return [
    "Usage:",
    "  fentaris-codex-skills install [--dest <skills-dir>] [--force] [--dry-run]",
    "  fentaris-codex-skills list",
    "",
    "Examples:",
    "  npx @fentaris/codex-skills install",
    "  npx @fentaris/codex-skills install -- --dest ~/.codex/skills",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help", force: false, dryRun: false };
  }
  if (command !== "install" && command !== "list") {
    throw new Error(`Unknown command "${command}".\n\n${usage()}`);
  }

  const parsed: ParsedArgs = { command, force: false, dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--dest") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--dest requires a path.");
      }
      parsed.dest = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n\n${usage()}`);
  }

  return parsed;
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function resolveDestination(dest?: string): string {
  if (dest) {
    return resolve(expandHome(dest));
  }
  const codexHome = process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : join(homedir(), ".codex");
  return join(codexHome, "skills");
}

function bundledSkillNames(): string[] {
  return readdirSync(bundledSkillsDir)
    .filter((name) => {
      const skillPath = join(bundledSkillsDir, name);
      return statSync(skillPath).isDirectory() && existsSync(join(skillPath, "SKILL.md"));
    })
    .sort();
}

async function ensureSourceReadable(): Promise<void> {
  await access(bundledSkillsDir, constants.R_OK);
}

async function installSkills(args: ParsedArgs): Promise<number> {
  await ensureSourceReadable();
  const destination = resolveDestination(args.dest);
  const names = bundledSkillNames();

  if (names.length === 0) {
    throw new Error(`No bundled skills found at ${bundledSkillsDir}.`);
  }

  if (!args.dryRun) {
    mkdirSync(destination, { recursive: true });
  }

  for (const name of names) {
    const source = join(bundledSkillsDir, name);
    const target = join(destination, name);
    const exists = existsSync(target);

    if (exists && !args.force) {
      console.log(`skip ${name}: already exists at ${target}`);
      continue;
    }

    if (args.dryRun) {
      console.log(`${exists ? "replace" : "install"} ${name} -> ${target}`);
      continue;
    }

    if (exists) {
      rmSync(target, { recursive: true, force: true });
    }
    cpSync(source, target, { recursive: true, errorOnExist: false });
    console.log(`${exists ? "replaced" : "installed"} ${name} -> ${target}`);
  }

  console.log("Restart Codex to pick up new skills.");
  return 0;
}

async function listSkills(): Promise<number> {
  await ensureSourceReadable();
  for (const name of bundledSkillNames()) {
    console.log(name);
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help") {
    console.log(usage());
    return 0;
  }
  if (args.command === "list") {
    return listSkills();
  }
  return installSkills(args);
}

function resolveEntrypointPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDirectCliInvocation(entrypointUrl: string = import.meta.url, argvPath: string | undefined = process.argv[1]): boolean {
  return typeof argvPath === "string" && resolveEntrypointPath(fileURLToPath(entrypointUrl)) === resolveEntrypointPath(argvPath);
}

if (isDirectCliInvocation()) {
  main().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
