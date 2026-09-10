import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { decryptEnvelope, encryptedEnvelopeSchema, encryptEnvelope, parseWithError } from "../envelope.js";

const defaultOAuthTokensFile = "oauth-tokens.enc.json";
const defaultKeyEnv = "FENTARIS_AUTH_KEY";
const lockRetryDelayMs = 10;
const lockTimeoutMs = 5_000;
const lockStaleMs = 15_000;

/**
 * Authorization session an OAuth record belongs to.
 * @pk
 */
export type OAuthSessionKey = `user:${string}` | "shared";

/**
 * Stored OAuth tokens with the time they were obtained.
 * @pk
 */
export type StoredOAuthTokens = OAuthTokens & {
  obtainedAt: number;
  /** Client the tokens were issued to, so a refresh reuses that exact registration. @pk */
  clientId?: string;
};

/**
 * Persisted OAuth state for one upstream server and authorization session.
 * @pk
 */
export type OAuthStoreRecord = {
  /** Most recently used client registration. @pk */
  clientInformation?: OAuthClientInformationFull;
  /**
   * Every dynamic registration made for this session, keyed by redirect URI, so a
   * registration made by one process (for example the CLI loopback redirect) is not
   * discarded by another that uses a different callback.
   * @pk
   */
  clientRegistrations?: Record<string, OAuthClientInformationFull>;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  updatedAt: number;
};

/**
 * Redacted summary of a stored OAuth record.
 * @pk
 */
export type OAuthStoreEntry = {
  server: string;
  session: OAuthSessionKey;
  hasTokens: boolean;
  hasClientInformation: boolean;
  expiresAt?: number;
  updatedAt: number;
};

/**
 * Pluggable persistence contract for OAuth client registrations, tokens, and discovery state.
 * @pk
 */
export type OAuthTokenStore = {
  get(server: string, session: OAuthSessionKey): Promise<OAuthStoreRecord | undefined>;
  set(server: string, session: OAuthSessionKey, record: OAuthStoreRecord): Promise<void>;
  delete(server: string, session: OAuthSessionKey): Promise<void>;
  list(): Promise<OAuthStoreEntry[]>;
  /**
   * Read-modify-write one record atomically. Implement it whenever concurrent writers
   * are possible; {@link updateOAuthRecord} falls back to get-then-set otherwise.
   * @pk
   */
  update?(
    server: string,
    session: OAuthSessionKey,
    mutate: (record: OAuthStoreRecord) => OAuthStoreRecord,
  ): Promise<OAuthStoreRecord>;
};

/**
 * Apply a read-modify-write to one record, atomically when the store supports it.
 * @pk
 */
export async function updateOAuthRecord(
  store: OAuthTokenStore,
  server: string,
  session: OAuthSessionKey,
  mutate: (record: OAuthStoreRecord) => OAuthStoreRecord,
): Promise<OAuthStoreRecord> {
  if (store.update) {
    return store.update(server, session, mutate);
  }

  const current = (await store.get(server, session)) ?? { updatedAt: 0 };
  const next = { ...mutate(current), updatedAt: Date.now() };
  await store.set(server, session, next);
  return next;
}

type StoreState = Record<string, Record<string, OAuthStoreRecord>>;

/**
 * Compute the expiry timestamp of stored tokens, when known.
 * @pk
 */
export function oauthTokensExpireAt(tokens: StoredOAuthTokens | undefined): number | undefined {
  if (!tokens || typeof tokens.expires_in !== "number") {
    return undefined;
  }

  return tokens.obtainedAt + tokens.expires_in * 1000;
}

/**
 * In-memory OAuth token store; authorizations do not survive the process.
 * @pk
 */
export class MemoryOAuthTokenStore implements OAuthTokenStore {
  private readonly state: StoreState = {};

  async get(server: string, session: OAuthSessionKey): Promise<OAuthStoreRecord | undefined> {
    return this.state[server]?.[session];
  }

  async set(server: string, session: OAuthSessionKey, record: OAuthStoreRecord): Promise<void> {
    this.state[server] = { ...(this.state[server] ?? {}), [session]: { ...record, updatedAt: record.updatedAt || Date.now() } };
  }

  async update(
    server: string,
    session: OAuthSessionKey,
    mutate: (record: OAuthStoreRecord) => OAuthStoreRecord,
  ): Promise<OAuthStoreRecord> {
    const next = { ...mutate(this.state[server]?.[session] ?? { updatedAt: 0 }), updatedAt: Date.now() };
    this.state[server] = { ...(this.state[server] ?? {}), [session]: next };
    return next;
  }

  async delete(server: string, session: OAuthSessionKey): Promise<void> {
    const sessions = this.state[server];
    if (!sessions) {
      return;
    }

    delete sessions[session];
    if (Object.keys(sessions).length === 0) {
      delete this.state[server];
    }
  }

  async list(): Promise<OAuthStoreEntry[]> {
    return listEntries(this.state);
  }
}

/**
 * Options for the encrypted local OAuth token store.
 * @pk
 */
export type LocalOAuthTokenStoreOptions = {
  dir: string;
  key?: string | Buffer;
  keyEnv?: string;
  file?: string;
};

/**
 * Encrypted local OAuth token store backed by `<dir>/oauth-tokens.enc.json`.
 * @pk
 */
