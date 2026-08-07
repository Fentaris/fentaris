import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeSecretScope,
  manifestsEqual,
  parseManifest,
  serializeManifest,
  type SecretRef,
  type SecretsManifest,
  type SecretsManifestApiKey,
  type SecretsManifestEntry,
} from "@fentaris/core";
import type { CliOptions, ProjectDiscovery, Runtime } from "../../shared/types.js";
import { exists } from "../../shared/utils.js";
import { appendProjectEnvValues, loadProjectEnv } from "../project/env.js";
import { credentialsPath, manifestPath, openLocalSecretsBackend } from "./backend.js";
import { scanEntrypointForSecrets } from "./manifest-scan.js";

type NextAction = { description: string; command: string };
type GeneratedApiKey = { userId: string; value: string; source: "local" | "env"; env?: string };

export type SecretsSetupResult = {
  createdEncryptionKey: boolean;
  generatedApiKeys: GeneratedApiKey[];
  configured: string[];
  remaining: string[];
};

export async function runGuidedSecretsSetup(
  project: ProjectDiscovery,
  runtime: Runtime,
  options: CliOptions,
): Promise<number> {
  const entrypoint = path.join(project.root, typeof options.entrypoint === "string" ? options.entrypoint : project.config.entrypoint);
  if (!(await exists(entrypoint))) throw new Error(`Entrypoint not found: ${path.relative(project.root, entrypoint)}`);

  const scan = await scanEntrypointForSecrets(entrypoint);
  const manifest: SecretsManifest = {
    version: 1,
    references: scan.references,
    ...(scan.envVars.length ? { envVars: scan.envVars } : {}),
    ...(scan.apiKeys.length ? { apiKeys: scan.apiKeys } : {}),
  };
  const machine = options.json === true || runtime.nonInteractive === true;
  const env = await loadProjectEnv(project.root, runtime.env);
  const storeExists = await exists(credentialsPath(project));
  const targetManifest = manifestPath(project);
  const manifestExists = await exists(targetManifest);

  if (machine && storeExists && !(typeof options.key === "string" ? options.key : env.FENTARIS_AUTH_KEY)?.trim()) {
    return emitIncomplete(runtime, options, ["FENTARIS_AUTH_KEY"], [{
      description: "Restore the encryption key for the existing local credential store",
      command: "Set FENTARIS_AUTH_KEY in .env or the deployment environment",
    }]);
  }

  let stored: SecretRef[] = [];
  try {
    const backend = await openLocalSecretsBackend(project, runtime, options);
    stored = await backend.listRefs();
  } catch (error) {
    return emitFailure(runtime, options, "SECRETS_SETUP_STORE_UNAVAILABLE", error instanceof Error ? error.message : "Unable to read the local credential store.");
  }

  const missingReferences = manifest.references.filter((entry) => !referenceSatisfied(entry, stored, env));
  const missingApiKeys = (manifest.apiKeys ?? []).filter((entry) => !apiKeySatisfied(entry, stored, env));
  const unsupported = [
    ...missingReferences.filter((entry) => entry.source?.type === "manual").map((entry) => `${entry.scope}:${entry.ref}`),
    ...missingApiKeys.filter((entry) => entry.source.type === "manual").map((entry) => `apiKey:${entry.userId}`),
  ];
  const needsPrompt = missingReferences.filter((entry) => entry.source?.type !== "manual");

  const plannedLocalKeys = missingApiKeys.filter((entry) => entry.source.type === "local");
  const plannedEnvKeys = missingApiKeys.filter((entry) => entry.source.type === "env");
  const remaining = [...unsupported];
  const nextActions = nextActionsForMissing(missingReferences, missingApiKeys);
  const plannedRemaining = [
    ...needsPrompt.map(referenceLabel),
    ...plannedLocalKeys.map((entry) => `apiKey:${entry.userId}`),
    ...plannedEnvKeys.map((entry) => `env:${entry.source.type === "env" ? entry.source.name : entry.userId}`),
    ...remaining,
  ];

  if (!machine) {
    emitPlan(runtime, missingReferences, missingApiKeys, scan.diagnostics.map((entry) => entry.detail));
  }

  if (options["dry-run"] === true) {
    const result: SecretsSetupResult = {
      createdEncryptionKey: false,
      generatedApiKeys: [],
      configured: [],
      remaining: plannedRemaining,
    };
    emitResult(runtime, options, result, ["Dry run: no files were changed."], nextActions, { printGeneratedKeys: true });
    return plannedRemaining.length > 0 ? 1 : 0;
  }

  if (machine && (needsPrompt.length > 0 || remaining.length > 0)) {
    return emitIncomplete(runtime, options, [...needsPrompt.map(referenceLabel), ...remaining], nextActions);
  }
  if (remaining.length > 0) return emitIncomplete(runtime, options, remaining, nextActions);

  const credentialWork = needsPrompt.length > 0 || plannedLocalKeys.length > 0 || plannedEnvKeys.length > 0;
  if (!credentialWork) {
    if (!manifestExists) {
      if (options.yes !== true) {
        const confirmed = await confirmSetup(runtime, options, machine);
        if (confirmed !== true) return confirmed;
      }
      await writeManifest(targetManifest, manifest);
      emitResult(runtime, options, { createdEncryptionKey: false, generatedApiKeys: [], configured: [], remaining: [] }, [], [], { printGeneratedKeys: true });
      return 0;
    }
    emitResult(runtime, options, { createdEncryptionKey: false, generatedApiKeys: [], configured: [], remaining: [] }, [], [], { printGeneratedKeys: true });
    return 0;
  }

  const promptedValues = new Map<SecretsManifestEntry, string>();
  if (!machine) {
    for (const entry of needsPrompt) {
      const value = (await runtime.prompt.text(`${entry.ref} (${entry.scope})`, { secret: true })).trim();
      if (!value) {
        return emitIncomplete(runtime, options, [referenceLabel(entry)], [{
          description: `Provide a non-empty value for ${referenceLabel(entry)}`,
          command: entry.source?.type === "env"
            ? `Set ${entry.source.name} in .env or the deployment environment`
            : `fentaris secrets set ${entry.ref}${scopeFlag(entry.scope)}`,
        }]);
      }
      promptedValues.set(entry, value);
    }
  }

  if (options.yes !== true) {
    const confirmed = await confirmSetup(runtime, options, machine);
    if (confirmed !== true) return confirmed;
  }

  const generatedApiKeys: GeneratedApiKey[] = [];
  const configured: string[] = [];
  const envWrites: Record<string, string> = {};
  let createdEncryptionKey = false;
  let writeBackend: Awaited<ReturnType<typeof openLocalSecretsBackend>> | undefined;
  const human = options.json !== true;

  if (needsPrompt.some((entry) => entry.source?.type !== "env") || plannedLocalKeys.length > 0) {
    const before = env.FENTARIS_AUTH_KEY?.trim();
    writeBackend = await openLocalSecretsBackend(project, runtime, options, { createKeyIfMissing: true });
    createdEncryptionKey = !before && !(typeof options.key === "string" && options.key.trim());
    if (!(await writeBackend.credentialsExist())) await writeBackend.initEmpty();
    if (human && createdEncryptionKey) runtime.out.log("✓ Created project encryption key in .env");
  }

  for (const entry of needsPrompt) {
    const value = promptedValues.get(entry);
    if (!value) continue;
    if (entry.source?.type === "env") envWrites[entry.source.name] = value;
    else await writeBackend?.set(entry.ref, value, decodeSecretScope(entry.scope));
    configured.push(referenceLabel(entry));
    if (human) runtime.out.log(`✓ Configured ${referenceLabel(entry)}`);
  }

  for (const requirement of plannedLocalKeys) {
    const existingCount = storedApiKeyCount(stored, requirement.userId);
    for (let index = existingCount; index < (requirement.count ?? 1); index += 1) {
      const value = randomBytes(32).toString("base64url");
      await writeBackend?.addUserApiKey(requirement.userId, value);
      const generated: GeneratedApiKey = { userId: requirement.userId, value, source: "local" };
      generatedApiKeys.push(generated);
      // Print immediately after a successful store write so a later failure cannot hide the only plaintext copy.
      if (human) runtime.out.log(`✓ Generated API key for ${generated.userId}: ${generated.value}`);
    }
  }

  for (const requirement of plannedEnvKeys) {
    if (requirement.source.type !== "env") continue;
    const value = randomBytes(32).toString("base64url");
    envWrites[requirement.source.name] = value;
    generatedApiKeys.push({ userId: requirement.userId, value, source: "env", env: requirement.source.name });
  }

  await appendProjectEnvValues(project.root, envWrites);
  for (const generated of generatedApiKeys.filter((entry) => entry.source === "env")) {
    if (human) runtime.out.log(`✓ Generated API key for ${generated.userId}: ${generated.value}`);
  }

  const shouldWriteManifest = !manifestExists || !(await manifestMatches(targetManifest, manifest));
  if (shouldWriteManifest) await writeManifest(targetManifest, manifest);

  emitResult(
    runtime,
    options,
    { createdEncryptionKey, generatedApiKeys, configured, remaining: [] },
    [],
    [],
    { printGeneratedKeys: !human },
  );
  return 0;
}

