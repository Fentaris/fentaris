#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main as runMain } from "./app/main.js";
import { discoverProject, discoverSecretsProject, ensureEmptyTargetDirectory, resolveProjectName, selectPackageManager } from "./domain/project/project.js";
import { renderEntrypoint, renderTemplate } from "./domain/template/template.js";
import { defaultRuntime } from "./platform/runtime.js";
import { parseCommand } from "./shared/parse.js";
import type { Runtime } from "./shared/types.js";

export { discoverProject, discoverSecretsProject, ensureEmptyTargetDirectory, parseCommand, renderEntrypoint, renderTemplate, resolveProjectName, selectPackageManager };
export type { Prompt, Runtime } from "./shared/types.js";

export function main(argv: string[], runtime: Runtime = defaultRuntime()): Promise<number> {
  return runMain(argv, runtime);
}

function resolveEntrypointPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isDirectCliInvocation(entrypointUrl: string = import.meta.url, argvPath: string | undefined = process.argv[1]): boolean {
  return typeof argvPath === "string" && resolveEntrypointPath(fileURLToPath(entrypointUrl)) === resolveEntrypointPath(argvPath);
}

if (isDirectCliInvocation()) {
  runMain(process.argv.slice(2), defaultRuntime()).then((code) => {
    process.exitCode = code;
  });
}
