import { randomBytes } from "node:crypto";
import { appendFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { exists } from "../../shared/utils.js";

export async function loadProjectEnv(root: string, baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const filePath = path.join(root, ".env");
  if (!(await exists(filePath))) {
    return { ...baseEnv };
  }

  return { ...parseDotEnv(await readFile(filePath, "utf8")), ...baseEnv };
}

export async function ensureProjectAuthKey(root: string, baseEnv: NodeJS.ProcessEnv): Promise<{ env: NodeJS.ProcessEnv; key: string; created: boolean }> {
  const env = await loadProjectEnv(root, baseEnv);
  const existing = env.FENTARIS_AUTH_KEY?.trim();
  if (existing) {
    return { env, key: existing, created: false };
  }

  const filePath = path.join(root, ".env");
  const contents = (await exists(filePath)) ? await readFile(filePath, "utf8") : "";
  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  const key = randomBytes(32).toString("base64url");
  await appendFile(filePath, `${prefix}FENTARIS_AUTH_KEY=${key}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
  }

  return { env: { ...env, FENTARIS_AUTH_KEY: key }, key, created: true };
}

export function parseDotEnv(contents: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const assignment = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const name = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      continue;
    }

    env[name] = parseDotEnvValue(assignment.slice(equalsIndex + 1).trim());
  }

  return env;
}

function parseDotEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}
