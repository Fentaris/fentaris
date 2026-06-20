import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { manifestFromSecretRefs, manifestsEqual, parseManifest, serializeManifest } from "@fentaris/core";
import { secretScope } from "../domain/auth/local-store.js";
import { manifestPath, openLocalSecretsBackend, scopeFromOptions } from "../domain/secrets/backend.js";
import { buildListRows, getSecretsDoctorIssues, loadRequiredReferences } from "../domain/secrets/doctor.js";
import { scanEntrypointForSecrets } from "../domain/secrets/manifest-scan.js";
import { discoverProject } from "../domain/project/project.js";
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
  const project = await discoverProject(runtime.cwd);
  const input = await resolveSecretsSetInput(command, reference, runtime, project);
  const backend = await openLocalSecretsBackend(project, runtime, input.options);
  if (!(await backend.credentialsExist())) {
    await backend.initEmpty();
  }
  const value = typeof input.options.value === "string" ? input.options.value : await runtime.prompt.text(`Secret value for ${input.reference}`, { secret: true });
  await backend.set(input.reference, value, scopeFromOptions(input.options));
  section(runtime, "Secrets");
  runtime.out.log(`  ${style.pass(`Stored ${input.reference} as ${secretScope(input.options)} credential.`)}`);
  runtime.out.log("Value: <redacted>");
}

async function resolveSecretsSetInput(
  command: CliCommand,
  reference: string | undefined,
  runtime: Runtime,
  project: Awaited<ReturnType<typeof discoverProject>>,
): Promise<{ reference: string; options: CliOptions }> {
  const options: CliOptions = { ...command.options };
  if (typeof options.user === "string" && typeof options.group === "string") {
    throw new Error("Use either --user or --group, not both.");
  }
  if (reference?.trim()) {
    return { reference: reference.trim(), options };
  }

  section(runtime, "Secrets setup");
  const required = await loadRequiredReferences(project);
  const customChoice = "Add another reference";
  let selectedReference = "";
  let selectedManifestEntry = false;

  if (required.length > 0) {
    const choices = required.map((entry) => `${entry.ref} (${entry.scope})`);
    const selected = await runtime.prompt.select("Secret reference", [...choices, customChoice]);
    if (selected !== customChoice) {
      const index = choices.indexOf(selected);
      const entry = required[index];
      selectedReference = entry?.ref ?? "";
      selectedManifestEntry = Boolean(entry);
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

  if (!selectedManifestEntry && !hasScopeOption(options)) {
    const scope = await runtime.prompt.select("Credential scope", ["default", "user", "group"]);
    if (scope === "user") {
      const user = (await runtime.prompt.text("User id")).trim();
      if (!user) {
        throw new Error("User id is required.");
      }
      options.user = user;
    } else if (scope === "group") {
      const group = (await runtime.prompt.text("Group id")).trim();
      if (!group) {
        throw new Error("Group id is required.");
      }
      options.group = group;
    }
  }

  return { reference: selectedReference, options };
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

async function runSecretsUnset(command: CliCommand, reference: string | undefined, runtime: Runtime): Promise<void> {
  if (!reference) {
    throw new Error("Usage: fentaris secrets unset <reference> [--user <id> | --group <id>]");
  }

  const project = await discoverProject(runtime.cwd);
  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  await backend.unset(reference, scopeFromOptions(command.options));
  section(runtime, "Secrets");
  runtime.out.log(`  ${style.pass(`Removed ${reference} from ${secretScope(command.options)} credentials.`)}`);
}

async function runSecretsList(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
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
  const project = await discoverProject(runtime.cwd);
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
    const current = parseManifest(JSON.parse(await readFile(target, "utf8")) as unknown);
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

async function runSecretsDoctor(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
  const issues = await getSecretsDoctorIssues(project, runtime, { strict: command.options.strict === true });

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
