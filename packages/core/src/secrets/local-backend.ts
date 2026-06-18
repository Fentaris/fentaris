import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

  async unset(ref: string, scope: SecretScope): Promise<void> {
    const credentials = await this.readCredentialsOptional();
    if (!credentials) {
      return;
    }
    if (scope.kind === "default") {
      delete credentials.defaults[ref];
    } else if (scope.kind === "group") {
      if (credentials.groups[scope.id]) {
        delete credentials.groups[scope.id][ref];
        if (Object.keys(credentials.groups[scope.id]).length === 0) {
          delete credentials.groups[scope.id];
        }
      }
    } else {
      const user = credentials.users[scope.id];
      if (user) {
        delete user.credentials[ref];
        if (user.apiKeys.length === 0 && Object.keys(user.credentials).length === 0) {
          delete credentials.users[scope.id];
        }
      }
    }
    await this.writeCredentials(credentials);
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
