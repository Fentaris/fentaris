import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** Load project .env before configuration evaluation. Defined process values, including empty strings, win. */
export function loadProjectEnvironment(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return { ...base };
  try { return { ...parseEnv(readFileSync(file, "utf8")), ...base }; }
  catch { throw new Error("Unable to load the project .env file. Check its format and file permissions."); }
}
/** Find the nearest project root without importing its configuration. */
export function findEnvironmentProjectRoot(from = process.cwd()): string {
  let current = path.resolve(from);
  while (true) {
    if (existsSync(path.join(current, "fentaris.json")) || existsSync(path.join(current, "fentaris.config.json")) || existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(from);
    current = parent;
  }
}
export function applyProjectEnvironment(root = findEnvironmentProjectRoot()): void {
  const loaded = loadProjectEnvironment(root);
  for (const [name, value] of Object.entries(loaded)) if (process.env[name] === undefined && value !== undefined) process.env[name] = value;
}
