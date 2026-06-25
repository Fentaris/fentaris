import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FentarisAuth, type LocalCredentials } from "../auth/auth.js";
import type { SecretRef, SecretScope, SecretsBackend } from "./types.js";

const defaultCredentialsFile = "credentials.enc.json";

export type LocalSecretsBackendOptions = {
  dir: string;
  key: string | Buffer;
  credentialsFile?: string;
};

/**
 * Local encrypted secrets backend backed by credentials.enc.json.
 * @pk
 */
export class LocalSecretsBackend implements SecretsBackend {
  readonly provider = "local" as const;
  private readonly dir: string;
  private readonly key: string | Buffer;
  private readonly credentialsFile: string;

  constructor(options: LocalSecretsBackendOptions) {
    this.dir = options.dir;
    this.key = options.key;
    this.credentialsFile = options.credentialsFile ?? defaultCredentialsFile;
  }

  /**
   * Create a backend when the encrypted store may not exist yet.
   * @pk
   */
  static async open(options: LocalSecretsBackendOptions): Promise<LocalSecretsBackend> {
    await mkdir(options.dir, { recursive: true });
    return new LocalSecretsBackend(options);
  }

  async listRefs(): Promise<SecretRef[]> {
    const credentials = await this.readCredentialsOptional();
    if (!credentials) {
      return [];
    }
    return credentialsToRefs(credentials);
  }

  async has(ref: string, scope: SecretScope): Promise<boolean> {
    const credentials = await this.readCredentialsOptional();
    if (!credentials) {
      return false;
    }
    if (scope.kind === "default") {
      return Boolean(credentials.defaults[ref]);
    }
    if (scope.kind === "group") {
      return Boolean(credentials.groups[scope.id]?.[ref]);
    }
    return Boolean(credentials.users[scope.id]?.credentials[ref]);
  }

  async set(ref: string, value: string, scope: SecretScope): Promise<void> {
    const credentials = (await this.readCredentialsOptional()) ?? emptyCredentials();
    if (scope.kind === "default") {
      credentials.defaults[ref] = value;
    } else if (scope.kind === "group") {
      credentials.groups[scope.id] = { ...(credentials.groups[scope.id] ?? {}), [ref]: value };
    } else {
      const user = credentials.users[scope.id] ?? { apiKeys: [], credentials: {} };
      credentials.users[scope.id] = {
        ...user,
        credentials: { ...user.credentials, [ref]: value },
      };
    }
    await this.writeCredentials(credentials);
  }

  /**
   * Add a hashed API key for a local user identity.
   * @pk
   */
  async addUserApiKey(userId: string, apiKey: string): Promise<boolean> {
    const credentials = (await this.readCredentialsOptional()) ?? emptyCredentials();
    const user = credentials.users[userId] ?? { apiKeys: [], credentials: {} };
    if (user.apiKeys.some((candidate) => FentarisAuth.compareApiKey(candidate, apiKey))) {
      return false;
    }
    credentials.users[userId] = {
      ...user,
      apiKeys: [...user.apiKeys, FentarisAuth.hashApiKey(apiKey)],
    };
    await this.writeCredentials(credentials);
    return true;
  }

  /**
   * Remove a local user API key by matching its raw value.
   * @pk
   */
  async removeUserApiKey(userId: string, apiKey: string): Promise<boolean> {
    const credentials = await this.readCredentialsOptional();
    const user = credentials?.users[userId];
    if (!credentials || !user) {
      return false;
    }

    const apiKeys = user.apiKeys.filter((candidate) => !FentarisAuth.compareApiKey(candidate, apiKey));
    if (apiKeys.length === user.apiKeys.length) {
      return false;
    }

    if (apiKeys.length === 0 && Object.keys(user.credentials).length === 0) {
      delete credentials.users[userId];
    } else {
      credentials.users[userId] = { ...user, apiKeys };
    }
    await this.writeCredentials(credentials);
    return true;
  }

  async unset(ref: string, scope: SecretScope): Promise<boolean> {
    const credentials = await this.readCredentialsOptional();
    if (!credentials) {
      return false;
    }
    let removed = false;
    if (scope.kind === "default") {
      removed = Object.prototype.hasOwnProperty.call(credentials.defaults, ref);
      delete credentials.defaults[ref];
    } else if (scope.kind === "group") {
      if (credentials.groups[scope.id]) {
        removed = Object.prototype.hasOwnProperty.call(credentials.groups[scope.id], ref);
        delete credentials.groups[scope.id][ref];
        if (Object.keys(credentials.groups[scope.id]).length === 0) {
          delete credentials.groups[scope.id];
        }
      }
    } else {
      const user = credentials.users[scope.id];
      if (user) {
        removed = Object.prototype.hasOwnProperty.call(user.credentials, ref);
        delete user.credentials[ref];
        if (user.apiKeys.length === 0 && Object.keys(user.credentials).length === 0) {
          delete credentials.users[scope.id];
        }
      }
    }
    if (removed) {
      await this.writeCredentials(credentials);
    }
    return removed;
  }

  async initEmpty(): Promise<void> {
    await this.writeCredentials(emptyCredentials());
  }

  async credentialsExist(): Promise<boolean> {
    return fileExists(path.join(this.dir, this.credentialsFile));
  }

  private async readCredentialsOptional(): Promise<LocalCredentials | null> {
    const filePath = path.join(this.dir, this.credentialsFile);
    if (!(await fileExists(filePath))) {
      return null;
    }
    const envelope = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return FentarisAuth.decryptCredentials(envelope, this.key);
  }

  private async writeCredentials(credentials: LocalCredentials): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, this.credentialsFile);
    await writeFile(filePath, JSON.stringify(FentarisAuth.encryptCredentials(credentials, this.key), null, 2));
    if (process.platform !== "win32") {
      await chmod(filePath, 0o600);
    }
  }
}

/**
 * Convert decrypted local credentials to secret refs.
 * @pk
 */
export function credentialsToRefs(credentials: LocalCredentials): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const [ref] of Object.entries(credentials.defaults)) {
    refs.push({ ref, scope: { kind: "default" }, kind: "credential", count: 1 });
  }
  for (const [groupId, values] of Object.entries(credentials.groups)) {
    for (const [ref] of Object.entries(values)) {
      refs.push({ ref, scope: { kind: "group", id: groupId }, kind: "credential", count: 1 });
    }
  }
  for (const [userId, user] of Object.entries(credentials.users)) {
    if (user.apiKeys.length > 0) {
      refs.push({ ref: userId, scope: { kind: "user", id: userId }, kind: "apiKey", count: user.apiKeys.length });
    }
    for (const [ref] of Object.entries(user.credentials)) {
      refs.push({ ref, scope: { kind: "user", id: userId }, kind: "credential", count: 1 });
    }
  }
  return refs;
}

function emptyCredentials(): LocalCredentials {
  return { users: {}, groups: {}, defaults: {} };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
