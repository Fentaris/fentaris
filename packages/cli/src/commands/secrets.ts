import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { manifestsEqual, parseManifest, serializeManifest, type SecretsManifest } from "@fentaris/core";
import { manifestPath } from "../domain/secrets/backend.js";
import { getSecretsDoctorIssues } from "../domain/secrets/doctor.js";
import { scanEntrypointForSecrets } from "../domain/secrets/manifest-scan.js";
import { runGuidedSecretsSetup } from "../domain/secrets/setup.js";
import { discoverSecretsProject } from "../domain/project/project.js";
import type { CliCommand, Runtime } from "../shared/types.js";
import { exists } from "../shared/utils.js";
import { section, style } from "../ui/format.js";
import { runVaultSecrets } from "./vault-secrets.js";

export async function runSecrets(command: CliCommand, runtime: Runtime): Promise<number | void> {
  const [action] = command.args;
  if (action === "manifest") return runSecretsManifest(command, runtime);
  if (action === "doctor") return runSecretsDoctor(command, runtime);
  if (action === "setup") {
    const project = await discoverSecretsProject(runtime.cwd, { entrypoint: typeof command.options.entrypoint === "string" ? command.options.entrypoint : undefined, requireEntrypoint: true });
    return runGuidedSecretsSetup(project, runtime, command.options);
  }
  return runVaultSecrets(command, runtime);
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
  const manifest: SecretsManifest = {
    version: 1,
    references: scanned.references,
    ...(scanned.envVars.length ? { envVars: scanned.envVars } : {}),
    ...(scanned.apiKeys.length ? { apiKeys: scanned.apiKeys } : {}),
  };
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
  runtime.out.log(`  ${style.hint(`${manifest.references.length} credential reference(s)${manifest.apiKeys?.length ? `, ${manifest.apiKeys.length} API-key requirement(s)` : ""}${manifest.envVars?.length ? `, ${manifest.envVars.length} env var(s)` : ""}.`)}`);
  for (const diagnostic of scanned.diagnostics) {
    runtime.out.log(`  ${style.warn(diagnostic.detail)}`);
  }
}

function parseManifestJson(source: string, filePath: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Unable to parse secrets manifest at ${filePath}: ${detail}`, { cause: error });
  }
}

async function runSecretsDoctor(command: CliCommand, runtime: Runtime): Promise<number> {
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
    return 1;
  }
  return 0;
}
