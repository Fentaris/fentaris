import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { text as readStreamText } from "node:stream/consumers";
import { FentarisAuth, manifestFromSecretRefs, manifestsEqual, parseManifest, serializeManifest } from "@fentaris/core";
import { secretScope } from "../domain/auth/local-store.js";
import { credentialsPath, manifestPath, openLocalSecretsBackend, scopeFromOptions } from "../domain/secrets/backend.js";
import { buildListRows, getSecretsDoctorIssues, loadRequiredReferences } from "../domain/secrets/doctor.js";
import { scanEntrypointForSecrets } from "../domain/secrets/manifest-scan.js";
import { loadProjectEnv } from "../domain/project/env.js";
import { discoverSecretsProject } from "../domain/project/project.js";
import type { CliCommand, CliOptions, Runtime } from "../shared/types.js";
import { exists } from "../shared/utils.js";
import { section, style } from "../ui/format.js";

export async function runSecrets(command: CliCommand, runtime: Runtime): Promise<void> {
  const [action, reference] = command.args;
  if (!action) {
    throw new Error("Usage: fentaris secrets <set|list|unset|manifest|doctor> ...");
  }

  if (action === "set") {
    await runSecretsSet(command, reference, runtime);
    return;
  }
  if (action === "list") {
    await runSecretsList(command, runtime);
    return;
  }
  if (action === "unset") {
    await runSecretsUnset(command, reference, runtime);
    return;
  }
  if (action === "manifest") {
    await runSecretsManifest(command, runtime);
    return;
  }
  if (action === "doctor") {
    await runSecretsDoctor(command, runtime);
    return;
  }

  throw new Error(`Unknown secrets command "${action}". Run fentaris help.`);
}

async function runSecretsSet(command: CliCommand, reference: string | undefined, runtime: Runtime): Promise<void> {
  const project = await discoverSecretsProject(runtime.cwd);
  const input = await resolveSecretsSetInput(command, reference, runtime, project);
  const storagePath = path.relative(project.root, credentialsPath(project));
  const backend = await openLocalSecretsBackend(project, runtime, input.options);
  if (!(await backend.credentialsExist())) {
    await backend.initEmpty();
  }
  const promptedValue = typeof input.options.value !== "string" && input.options["value-stdin"] !== true;
  if (promptedValue) {
    section(runtime, "Secret value");
    runtime.out.log(`  ${style.hint(`${input.reference} will be hidden while stored and never printed back.`)}`);
  }
  const value = await resolveSecretValue(input.reference, input.options, runtime);
  if (promptedValue) {
    printSecretsSetReview(runtime, input.reference, input.options, storagePath);
    const confirmed = await runtime.prompt.confirm("Store this credential?");
    if (!confirmed) {
      section(runtime, "Secrets");
      runtime.out.log(`  ${style.warn("Secret was not stored.")}`);
      return;
    }
  }
  await backend.set(input.reference, value, scopeFromOptions(input.options));
  section(runtime, "Secrets");
  runtime.out.log(`  ${style.pass(`Stored ${input.reference} as ${secretScope(input.options)} credential.`)}`);
  runtime.out.log(`  ${style.hint("Value: <redacted>")}`);
  runtime.out.log(`  ${style.hint("Next:")} ${style.command("fentaris secrets doctor")}`);
}

