import { readFile } from "node:fs/promises";
import path from "node:path";
import { FentarisAuth } from "@fentaris/core";
import { loadProjectEnv } from "../project/env.js";
import type { ProjectDiscovery, CliOptions, Runtime } from "../../shared/types.js";
import { exists } from "../../shared/utils.js";
import { credentialsPath } from "../secrets/backend.js";

export async function resolveSubjectId(
  kind: "user" | "group",
  options: CliOptions,
  runtime: Runtime,
  project: ProjectDiscovery,
  required: Array<{ scope: string }>,
): Promise<string> {
  const label = kind === "user" ? "User id" : "Group id";
  const knownIds = await loadKnownSubjectIds(kind, options, runtime, project, required);
  if (knownIds.length === 0) {
    return (await runtime.prompt.text(label)).trim();
  }

  const customChoice = `Add another ${kind} id`;
  const selected = await runtime.prompt.select(label, [...knownIds, customChoice], { visibleItems: 8 });
  if (selected === customChoice) {
    return (await runtime.prompt.text(label)).trim();
  }
  return selected;
}

async function loadKnownSubjectIds(
  kind: "user" | "group",
  options: CliOptions,
  runtime: Runtime,
  project: ProjectDiscovery,
  required: Array<{ scope: string }>,
): Promise<string[]> {
  const ids = new Set<string>();
  const prefix = `${kind}:`;

  for (const entry of required) {
    if (entry.scope.startsWith(prefix)) {
      ids.add(entry.scope.slice(prefix.length));
    }
  }

  for (const id of await loadStoredSubjectIds(kind, options, runtime, project)) {
    ids.add(id);
  }

  for (const id of await loadEntrypointSubjectIds(kind, project)) {
    ids.add(id);
  }

  return Array.from(ids).filter(Boolean).sort((left, right) => left.localeCompare(right));
}

async function loadStoredSubjectIds(
  kind: "user" | "group",
  options: CliOptions,
  runtime: Runtime,
  project: ProjectDiscovery,
): Promise<string[]> {
  const env = await loadProjectEnv(project.root, runtime.env);
  const key = typeof options.key === "string" ? options.key : env.FENTARIS_AUTH_KEY;
  if (!key?.trim() || !(await exists(credentialsPath(project)))) {
    return [];
  }

  try {
    const envelope = JSON.parse(await readFile(credentialsPath(project), "utf8")) as unknown;
    const credentials = FentarisAuth.decryptCredentials(envelope, key);
    return kind === "user" ? Object.keys(credentials.users) : Object.keys(credentials.groups);
  } catch {
    return [];
  }
}

async function loadEntrypointSubjectIds(kind: "user" | "group", project: ProjectDiscovery): Promise<string[]> {
  const entrypoint = path.join(project.root, project.config.entrypoint);
  if (!(await exists(entrypoint))) {
    return [];
  }

  const source = await readFile(entrypoint, "utf8");
  const ids = new Set<string>();
  const patterns = kind === "user"
    ? [/\buser\s*\(\s*["'`]([^"'`]+)["'`]/g, /\bnew\s+User\s*\(\s*["'`]([^"'`]+)["'`]/g]
    : [
        /\bgroup\s*\(\s*\{[\s\S]*?\bid\s*:\s*["'`]([^"'`]+)["'`][\s\S]*?\}\s*\)/g,
        /\bnew\s+Group\s*\(\s*\{[\s\S]*?\bid\s*:\s*["'`]([^"'`]+)["'`][\s\S]*?\}\s*\)/g,
        /\bapp\.group\s*\(\s*["'`]([^"'`]+)["'`]/g,
      ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const id = match[1]?.trim();
      if (id) {
        ids.add(id);
      }
    }
  }

  return Array.from(ids);
}
