import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
    return credentialsToRefs(credentials).filter((entry) => !entry.ref.startsWith("fentaris.internal.oauth."));
  }

  /** Internal resolution; never return values from administrative inventory. @pk */
  async resolve(ref: string, scope: SecretScope = { kind: "default" }): Promise<string | undefined> {
    const credentials = await this.readCredentialsOptional();
    if (scope.kind === "default") return credentials?.defaults[ref];
    if (scope.kind === "group") return credentials?.groups[scope.id]?.[ref];
    return credentials?.users[scope.id]?.credentials[ref];
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
    if (ref.startsWith("fentaris.internal.oauth.")) throw new Error("OAuth lifecycle references are managed by MCP authentication, not ordinary secrets.");
    return this.withCredentialsLock(() => this.setLocked(ref, value, scope));
  }

  /** Internal lifecycle write; ordinary secret commands cannot overwrite OAuth state. @internal */
  async setInternal(ref: string, value: string): Promise<void> {
    if (!ref.startsWith("fentaris.internal.oauth.")) throw new Error("Expected an internal OAuth lifecycle reference.");
    return this.withCredentialsLock(() => this.setLocked(ref, value, { kind: "default" }));
  }

  private async setLocked(ref: string, value: string, scope: SecretScope): Promise<void> {
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
    return this.withCredentialsLock(() => this.addUserApiKeyLocked(userId, apiKey));
  }

  private async addUserApiKeyLocked(userId: string, apiKey: string): Promise<boolean> {
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
    return this.withCredentialsLock(() => this.removeUserApiKeyLocked(userId, apiKey));
  }

  private async removeUserApiKeyLocked(userId: string, apiKey: string): Promise<boolean> {
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
    if (ref.startsWith("fentaris.internal.oauth.")) throw new Error("Disconnect the selected MCP account to clear OAuth lifecycle state.");
    return this.withCredentialsLock(() => this.unsetLocked(ref, scope));
  }

  private async unsetLocked(ref: string, scope: SecretScope): Promise<boolean> {
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
    return this.withCredentialsLock(() => this.initEmptyLocked());
  }

  private async initEmptyLocked(): Promise<void> {
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

  private async withCredentialsLock<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${this.credentialsFile}.lock`);
    const started = Date.now();
    let handle;
    while (!handle) {
      try { handle = await import("node:fs/promises").then((fs) => fs.open(file, "wx", 0o600)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await stat(file).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
        if (age > 15000) { await unlink(file).catch(() => undefined); continue; }
        if (Date.now() - started > 5000) throw new Error("Timed out acquiring the project credentials lock.", { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try { return await run(); }
    finally { await handle.close(); await unlink(file).catch(() => undefined); }
  }

  private async writeCredentials(credentials: LocalCredentials): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, this.credentialsFile);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(FentarisAuth.encryptCredentials(credentials, this.key), null, 2), { mode: 0o600 });
      await rename(temporary, filePath);
    } finally { await unlink(temporary).catch(() => undefined); }
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