async function resolveSecretsSetInput(
  command: CliCommand,
  reference: string | undefined,
  runtime: Runtime,
  project: Awaited<ReturnType<typeof discoverSecretsProject>>,
): Promise<{ reference: string; options: CliOptions }> {
  const options: CliOptions = { ...command.options };
  if (typeof options.user === "string" && typeof options.group === "string") {
    throw new Error("Use either --user or --group, not both.");
  }
  if (typeof options.value === "string" && options["value-stdin"] === true) {
    throw new Error("Use either --value or --value-stdin, not both.");
  }
  if (reference?.trim()) {
    return { reference: reference.trim(), options };
  }

  section(runtime, "Secrets setup");
  runtime.out.log(`  ${style.brand("Fentaris")} ${style.hint("local credential setup")}`);
  runtime.out.log(`  ${style.hint("Values are encrypted locally and are never printed.")}`);
  const required = await loadRequiredReferences(project);
  const customChoice = "Add another reference";
  let selectedReference = "";

  if (required.length > 0) {
    runtime.out.log("");
    runtime.out.log(`  ${style.heading("Secret reference")}`);
    runtime.out.log(`  ${style.hint("Detected from secrets.manifest.json")}`);
    const choices = required.map((entry) => `${entry.ref} (${entry.scope})`);
    const selected = await runtime.prompt.select("Secret reference", [...choices, customChoice]);
    if (selected !== customChoice) {
      const index = choices.indexOf(selected);
      const entry = required[index];
      selectedReference = entry?.ref ?? "";
      if (!hasScopeOption(options) && entry) {
        applyScopeLabel(options, entry.scope);
      }
    }
  }

  if (!selectedReference) {
    selectedReference = (await runtime.prompt.text("Secret reference")).trim();
  }
  if (!selectedReference) {
    throw new Error("Secret reference is required.");
  }

  if (!hasScopeOption(options)) {
    const scope = await runtime.prompt.select("Credential scope", ["default", "user", "group"]);
    if (scope === "user") {
      const user = await resolveSubjectId("user", options, runtime, project, required);
      if (!user) {
        throw new Error("User id is required.");
      }
      options.user = user;
    } else if (scope === "group") {
      const group = await resolveSubjectId("group", options, runtime, project, required);
      if (!group) {
        throw new Error("Group id is required.");
      }
      options.group = group;
    }
  }

  return { reference: selectedReference, options };
}

async function resolveSecretValue(reference: string, options: CliOptions, runtime: Runtime): Promise<string> {
  if (typeof options.value === "string") {
    runtime.out.error("Warning: --value exposes secret values in process arguments. Prefer --value-stdin or an interactive prompt.");
    return options.value;
  }
  if (options["value-stdin"] === true) {
    const value = (await readStreamText(process.stdin)).replace(/\r?\n$/, "");
    if (!value) {
      throw new Error(`Secret value for ${reference} was empty on stdin.`);
    }
    return value;
  }
  return runtime.prompt.text(reference, { secret: true });
}

function printSecretsSetReview(runtime: Runtime, reference: string, options: CliOptions, storagePath: string): void {
  section(runtime, "Review");
  const rows = [
    ["reference", reference],
    ["scope", secretScope(options)],
    ["storage", storagePath],
    ["value", "<redacted>"],
  ] as const;
  for (const [label, value] of rows) {
    runtime.out.log(`  ${style.label(label.padEnd(10))} ${style.hint("│")} ${value}`);
  }
}

function hasScopeOption(options: CliOptions): boolean {
  return typeof options.user === "string" || typeof options.group === "string";
}

function applyScopeLabel(options: CliOptions, scope: string): void {
  if (scope.startsWith("user:")) {
    options.user = scope.slice("user:".length);
  } else if (scope.startsWith("group:")) {
    options.group = scope.slice("group:".length);
  }
}

