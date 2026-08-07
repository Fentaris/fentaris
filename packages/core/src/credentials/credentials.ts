import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { FentarisAuth, type LocalCredentials } from "../auth/auth.js";

const credentialReferenceMarker = Symbol.for("fentaris.credential.reference");
const credentialSourceMarker = Symbol.for("fentaris.credential.source");
const defaultCredentialFile = ".fentaris/credentials.enc.json";
const legacyCredentialFile = ".fentaris/auth/credentials.enc.json";
const defaultKeyEnv = "FENTARIS_AUTH_KEY";
const jsonCache = new Map<string, Promise<unknown>>();

/**
 * Logical credential reference resolved against the current subject.
 * @pk
 */
export type CredentialReference = {
  readonly [credentialReferenceMarker]: true;
  readonly reference: string;
};

/**
 * Concrete source for a credential value.
 * @pk
 */
export type CredentialSource = CredentialJsonSource | CredentialEnvSource;

/**
 * Encrypted local JSON credential source.
 * @pk
 */
export type CredentialJsonSource = {
  readonly [credentialSourceMarker]: true;
  readonly type: "json";
  readonly path: string;
  readonly file?: string;
  readonly key?: string;
  readonly keyEnv?: string;
};

/**
 * Environment variable credential source.
 * @pk
 */
export type CredentialEnvSource = {
  readonly [credentialSourceMarker]: true;
  readonly type: "env";
  readonly name: string;
};

/**
 * Credential source map declared on users, groups, or defaults.
 * @pk
 */
export type CredentialSourceMap = Record<string, CredentialSource>;

/**
 * Options for encrypted local JSON credential lookup.
 * @pk
 */
export type CredentialJsonOptions = {
  file?: string;
  key?: string;
  keyEnv?: string;
};

/**
 * Reference a credential by logical name from server configuration.
 * @pk
 */
export function credential(reference: string): CredentialReference {
  if (!reference.trim()) {
    throw new Error("Credential reference cannot be empty");
  }

  return { [credentialReferenceMarker]: true, reference };
}

/**
 * Resolve a value from the encrypted local credentials JSON.
 * @pk
 */
export function credentialJson(path: string, options: CredentialJsonOptions = {}): CredentialJsonSource {
  if (!path.trim()) {
    throw new Error("Credential JSON path cannot be empty");
  }

  return { [credentialSourceMarker]: true, type: "json", path, ...options };
}

/**
 * Resolve a value from an environment variable.
 * @pk
 */
export function credentialEnv(name: string): CredentialEnvSource {
  if (!name.trim()) {
    throw new Error("Credential env name cannot be empty");
  }

  return { [credentialSourceMarker]: true, type: "env", name };
}

export function isCredentialReference(value: unknown): value is CredentialReference {
  return Boolean(value) && typeof value === "object" && (value as CredentialReference)[credentialReferenceMarker] === true;
}

export function isCredentialSource(value: unknown): value is CredentialSource {
  return Boolean(value) && typeof value === "object" && (value as CredentialSource)[credentialSourceMarker] === true;
}

export async function resolveCredentialSource(source: CredentialSource): Promise<string> {
  if (source.type === "env") {
    const value = process.env[source.name]?.trim();
    if (!value) {
      throw new Error(`Missing credential environment variable "${source.name}"`);
    }

    return value;
  }

  const credentials = await loadEncryptedJson(source);
  const value = getPath(credentials, source.path);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing credential JSON value "${source.path}"`);
  }

  return value;
}

export async function localCredentialsFromDefaultFile(options: CredentialJsonOptions = {}): Promise<LocalCredentials> {
  const file = await resolveCredentialFile(options.file);
  const key = resolveCredentialKey(options);
  const envelope = JSON.parse(await readFile(file, "utf8")) as unknown;
  return FentarisAuth.decryptCredentials(envelope, key);
}

async function loadEncryptedJson(source: CredentialJsonSource): Promise<unknown> {
  const file = await resolveCredentialFile(source.file);
  const key = resolveCredentialKey(source);
  const cacheKey = `${file}:${key}`;
  const existing = jsonCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const loaded = readFile(file, "utf8").then((contents) => FentarisAuth.decryptCredentials(JSON.parse(contents) as unknown, key));
  jsonCache.set(cacheKey, loaded);
  return loaded;
}

async function resolveCredentialFile(configuredFile: string | undefined): Promise<string> {
  if (configuredFile) {
    return configuredFile;
  }

  if (await exists(defaultCredentialFile)) {
    return defaultCredentialFile;
  }

  return legacyCredentialFile;
}

function resolveCredentialKey(options: CredentialJsonOptions): string {
  const key = options.key ?? process.env[options.keyEnv ?? defaultKeyEnv];
  if (!key) {
    throw new Error(`Missing local credential encryption key in ${options.keyEnv ?? defaultKeyEnv}`);
  }

  return key;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function getPath(value: unknown, path: string): unknown {
  return getPathParts(value, path.split("."));
}

function getPathParts(value: unknown, parts: string[]): unknown {
  if (parts.length === 0) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const joined = parts.join(".");
  if (joined in record) {
    return record[joined];
  }

  const [head, ...tail] = parts;
  return getPathParts(record[head], tail);
}
