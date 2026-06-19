import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalSecretsBackend } from "@fentaris/core";
import type { CliOptions, Runtime } from "../../shared/types.js";
import { readJson } from "../../shared/utils.js";

export async function storeCredential(dir: string, key: string, reference: string, value: string, options: CliOptions): Promise<void> {
  const backend = await openBackend(dir, key);
  if (!(await backend.credentialsExist())) {
    await backend.initEmpty();
  }
  if (typeof options.user === "string" && typeof options.group === "string") {
    throw new Error("Use either --user or --group, not both.");
  }
  if (typeof options.user === "string") {
    await backend.set(reference, value, { kind: "user", id: options.user });
    return;
  }
  if (typeof options.group === "string") {
    await backend.set(reference, value, { kind: "group", id: options.group });
    return;
  }
  await backend.set(reference, value, { kind: "default" });
}

export async function unsetCredential(dir: string, key: string, reference: string, options: CliOptions): Promise<void> {
  const backend = await openBackend(dir, key);
  if (typeof options.user === "string" && typeof options.group === "string") {
    throw new Error("Use either --user or --group, not both.");
  }
  if (typeof options.user === "string") {
    await backend.unset(reference, { kind: "user", id: options.user });
    return;
  }
  if (typeof options.group === "string") {
    await backend.unset(reference, { kind: "group", id: options.group });
    return;
  }
  await backend.unset(reference, { kind: "default" });
}

export async function authKeyFromRuntime(runtime: Runtime, options: CliOptions): Promise<string> {
  if (typeof options.key === "string") {
    return options.key;
  }
  if (typeof runtime.env.FENTARIS_AUTH_KEY === "string" && runtime.env.FENTARIS_AUTH_KEY.trim()) {
    return runtime.env.FENTARIS_AUTH_KEY;
  }
  return runtime.prompt.text("Local auth encryption key", { secret: true });
}

export function secretScope(options: CliOptions): string {
  if (typeof options.user === "string") {
    return `user ${options.user}`;
  }
  if (typeof options.group === "string") {
    return `group ${options.group}`;
  }
  return "default";
}

export async function readCredentials(dir: string, key: string) {
  const { FentarisAuth } = await import("@fentaris/core");
  return FentarisAuth.decryptCredentials(await readJson(path.join(dir, "credentials.enc.json")), key);
}

export async function writeCredentials(dir: string, key: string, credentials: Awaited<ReturnType<typeof readCredentials>>): Promise<void> {
  const { FentarisAuth } = await import("@fentaris/core");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "credentials.enc.json"), JSON.stringify(FentarisAuth.encryptCredentials(credentials, key), null, 2));
}

async function openBackend(dir: string, key: string): Promise<LocalSecretsBackend> {
  await mkdir(dir, { recursive: true });
  return LocalSecretsBackend.open({ dir, key });
}
