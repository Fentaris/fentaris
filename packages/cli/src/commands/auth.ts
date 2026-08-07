import { randomBytes } from "node:crypto";
import path from "node:path";
import { text as readStreamText } from "node:stream/consumers";
import { resolveSubjectId } from "../domain/auth/subjects.js";
import { discoverSecretsProject } from "../domain/project/project.js";
import { credentialsPath, openLocalSecretsBackend } from "../domain/secrets/backend.js";
import { loadRequiredReferences } from "../domain/secrets/doctor.js";
import type { CliCommand, CliOptions, ProjectDiscovery, Runtime } from "../shared/types.js";
import { section, style } from "../ui/format.js";

export async function runAuth(command: CliCommand, runtime: Runtime): Promise<void> {
  const [subject, action, userId] = command.args;
  if (!subject) {
    await runAuthMenu(command, runtime);
    return;
  }
  if (subject !== "api-key") {
    throw new Error("Usage: fentaris auth api-key <add|list|remove> ...");
  }

  if (action === "add") {
    await runAuthApiKeyAdd(command, userId, runtime);
    return;
  }
  if (action === "list") {
    await runAuthApiKeyList(command, runtime);
    return;
  }
  if (action === "remove") {
    await runAuthApiKeyRemove(command, userId, runtime);
    return;
  }

  throw new Error(`Unknown auth api-key command "${action ?? ""}". Run fentaris help auth api-key.`);
}

async function runAuthMenu(command: CliCommand, runtime: Runtime): Promise<void> {
  section(runtime, "Auth setup");
  runtime.out.log(`  ${style.brand("Fentaris")} ${style.hint("local API-key management")}`);
  const action = await runtime.prompt.select("Auth action", ["Add API key", "List API keys", "Remove API key"]);

  if (action === "Add API key") {
    await runAuthApiKeyAdd(command, undefined, runtime);
  } else if (action === "List API keys") {
    await runAuthApiKeyList(command, runtime);
  } else {
    await runAuthApiKeyRemove(command, undefined, runtime, { guided: true });
  }
}

async function runAuthApiKeyAdd(command: CliCommand, userId: string | undefined, runtime: Runtime): Promise<void> {
  const project = await discoverSecretsProject(runtime.cwd);
  const resolvedUserId = await resolveAuthUserId(userId, command.options, runtime, project);
  const resolvedValue = await resolveApiKeyValue("API key", command.options, runtime, { chooseMode: true });
  const guided = !userId?.trim() || resolvedValue.prompted;

  if (guided) {
    printApiKeyReview(runtime, "add", resolvedUserId, project);
    const confirmed = await runtime.prompt.confirm("Store this API key?");
    if (!confirmed) {
      section(runtime, "Auth");
      runtime.out.log(`  ${style.warn("API key was not stored.")}`);
      return;
    }
  }

  const backend = await openLocalSecretsBackend(project, runtime, command.options, { createKeyIfMissing: true });
  if (!(await backend.credentialsExist())) {
    await backend.initEmpty();
  }
  const added = await backend.addUserApiKey(resolvedUserId, resolvedValue.value);

  section(runtime, "Auth");
  runtime.out.log(`  ${added ? style.pass(`Added API key for ${resolvedUserId}.`) : style.warn(`API key already exists for ${resolvedUserId}.`)}`);
  runtime.out.log(`  ${style.hint("Header:")} x-fentaris-api-key`);
  if (resolvedValue.generated) {
    runtime.out.log(`  ${style.hint("Generated key:")} ${resolvedValue.value}`);
    runtime.out.log(`  ${style.hint("Save it now; Fentaris stores only a hash and cannot print it again.")}`);
  } else {
    runtime.out.log(`  ${style.hint("Value: <redacted>")}`);
  }
}