export class LocalOAuthTokenStore implements OAuthTokenStore {
  readonly filePath: string;
  private readonly key: string | Buffer;
  private cache: StoreState = {};
  private cacheStamp: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LocalOAuthTokenStoreOptions) {
    const key = options.key ?? process.env[options.keyEnv ?? defaultKeyEnv];
    if (!key) {
      throw new Error(`OAuth token store requires an encryption key (set ${options.keyEnv ?? defaultKeyEnv} or pass key)`);
    }

    this.key = key;
    this.filePath = path.join(options.dir, options.file ?? defaultOAuthTokensFile);
  }

  async get(server: string, session: OAuthSessionKey): Promise<OAuthStoreRecord | undefined> {
    const state = await this.read();
    return state[server]?.[session];
  }

  async set(server: string, session: OAuthSessionKey, record: OAuthStoreRecord): Promise<void> {
    await this.mutate((state) => {
      state[server] = { ...(state[server] ?? {}), [session]: { ...record, updatedAt: record.updatedAt || Date.now() } };
    });
  }

  async update(
    server: string,
    session: OAuthSessionKey,
    mutate: (record: OAuthStoreRecord) => OAuthStoreRecord,
  ): Promise<OAuthStoreRecord> {
    let written: OAuthStoreRecord = { updatedAt: 0 };
    // The whole read-modify-write runs inside the cross-process lock, so a concurrent
    // writer cannot clobber fields it never read.
    await this.mutate((state) => {
      written = { ...mutate(state[server]?.[session] ?? { updatedAt: 0 }), updatedAt: Date.now() };
      state[server] = { ...(state[server] ?? {}), [session]: written };
    });
    return written;
  }

  async delete(server: string, session: OAuthSessionKey): Promise<void> {
    await this.mutate((state) => {
      const sessions = state[server];
      if (!sessions) {
        return;
      }

      delete sessions[session];
      if (Object.keys(sessions).length === 0) {
        delete state[server];
      }
    });
  }

  async list(): Promise<OAuthStoreEntry[]> {
    return listEntries(await this.read());
  }

  private async read(): Promise<StoreState> {
    const stamp = await this.currentStamp();
    if (stamp === null) {
      this.cache = {};
      this.cacheStamp = null;
      return this.cache;
    }

    if (this.cacheStamp === stamp) {
      return this.cache;
    }

    this.cache = await this.readFromDisk();
    this.cacheStamp = stamp;
    return this.cache;
  }

  private async readFromDisk(): Promise<StoreState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return {};
      }

      throw new Error(`Unable to read OAuth token store at ${this.filePath}`, { cause: error });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`OAuth token store at ${this.filePath} is not valid JSON`);
    }

    const envelope = parseWithError(encryptedEnvelopeSchema, parsedJson, `Invalid OAuth token store file at ${this.filePath}`);
    const decrypted = decryptEnvelope(envelope, this.key, `Unable to decrypt OAuth token store at ${this.filePath} with the provided key`);
    return normalizeState(decrypted);
  }

  private async mutate(apply: (state: StoreState) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      // Cross-process lock, then re-read and merge so a concurrent writer's records are never dropped.
      await this.withLock(async () => {
        const state = await this.readFromDisk();
        apply(state);
        await this.writeToDisk(state);
      });
    });

    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async writeToDisk(state: StoreState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(encryptEnvelope(state, this.key), null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error: unknown) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }

    this.cache = state;
    this.cacheStamp = await this.currentStamp();
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + lockTimeoutMs;

    for (;;) {
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
        break;
      } catch (error: unknown) {
        if (!isEexist(error)) {
          throw error;
        }

        if (await isStaleLock(lockPath)) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }

        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the OAuth token store lock at ${lockPath}`, { cause: error });
        }

        await delay(lockRetryDelayMs);
      }
    }

    try {
      return await run();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async currentStamp(): Promise<string | null> {
    try {
      const stats = await stat(this.filePath);
      return `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return null;
      }

      throw error;
    }
  }
}

/**
 * Built-in OAuth token store factories.
 * @pk
 */
export const oauthTokens = {
  /**
   * Encrypted local file store sharing the credentials-store key.
   * @pk
   */
  local(options: LocalOAuthTokenStoreOptions): LocalOAuthTokenStore {
    return new LocalOAuthTokenStore(options);
  },
  /**
   * Ephemeral in-memory store.
   * @pk
   */
  memory(): MemoryOAuthTokenStore {
    return new MemoryOAuthTokenStore();
  },
};

function listEntries(state: StoreState): OAuthStoreEntry[] {
  return Object.entries(state).flatMap(([server, sessions]) =>
    Object.entries(sessions).map(([session, record]) => ({
      server,
      session: session as OAuthSessionKey,
      hasTokens: Boolean(record.tokens?.access_token),
      hasClientInformation: Boolean(record.clientInformation),
      expiresAt: oauthTokensExpireAt(record.tokens),
      updatedAt: record.updatedAt,
    })),
  );
}

function normalizeState(value: unknown): StoreState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const state: StoreState = {};
  for (const [server, sessions] of Object.entries(value as Record<string, unknown>)) {
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
      continue;
    }

    const records: Record<string, OAuthStoreRecord> = {};
    for (const [session, record] of Object.entries(sessions as Record<string, unknown>)) {
      if (record && typeof record === "object" && !Array.isArray(record)) {
        const typed = record as OAuthStoreRecord;
        records[session] = { ...typed, updatedAt: typeof typed.updatedAt === "number" ? typed.updatedAt : 0 };
      }
    }

    if (Object.keys(records).length > 0) {
      state[server] = records;
    }
  }

  return state;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > lockStaleMs;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
