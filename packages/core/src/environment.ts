import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";

/** Find the nearest project boundary before loading its environment. @pk */
export function findEnvironmentProjectRoot(from = process.cwd()): string {
  let current = path.resolve(from);
  while (true) {
    if (existsSync(path.join(current, "fentaris.json")) || existsSync(path.join(current, "fentaris.config.json")) || existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(from);
    current = parent;
  }
}

/** Load .env without overwriting defined process/caller environment values. @pk */
export function loadProjectEnvironment(root: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = path.join(root, ".env");
  const env: NodeJS.ProcessEnv = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  for (const [name, value] of Object.entries(baseEnv)) if (value !== undefined) env[name] = value;
  return env;
}

/** Apply project defaults before application configuration is evaluated. @pk */
export function applyProjectEnvironment(root = findEnvironmentProjectRoot()): NodeJS.ProcessEnv {
  const env = loadProjectEnvironment(root);
  for (const [name, value] of Object.entries(env)) if (value !== undefined && process.env[name] === undefined) process.env[name] = value;
  return env;
}

applyProjectEnvironment();