async function confirmSetup(runtime: Runtime, options: CliOptions, machine: boolean): Promise<true | number> {
  if (machine) {
    return emitFailure(runtime, options, "SECRETS_SETUP_CONFIRMATION_REQUIRED", "Pass --yes to apply the generated setup plan.", [{
      description: "Apply the setup plan",
      command: "fentaris secrets setup --yes --json",
    }]);
  }
  if (!(await runtime.prompt.confirm("Apply this secrets setup plan?"))) {
    emitResult(runtime, options, { createdEncryptionKey: false, generatedApiKeys: [], configured: [], remaining: [] }, ["Setup cancelled."], [], { printGeneratedKeys: true });
    return 0;
  }
  return true;
}

async function manifestMatches(filePath: string, expected: SecretsManifest): Promise<boolean> {
  try {
    return manifestsEqual(parseManifest(JSON.parse(await readFile(filePath, "utf8")) as unknown), expected);
  } catch {
    return false;
  }
}

async function writeManifest(filePath: string, manifest: SecretsManifest): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeManifest(manifest));
}

function referenceSatisfied(entry: SecretsManifestEntry, stored: SecretRef[], env: NodeJS.ProcessEnv): boolean {
  if (entry.source?.type === "env") return Boolean(env[entry.source.name]?.trim());
  if (entry.source?.type === "manual") return false;
  const scope = decodeSecretScope(entry.scope);
  return stored.some((candidate) => candidate.kind === "credential" && candidate.ref === entry.ref
    && JSON.stringify(candidate.scope) === JSON.stringify(scope));
}

