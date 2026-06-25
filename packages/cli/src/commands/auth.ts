import { randomBytes } from "node:crypto";
import { text as readStreamText } from "node:stream/consumers";
import { discoverProject } from "../domain/project/project.js";
import { openLocalSecretsBackend } from "../domain/secrets/backend.js";
import type { CliCommand, CliOptions, Runtime } from "../shared/types.js";
import { section, style } from "../ui/format.js";

export async function runAuth(command: CliCommand, runtime: Runtime): Promise<void> {
  const [subject, action, userId] = command.args;
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

async function runAuthApiKeyAdd(command: CliCommand, userId: string | undefined, runtime: Runtime): Promise<void> {
  const resolvedUserId = requireUserId(userId);
  const project = await discoverProject(runtime.cwd);
  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  if (!(await backend.credentialsExist())) {
    await backend.initEmpty();
  }

  const { value, generated } = await resolveApiKeyValue("API key", command.options, runtime);
  const added = await backend.addUserApiKey(resolvedUserId, value);

  section(runtime, "Auth");
  runtime.out.log(`  ${added ? style.pass(`Added API key for ${resolvedUserId}.`) : style.warn(`API key already exists for ${resolvedUserId}.`)}`);
  runtime.out.log(`  ${style.hint("Header:")} x-fentaris-api-key`);
  if (generated) {
    runtime.out.log(`  ${style.hint("Generated key:")} ${value}`);
    runtime.out.log(`  ${style.hint("Save it now; Fentaris stores only a hash and cannot print it again.")}`);
  } else {
    runtime.out.log(`  ${style.hint("Value: <redacted>")}`);
  }
}

async function runAuthApiKeyRemove(command: CliCommand, userId: string | undefined, runtime: Runtime): Promise<void> {
  const resolvedUserId = requireUserId(userId);
  const project = await discoverProject(runtime.cwd);
  const backend = await openLocalSecretsBackend(project, runtime, command.options);
  const { value } = await resolveApiKeyValue("API key to remove", command.options, runtime, { allowGenerate: false });
  const removed = await backend.removeUserApiKey(resolvedUserId, value);

  section(runtime, "Auth");
  runtime.out.log(`  ${removed ? style.pass(`Removed API key for ${resolvedUserId}.`) : style.warn(`No matching API key found for ${resolvedUserId}.`)}`);
  runtime.out.log(`  ${style.hint("Value: <redacted>")}`);
}

async function runAuthApiKeyList(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
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
  config: { allowGenerate?: boolean } = {},
): Promise<{ value: string; generated: boolean }> {
  const allowGenerate = config.allowGenerate ?? true;
  const explicitInputs = [typeof options.value === "string", options["value-stdin"] === true, options.generate === true].filter(Boolean).length;
  if (explicitInputs > 1) {
    throw new Error(`Use only one of --value, --value-stdin${allowGenerate ? ", or --generate" : ""}.`);
  }
  if (options.generate === true) {
    if (!allowGenerate) {
      throw new Error("--generate is not supported for this command.");
    }
    return { value: randomBytes(32).toString("base64url"), generated: true };
  }
  if (typeof options.value === "string") {
    runtime.out.error("Warning: --value exposes API keys in process arguments. Prefer --value-stdin or an interactive prompt.");
    return { value: options.value, generated: false };
  }
  if (options["value-stdin"] === true) {
    const value = (await readStreamText(process.stdin)).replace(/\r?\n$/, "");
    if (!value) {
      throw new Error(`${label} was empty on stdin.`);
    }
    return { value, generated: false };
  }
  return { value: await runtime.prompt.text(label, { secret: true }), generated: false };
}

function requireUserId(userId: string | undefined): string {
  const resolved = userId?.trim();
  if (!resolved) {
    throw new Error("User id is required.");
  }
  return resolved;
}
