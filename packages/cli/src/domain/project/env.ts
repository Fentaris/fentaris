import { readFile } from "node:fs/promises";
import path from "node:path";
import { exists } from "../../shared/utils.js";

export async function loadProjectEnv(root: string, baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const filePath = path.join(root, ".env");
  if (!(await exists(filePath))) {
    return { ...baseEnv };
  }

  return { ...parseDotEnv(await readFile(filePath, "utf8")), ...baseEnv };
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