async function runAuthApiKeyRemove(
  command: CliCommand,
  userId: string | undefined,
  runtime: Runtime,
  config: { guided?: boolean } = {},
): Promise<void> {
  const project = await discoverSecretsProject(runtime.cwd);
  const resolvedUserId = config.guided === true
    ? await resolveAuthUserId(userId, command.options, runtime, project)
    : requireUserId(userId);
  const { value } = await resolveApiKeyValue("API key to remove", command.options, runtime, { allowGenerate: false });

  if (config.guided === true) {
    printApiKeyReview(runtime, "remove", resolvedUserId, project);
    const confirmed = await runtime.prompt.confirm("Remove this API key?");
    if (!confirmed) {
      section(runtime, "Auth");
      runtime.out.log(`  ${style.warn("API key was not removed.")}`);
      return;
    }
  }

  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  const removed = await backend.removeUserApiKey(resolvedUserId, value);

  section(runtime, "Auth");
  runtime.out.log(`  ${removed ? style.pass(`Removed API key for ${resolvedUserId}.`) : style.warn(`No matching API key found for ${resolvedUserId}.`)}`);
  runtime.out.log(`  ${style.hint("Value: <redacted>")}`);
}

async function runAuthApiKeyList(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverSecretsProject(runtime.cwd);
  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  const refs = (await backend.listRefs()).filter((ref) => ref.kind === "apiKey");
  const filteredRefs = typeof command.options.user === "string" ? refs.filter((ref) => ref.scope.kind === "user" && ref.scope.id === command.options.user) : refs;

  if (command.options.json === true) {
    runtime.out.log(JSON.stringify(filteredRefs, null, 2));
    return;
  }

  section(runtime, "Auth API keys");
  if (filteredRefs.length === 0) {
    runtime.out.log(`  ${style.hint("No local API keys stored.")}`);
    return;
  }

  for (const ref of filteredRefs) {
    runtime.out.log(`  ${style.label(ref.ref.padEnd(20))} ${style.hint("│")} ${ref.count} key${ref.count === 1 ? "" : "s"}`);
  }
}

async function resolveApiKeyValue(
  label: string,
  options: CliOptions,
  runtime: Runtime,
  config: { allowGenerate?: boolean; chooseMode?: boolean } = {},
): Promise<{ value: string; generated: boolean; prompted: boolean }> {
  const allowGenerate = config.allowGenerate ?? true;
  const explicitInputs = [typeof options.value === "string", options["value-stdin"] === true, options.generate === true].filter(Boolean).length;
  if (explicitInputs > 1) {
    throw new Error(`Use only one of --value, --value-stdin${allowGenerate ? ", or --generate" : ""}.`);
  }
  if (options.generate === true) {
    if (!allowGenerate) {
      throw new Error("--generate is not supported for this command.");
    }
    return { value: randomBytes(32).toString("base64url"), generated: true, prompted: false };
  }
  if (typeof options.value === "string") {
    runtime.out.error("Warning: --value exposes API keys in process arguments. Prefer --value-stdin or an interactive prompt.");
    return { value: options.value, generated: false, prompted: false };
  }
  if (options["value-stdin"] === true) {
    const value = (await readStreamText(process.stdin)).replace(/\r?\n$/, "");
    if (!value) {
      throw new Error(`${label} was empty on stdin.`);
    }
    return { value, generated: false, prompted: false };
  }
  if (config.chooseMode === true) {
    const source = await runtime.prompt.select("API key source", ["Generate a new API key", "Enter an existing API key"]);
    if (source === "Generate a new API key") {
      return { value: randomBytes(32).toString("base64url"), generated: true, prompted: true };
    }
  }
  return { value: await runtime.prompt.text(label, { secret: true }), generated: false, prompted: true };
}

async function resolveAuthUserId(
  userId: string | undefined,
  options: CliOptions,
  runtime: Runtime,
  project: ProjectDiscovery,
): Promise<string> {
  if (userId?.trim()) {
    return userId.trim();
  }

  const required = await loadRequiredReferences(project);
  return requireUserId(await resolveSubjectId("user", options, runtime, project, required));
}

function printApiKeyReview(runtime: Runtime, action: "add" | "remove", userId: string, project: ProjectDiscovery): void {
  section(runtime, "Review");
  const rows = [
    ["action", action],
    ["user", userId],
    ["storage", path.relative(project.root, credentialsPath(project))],
    ["value", "<redacted>"],
  ] as const;
  for (const [label, value] of rows) {
    runtime.out.log(`  ${style.label(label.padEnd(10))} ${style.hint("│")} ${value}`);
  }
}

function requireUserId(userId: string | undefined): string {
  const resolved = userId?.trim();
  if (!resolved) {
    throw new Error("User id is required.");
  }
  return resolved;
}