async function resolveSubjectId(
  kind: "user" | "group",
  options: CliOptions,
  runtime: Runtime,
  project: Awaited<ReturnType<typeof discoverSecretsProject>>,
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
  project: Awaited<ReturnType<typeof discoverSecretsProject>>,
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
  project: Awaited<ReturnType<typeof discoverSecretsProject>>,
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

async function loadEntrypointSubjectIds(kind: "user" | "group", project: Awaited<ReturnType<typeof discoverSecretsProject>>): Promise<string[]> {
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

async function runSecretsUnset(command: CliCommand, reference: string | undefined, runtime: Runtime): Promise<void> {
  if (!reference) {
    throw new Error("Usage: fentaris secrets unset <reference> [--user <id> | --group <id>]");
  }

  const project = await discoverSecretsProject(runtime.cwd);
  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  const removed = await backend.unset(reference, scopeFromOptions(command.options));
  section(runtime, "Secrets");
  if (!removed) {
    runtime.out.log(`  ${style.warn(`No ${reference} credential found in ${secretScope(command.options)} credentials.`)}`);
    return;
  }
  runtime.out.log(`  ${style.pass(`Removed ${reference} from ${secretScope(command.options)} credentials.`)}`);
}

async function runSecretsList(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverSecretsProject(runtime.cwd);
  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  const stored = await backend.listRefs();
  const required = await loadRequiredReferences(project);
  const rows = buildListRows(required, stored);

  if (command.options.json === true) {
    runtime.out.log(JSON.stringify({ provider: "local", secrets: rows }, null, 2));
    return;
  }

  section(runtime, "Secrets (local)");
  if (rows.length === 0) {
    runtime.out.log(`  ${style.hint("No secrets stored yet. Run fentaris secrets set <reference>.")}`);
    return;
  }

  runtime.out.log(`  ${style.label("REF".padEnd(24))}${style.label("SCOPE".padEnd(18))}${style.label("STATUS")}`);
  for (const row of rows) {
    const status = row.status === "missing" ? style.fail("missing") : row.status === "set" ? style.pass("set") : style.pass(row.status);
    runtime.out.log(`  ${row.ref.padEnd(24)}${row.scope.padEnd(18)}${status}`);
  }
}

async function runSecretsManifest(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverSecretsProject(runtime.cwd, {
    entrypoint: typeof command.options.entrypoint === "string" ? command.options.entrypoint : undefined,
    requireEntrypoint: true,
  });
  const entrypoint = path.join(project.root, project.config.entrypoint);
  if (!(await exists(entrypoint))) {
    throw new Error(`Entrypoint not found: ${project.config.entrypoint}`);
  }

  const scanned = await scanEntrypointForSecrets(entrypoint);
  const manifest = manifestFromSecretRefs(
    scanned.references.map((entry) => ({
      ref: entry.ref,
      scope: decodeManifestScope(entry.scope),
      kind: "credential" as const,
      count: 1,
    })),
    scanned.envVars,
  );
  const target = manifestPath(project);

  if (command.options.check === true) {
    if (!(await exists(target))) {
      throw new Error("secrets.manifest.json is missing. Run fentaris secrets manifest.");
    }
    const current = parseManifest(parseManifestJson(await readFile(target, "utf8"), target));
    if (!manifestsEqual(current, manifest)) {
      throw new Error("secrets.manifest.json is out of date. Run fentaris secrets manifest.");
    }
    section(runtime, "Secrets manifest");
    runtime.out.log(`  ${style.pass("secrets.manifest.json matches entrypoint.")}`);
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, serializeManifest(manifest));
  section(runtime, "Secrets manifest");
  runtime.out.log(`  ${style.pass(`Wrote ${path.relative(project.root, target)}`)}`);
  runtime.out.log(`  ${style.hint(`${manifest.references.length} credential reference(s)${manifest.envVars?.length ? `, ${manifest.envVars.length} env var(s)` : ""}.`)}`);
}

function parseManifestJson(source: string, filePath: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Unable to parse secrets manifest at ${filePath}: ${detail}`, { cause: error });
  }
}

async function runSecretsDoctor(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverSecretsProject(runtime.cwd);
  const key = typeof command.options.key === "string" ? command.options.key : undefined;
  const issues = await getSecretsDoctorIssues(project, runtime, { strict: command.options.strict === true, key });

  if (command.options.json === true) {
    runtime.out.log(JSON.stringify({ issues }, null, 2));
  } else {
    section(runtime, "Secrets doctor");
    if (issues.length === 0) {
      runtime.out.log(`  ${style.pass("All secrets checks passed.")}`);
    } else {
      for (const issue of issues) {
        const marker = issue.status === "pass" ? style.pass : issue.status === "warn" ? style.warn : style.fail;
        runtime.out.log(`  ${marker(`${issue.ref} (${issue.scope})`)} ${style.hint(issue.detail)}`);
        if (issue.hint) {
          runtime.out.log(`    ${style.hint(`→ ${issue.hint}`)}`);
        }
      }
    }
  }

  if (issues.some((issue) => issue.status === "fail") || (command.options.strict === true && issues.some((issue) => issue.status === "warn"))) {
    throw new Error("Secrets doctor reported issues.");
  }
}

function decodeManifestScope(scope: string) {
  if (scope === "default") {
    return { kind: "default" as const };
  }
  if (scope.startsWith("user:")) {
    return { kind: "user" as const, id: scope.slice("user:".length) };
  }
  if (scope.startsWith("group:")) {
    return { kind: "group" as const, id: scope.slice("group:".length) };
  }
  return { kind: "default" as const };
}