function apiKeySatisfied(entry: SecretsManifestApiKey, stored: SecretRef[], env: NodeJS.ProcessEnv): boolean {
  if (entry.source.type === "env") return Boolean(env[entry.source.name]?.trim());
  if (entry.source.type === "manual") return false;
  return storedApiKeyCount(stored, entry.userId) >= (entry.count ?? 1);
}

function storedApiKeyCount(stored: SecretRef[], userId: string): number {
  return stored.find((entry) => entry.kind === "apiKey" && entry.scope.kind === "user" && entry.scope.id === userId)?.count ?? 0;
}

function referenceLabel(entry: SecretsManifestEntry): string {
  return entry.source?.type === "env" ? `env:${entry.source.name}` : `${entry.scope}:${entry.ref}`;
}

function scopeFlag(scope: string): string {
  if (scope === "default") return "";
  if (scope.startsWith("user:")) return ` --user ${scope.slice(5)}`;
  if (scope.startsWith("group:")) return ` --group ${scope.slice(6)}`;
  return "";
}

function nextActionsForMissing(references: SecretsManifestEntry[], apiKeys: SecretsManifestApiKey[]): NextAction[] {
  const actions: NextAction[] = [];
  for (const entry of references) {
    if (entry.source?.type === "env") {
      actions.push({ description: `Provide ${entry.source.name}`, command: `Set ${entry.source.name} in .env or the deployment environment` });
    } else if (entry.source?.type !== "manual") {
      actions.push({ description: `Store ${entry.ref}`, command: `fentaris secrets set ${entry.ref}${scopeFlag(entry.scope)}` });
    }
  }
  for (const entry of apiKeys) {
    if (entry.source.type === "manual") continue;
    actions.push({ description: `Generate an API key for ${entry.userId}`, command: `fentaris auth api-key add ${entry.userId} --generate` });
  }
  return actions.slice(0, 10);
}

function emitIncomplete(runtime: Runtime, options: CliOptions, missing: string[], nextActions: NextAction[]): number {
  return emitFailure(runtime, options, "SECRETS_SETUP_INCOMPLETE", "Required external or manual credential values are unavailable.", nextActions, { missing });
}

function emitFailure(runtime: Runtime, options: CliOptions, code: string, message: string, nextActions: NextAction[] = [], details: Record<string, unknown> = {}): number {
  const envelope = { ok: false, error: { code, message, details }, warnings: [], nextActions };
  if (options.json === true) runtime.out.log(JSON.stringify(envelope, null, 2));
  else {
    runtime.out.error(`error ${code}: ${message}`);
    for (const action of nextActions) runtime.out.error(`Next: ${action.command}`);
  }
  return 1;
}

function emitResult(
  runtime: Runtime,
  options: CliOptions,
  result: SecretsSetupResult,
  warnings: string[],
  nextActions: NextAction[],
  behavior: { printGeneratedKeys: boolean },
): void {
  if (options.json === true) {
    runtime.out.log(JSON.stringify({ ok: true, data: result, pagination: null, warnings, nextActions }, null, 2));
    return;
  }
  if (behavior.printGeneratedKeys) {
    if (result.createdEncryptionKey) runtime.out.log("✓ Created project encryption key in .env");
    for (const entry of result.configured) runtime.out.log(`✓ Configured ${entry}`);
    for (const generated of result.generatedApiKeys) runtime.out.log(`✓ Generated API key for ${generated.userId}: ${generated.value}`);
  }
  if (result.configured.length === 0 && result.generatedApiKeys.length === 0 && warnings.length === 0) {
    runtime.out.log("✓ All required credentials are configured.");
  }
  for (const warning of warnings) runtime.out.log(warning);
}

function emitPlan(
  runtime: Runtime,
  references: SecretsManifestEntry[],
  apiKeys: SecretsManifestApiKey[],
  diagnostics: string[],
): void {
  runtime.out.log("Secrets setup plan:");
  if (references.length === 0 && apiKeys.length === 0 && diagnostics.length === 0) {
    runtime.out.log("  No missing credential values or API keys.");
    return;
  }
  for (const entry of references) runtime.out.log(`  Configure ${referenceLabel(entry)}`);
  for (const entry of apiKeys) runtime.out.log(`  Generate ${entry.count ?? 1} API key(s) for ${entry.userId}`);
  for (const diagnostic of diagnostics) runtime.out.log(`  Manual action required: ${diagnostic}`);
}
