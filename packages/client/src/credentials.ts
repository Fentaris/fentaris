import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configDirectory, writePrivateFile } from "./config.js";
import { ClientError } from "./errors.js";
import type { Runtime } from "./runtime.js";

export type CredentialRecord =
  | { type: "api-key"; apiKey: string }
  | { type: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: number; clientSecret?: string };

export type CredentialStore = {
  kind: "keychain" | "secret-service" | "file";
  /** Human description of where credentials are kept. */
  location: string;
  get(profile: string): Promise<CredentialRecord | undefined>;
  set(profile: string, record: CredentialRecord): Promise<void>;
  delete(profile: string): Promise<boolean>;
};

const SERVICE = "fentaris-client";

/**
 * Prefer the operating system credential store. Secrets are passed on stdin,
 * never in argv, so they do not appear in the process list.
 */
export async function openCredentialStore(runtime: Runtime): Promise<CredentialStore> {
  const forced = runtime.env.FENTARIS_CLIENT_CREDENTIAL_STORE;
  if (forced && forced !== "file" && forced !== "system") throw new ClientError("INVALID_ARGUMENTS", "FENTARIS_CLIENT_CREDENTIAL_STORE must be \"file\" or \"system\".");
  if (forced !== "file") {
    if (runtime.platform === "darwin" && (await runtime.exec("security", ["help"])).code !== 127) return keychainStore(runtime);
    if (runtime.platform === "linux" && runtime.env.DBUS_SESSION_BUS_ADDRESS && (await runtime.exec("secret-tool", ["--version"])).code !== 127) return secretServiceStore(runtime);
  }
  return fileStore(runtime);
}

function keychainStore(runtime: Runtime): CredentialStore {
  return {
    kind: "keychain",
    location: "macOS Keychain (service \"fentaris-client\")",
    async get(profile) {
      const result = await runtime.exec("security", ["find-generic-password", "-s", SERVICE, "-a", profile, "-w"]);
      if (result.code !== 0) return undefined;
      return decode(result.stdout.trim());
    },
    async set(profile, record) {
      // `security -i` reads commands from stdin; base64 keeps the value free of quoting characters.
      const result = await runtime.exec("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${profile} -w ${encode(record)}\n`);
      const stored = await this.get(profile);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(record)) throw new ClientError("INTERNAL_ERROR", `Cannot write credentials to the macOS Keychain${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}. Set FENTARIS_CLIENT_CREDENTIAL_STORE=file to use an owner-only file instead.`);
    },
    async delete(profile) {
      return (await runtime.exec("security", ["delete-generic-password", "-s", SERVICE, "-a", profile])).code === 0;
    },
  };
}

function secretServiceStore(runtime: Runtime): CredentialStore {
  const attributes = (profile: string) => ["service", SERVICE, "account", profile];
  return {
    kind: "secret-service",
    location: "Secret Service keyring (service \"fentaris-client\")",
    async get(profile) {
      const result = await runtime.exec("secret-tool", ["lookup", ...attributes(profile)]);
      return result.code === 0 && result.stdout.trim() ? decode(result.stdout.trim()) : undefined;
    },
    async set(profile, record) {
      const result = await runtime.exec("secret-tool", ["store", `--label=Fentaris client (${profile})`, ...attributes(profile)], encode(record));
      if (result.code !== 0) throw new ClientError("INTERNAL_ERROR", `Cannot write credentials to the Secret Service keyring: ${result.stderr.trim() || `exit ${result.code}`}. Set FENTARIS_CLIENT_CREDENTIAL_STORE=file to use an owner-only file instead.`);
    },
    async delete(profile) {
      const existed = Boolean(await this.get(profile));
      await runtime.exec("secret-tool", ["clear", ...attributes(profile)]);
      return existed;
    },
  };
}

function fileStore(runtime: Runtime): CredentialStore {
  const path = join(configDirectory(runtime), "credentials.json");
  const read = async (): Promise<Record<string, CredentialRecord>> => {
    try { return JSON.parse(await readFile(path, "utf8")) as Record<string, CredentialRecord>; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new ClientError("INTERNAL_ERROR", `Cannot read ${path}: ${(error as Error).message}.`);
    }
  };
  return {
    kind: "file",
    location: path,
    async get(profile) { return (await read())[profile]; },
    async set(profile, record) { const all = await read(); all[profile] = record; await writePrivateFile(path, `${JSON.stringify(all, null, 2)}\n`); },
    async delete(profile) {
      const all = await read();
      if (!(profile in all)) return false;
      delete all[profile];
      await writePrivateFile(path, `${JSON.stringify(all, null, 2)}\n`);
      return true;
    },
  };
}

function encode(record: CredentialRecord): string {
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64");
}

function decode(value: string): CredentialRecord | undefined {
  try { return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as CredentialRecord; } catch { return undefined; }
}
