import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { manifestFromSecretRefs, manifestsEqual, parseManifest, serializeManifest } from "@fentaris/core";
import { secretScope } from "../domain/auth/local-store.js";
import { manifestPath, openLocalSecretsBackend, scopeFromOptions } from "../domain/secrets/backend.js";
import { buildListRows, getSecretsDoctorIssues, loadRequiredReferences } from "../domain/secrets/doctor.js";
import { scanEntrypointForSecrets } from "../domain/secrets/manifest-scan.js";
import { discoverProject } from "../domain/project/project.js";
import type { CliCommand, Runtime } from "../shared/types.js";
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
  if (!reference) {
    throw new Error("Usage: fentaris secrets set <reference> [--user <id> | --group <id>]");
  }

  const project = await discoverProject(runtime.cwd);
  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  if (!(await backend.credentialsExist())) {
    await backend.initEmpty();
  }
  const value = typeof command.options.value === "string" ? command.options.value : await runtime.prompt.text(`Secret value for ${reference}`, { secret: true });
  await backend.set(reference, value, scopeFromOptions(command.options));
  section(runtime, "Secrets");
  runtime.out.log(`  ${style.pass(`Stored ${reference} as ${secretScope(command.options)} credential.`)}`);
  runtime.out.log("Value: <redacted>");
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
