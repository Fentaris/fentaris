/**
 * Versioned local Edge control-plane authority schema and atomic file-backed
 * store with owner-only permissions, process locking, and secret protection.
 * @pk
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import type { EdgeAuthorizationSession, EdgeEnrolledDeviceAuthority } from "./integratedServices.js";
import type { EdgeDesiredAssignmentSnapshot } from "./integratedServices.js";
import type { EdgeAdapterDiagnostics } from "./inventory.js";
import { edgeError } from "./errors.js";

/** Current local authority schema version. @pk */
export const EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION = 1 as const;

/** Diagnostics for the single-process local authority store. @pk */
export const LOCAL_EDGE_AUTHORITY_ADAPTER_DIAGNOSTICS: EdgeAdapterDiagnostics = Object.freeze({
  adapter: "local-file-authority",
  durable: true,
  multiInstance: false,
  productionReady: false,
  warnings: Object.freeze([
    "Local Edge authority state is single-process and not suitable for multi-instance managed deployments.",
  ]),
});

/** Server identity persisted for the local control plane. @pk */
export type EdgeLocalServerIdentity = {
  readonly serverId: string;
  readonly createdAt: number;
  readonly encryptedSigningKey: EdgeEncryptedBlob;
};

/** Hashed refresh credential bound to a device. @pk */
export type EdgeLocalRefreshCredential = {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly subjectId: string;
  readonly refreshTokenHash: string;
  readonly expiresAt: number;
  readonly rotatedAt: number;
};

/** Durable local authority document. Secrets are hashed or encrypted at rest. @pk */
export type EdgeLocalAuthorityDocument = {
  readonly schemaVersion: typeof EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION;
  readonly server: EdgeLocalServerIdentity;
  readonly authorizationSessions: readonly EdgeAuthorizationSession[];
  readonly refreshCredentials: readonly EdgeLocalRefreshCredential[];
  readonly enrolledDevices: readonly EdgeEnrolledDeviceAuthority[];
  readonly desiredAssignments: readonly EdgeDesiredAssignmentSnapshot[];
  /** Persisted hello nonces used for restart-safe replay rejection. @pk */
  readonly usedHelloNonces: readonly EdgeUsedHelloNonce[];
  readonly inventory: Readonly<Record<string, unknown>>;
  readonly updatedAt: number;
};

/** Persisted hello nonce record. @pk */
export type EdgeUsedHelloNonce = {
  readonly nonceHash: string;
  readonly seenAt: number;
};

/** AES-GCM encrypted blob stored under the protected auth boundary. @pk */
export type EdgeEncryptedBlob = {
  readonly algorithm: "aes-256-gcm";
  readonly kdf: {
    readonly name: "pbkdf2-sha256";
    readonly iterations: number;
    readonly salt: string;
    readonly keyLength: 32;
  };
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
};

export type EdgeLocalAuthorityStoreOptions = {
  readonly directory: string;
  readonly protectionKey: string | Buffer;
  readonly now?: () => number;
  readonly lockTimeoutMs?: number;
};

/**
 * Atomic owner-only file-backed local authority store.
 * Not safe for multi-instance writers; acquires an exclusive process lock.
 * @pk
 */
export class EdgeLocalAuthorityStore {
  readonly diagnostics = LOCAL_EDGE_AUTHORITY_ADAPTER_DIAGNOSTICS;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private lockHandle?: FileHandle;
  private document?: EdgeLocalAuthorityDocument;
  private closed = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: EdgeLocalAuthorityStoreOptions) {
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  get directory(): string {
    return this.options.directory;
  }

  get statePath(): string {
    return path.join(this.options.directory, "authority.json");
  }

  get lockPath(): string {
    return path.join(this.options.directory, "authority.lock");
  }

  async open(): Promise<EdgeLocalAuthorityDocument> {
    if (this.closed) {
      throw edgeError("EDGE_PROTOCOL", "Local Edge authority store is closed.");
    }
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await this.ensureOwnerOnlyDirectory();
    await this.acquireLock();
    this.document = await this.readOrInitialize();
    return this.snapshot();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.document = undefined;
    const handle = this.lockHandle;
    this.lockHandle = undefined;
    if (handle) {
      await handle.close().catch(() => undefined);
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }

  snapshot(): EdgeLocalAuthorityDocument {
    this.requireOpen();
    return structuredClone(this.document!);
  }

  async getSessionByUserCode(userCode: string): Promise<EdgeAuthorizationSession | undefined> {
    const userCodeHash = hashSecret(normalizeUserCode(userCode));
    return this.snapshot().authorizationSessions.find((session) => session.userCodeHash === userCodeHash);
  }

  async getSessionByDeviceCodeHash(deviceCodeHash: string): Promise<EdgeAuthorizationSession | undefined> {
    return this.snapshot().authorizationSessions.find((session) => session.deviceCodeHash === deviceCodeHash);
  }

  async putAuthorizationSession(session: EdgeAuthorizationSession): Promise<void> {
    await this.mutate((document) => {
      const next = document.authorizationSessions.filter((entry) => entry.deviceCodeHash !== session.deviceCodeHash);
      return {
        ...document,
        authorizationSessions: Object.freeze([...next, freezeSession(session)]),
      };
    });
  }

  /**
   * Atomically update a session when its current status is one of `expectedStatuses`.
   * Returns undefined when the session is missing or the status no longer matches.
   * @pk
   */
  async compareAndSwapAuthorizationSession(
    deviceCodeHash: string,
    expectedStatuses: readonly EdgeAuthorizationSession["status"][],
    update: (session: EdgeAuthorizationSession) => EdgeAuthorizationSession,
  ): Promise<EdgeAuthorizationSession | undefined> {
    let updated: EdgeAuthorizationSession | undefined;
    await this.mutate((document) => {
      const current = document.authorizationSessions.find((entry) => entry.deviceCodeHash === deviceCodeHash);
      if (!current || !expectedStatuses.includes(current.status)) {
        updated = undefined;
        return document;
      }
      updated = freezeSession(update(current));
      return {
        ...document,
        authorizationSessions: Object.freeze([
          ...document.authorizationSessions.filter((entry) => entry.deviceCodeHash !== deviceCodeHash),
          updated,
        ]),
      };
    });
    return updated;
  }

  /**
   * Atomically consume an approved session for one-time token issuance.
   * @pk
   */
  async consumeApprovedSession(
    deviceCodeHash: string,
    clientId: string,
  ): Promise<EdgeAuthorizationSession | undefined> {
    let approved: EdgeAuthorizationSession | undefined;
    await this.mutate((document) => {
      const current = document.authorizationSessions.find((entry) => entry.deviceCodeHash === deviceCodeHash);
      if (!current || current.clientId !== clientId || current.status !== "approved" || !current.subjectId) {
        approved = undefined;
        return document;
      }
      approved = freezeSession(current);
      return {
        ...document,
        authorizationSessions: Object.freeze([
          ...document.authorizationSessions.filter((entry) => entry.deviceCodeHash !== deviceCodeHash),
          freezeSession({
            ...current,
            pollAttempts: current.pollAttempts + 1,
            status: "consumed",
          }),
        ]),
      };
    });
    return approved;
  }

  /** Drop terminal authorization sessions whose TTL has elapsed. @pk */
  async pruneAuthorizationSessions(now = this.now()): Promise<void> {
    await this.mutate((document) => {
      const next = document.authorizationSessions.filter((session) => {
        if (session.status === "pending" || session.status === "approved") {
          return session.expiresAt > now;
        }
        // Keep denied/consumed/expired briefly for idempotent poll answers, then drop.
        return session.expiresAt > now - 5 * 60_000;
      });
      if (next.length === document.authorizationSessions.length) {
        return document;
      }
      return {
        ...document,
        authorizationSessions: Object.freeze(next.map(freezeSession)),
      };
    });
  }

  /** Persist a hello nonce after successful authentication; returns false on replay. @pk */
  async rememberHelloNonce(nonce: string, ttlMs = 10 * 60_000): Promise<boolean> {
    const nonceHash = hashSecret(nonce);
    const now = this.now();
    let accepted = false;
    await this.mutate((document) => {
      const retained = document.usedHelloNonces.filter((entry) => now - entry.seenAt <= ttlMs);
      if (retained.some((entry) => timingSafeEqualStrings(entry.nonceHash, nonceHash))) {
        accepted = false;
        return {
          ...document,
          usedHelloNonces: Object.freeze(retained),
        };
      }
      accepted = true;
      return {
        ...document,
        usedHelloNonces: Object.freeze([
          ...retained,
          Object.freeze({ nonceHash, seenAt: now }),
        ]),
      };
    });
    return accepted;
  }

  /** Atomically advance an enrolled device connection generation after hello auth. @pk */
  async advanceEnrolledConnectionGeneration(
    tenantId: string,
    edgeNodeId: string,
  ): Promise<EdgeEnrolledDeviceAuthority | undefined> {
    let advanced: EdgeEnrolledDeviceAuthority | undefined;
    await this.mutate((document) => {
      const current = document.enrolledDevices.find(
        (entry) => entry.tenantId === tenantId && entry.edgeNodeId === edgeNodeId,
      );
      if (!current || current.revoked) {
        advanced = undefined;
        return document;
      }
      advanced = Object.freeze({
        ...current,
        connectionGeneration: current.connectionGeneration + 1,
      });
      return {
        ...document,
        enrolledDevices: Object.freeze([
          ...document.enrolledDevices.filter(
            (entry) => !(entry.tenantId === tenantId && entry.edgeNodeId === edgeNodeId),
          ),
          advanced,
        ]),
      };
    });
    return advanced;
  }

  async putRefreshCredential(credential: EdgeLocalRefreshCredential): Promise<void> {
    await this.mutate((document) => {
      const next = document.refreshCredentials.filter(
        (entry) => !(entry.tenantId === credential.tenantId && entry.edgeNodeId === credential.edgeNodeId),
      );
      return {
        ...document,
        refreshCredentials: Object.freeze([...next, Object.freeze({ ...credential })]),
      };
    });
  }

  async consumeRefreshCredential(
    refreshToken: string,
  ): Promise<EdgeLocalRefreshCredential | undefined> {
    const hash = hashSecret(refreshToken);
    let matched: EdgeLocalRefreshCredential | undefined;
    await this.mutate((document) => {
      const remaining: EdgeLocalRefreshCredential[] = [];
      for (const entry of document.refreshCredentials) {
        if (!matched && timingSafeEqualStrings(entry.refreshTokenHash, hash) && entry.expiresAt > this.now()) {
          matched = entry;
          continue;
        }
        remaining.push(entry);
      }
      return {
        ...document,
        refreshCredentials: Object.freeze(remaining),
      };
    });
    return matched;
  }

  async putEnrolledDevice(device: EdgeEnrolledDeviceAuthority): Promise<void> {
    await this.mutate((document) => {
      const next = document.enrolledDevices.filter(
        (entry) => !(entry.tenantId === device.tenantId && entry.edgeNodeId === device.edgeNodeId),
      );
      return {
        ...document,
        enrolledDevices: Object.freeze([...next, Object.freeze({ ...device })]),
      };
    });
  }

  async getEnrolledDevice(tenantId: string, edgeNodeId: string): Promise<EdgeEnrolledDeviceAuthority | undefined> {
    return this.snapshot().enrolledDevices.find(
      (entry) => entry.tenantId === tenantId && entry.edgeNodeId === edgeNodeId,
    );
  }

  async revokeDevice(tenantId: string, edgeNodeId: string, revokedAt = this.now()): Promise<EdgeEnrolledDeviceAuthority | undefined> {
    let revoked: EdgeEnrolledDeviceAuthority | undefined;
    await this.mutate((document) => {
      const enrolledDevices = document.enrolledDevices.map((entry) => {
        if (entry.tenantId !== tenantId || entry.edgeNodeId !== edgeNodeId) {
          return entry;
        }
        revoked = Object.freeze({
          ...entry,
          revoked: true,
          revokedAt,
          connectionGeneration: entry.connectionGeneration + 1,
        });
        return revoked;
      });
      return {
        ...document,
        enrolledDevices: Object.freeze(enrolledDevices),
        refreshCredentials: Object.freeze(
          document.refreshCredentials.filter(
            (entry) => !(entry.tenantId === tenantId && entry.edgeNodeId === edgeNodeId),
          ),
        ),
        desiredAssignments: Object.freeze(
          document.desiredAssignments.filter(
            (entry) => !(entry.tenantId === tenantId && entry.edgeNodeId === edgeNodeId),
          ),
        ),
      };
    });
    return revoked;
  }

  async putDesiredAssignment(snapshot: EdgeDesiredAssignmentSnapshot, expectedVersion: number | undefined): Promise<"updated" | "unchanged" | "conflict"> {
    let result: "updated" | "unchanged" | "conflict" = "updated";
    await this.mutate((document) => {
      const current = document.desiredAssignments.find(
        (entry) => entry.tenantId === snapshot.tenantId && entry.edgeNodeId === snapshot.edgeNodeId,
      );
      if (current?.digest === snapshot.digest && current.version === snapshot.version) {
        result = "unchanged";
        return document;
      }
      if ((current?.version ?? undefined) !== expectedVersion) {
        result = "conflict";
        return document;
      }
      const next = document.desiredAssignments.filter(
        (entry) => !(entry.tenantId === snapshot.tenantId && entry.edgeNodeId === snapshot.edgeNodeId),
      );
      return {
        ...document,
        desiredAssignments: Object.freeze([...next, Object.freeze({ ...snapshot })]),
      };
    });
    return result;
  }

  async removeDesiredAssignment(tenantId: string, edgeNodeId: string): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      desiredAssignments: Object.freeze(document.desiredAssignments.filter(
        (entry) => !(entry.tenantId === tenantId && entry.edgeNodeId === edgeNodeId),
      )),
    }));
  }

  decryptSigningKey(): Buffer {
    this.requireOpen();
    return decryptBlob(this.document!.server.encryptedSigningKey, this.options.protectionKey);
  }

  private async mutate(
    update: (document: EdgeLocalAuthorityDocument) => EdgeLocalAuthorityDocument,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      this.requireOpen();
      const next = update(this.document!);
      const stamped: EdgeLocalAuthorityDocument = {
        ...next,
        schemaVersion: EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
        updatedAt: this.now(),
      };
      await this.writeAtomic(stamped);
      this.document = stamped;
    };
    const pending = this.mutationQueue.then(run, run);
    this.mutationQueue = pending.then(() => undefined, () => undefined);
    await pending;
  }

  private async readOrInitialize(): Promise<EdgeLocalAuthorityDocument> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      return migrateAuthorityDocument(JSON.parse(raw) as unknown, this.options.protectionKey, this.now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const document = createEmptyAuthorityDocument(this.options.protectionKey, this.now);
        await this.writeAtomic(document);
        return document;
      }
      if (error instanceof SyntaxError) {
        throw edgeError("EDGE_PROTOCOL", "Local Edge authority state is corrupted and cannot be parsed.");
      }
      throw error;
    }
  }

  private async writeAtomic(document: EdgeLocalAuthorityDocument): Promise<void> {
    const tempPath = `${this.statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmodOwnerOnly(tempPath, 0o600);
    }
    await rename(tempPath, this.statePath);
    if (process.platform !== "win32") {
      await chmodOwnerOnly(this.statePath, 0o600);
    }
  }

  private async acquireLock(): Promise<void> {
    const started = this.now();
    while (this.now() - started <= this.lockTimeoutMs) {
      try {
        this.lockHandle = await open(this.lockPath, "wx");
        await this.lockHandle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
        if (process.platform !== "win32") {
          await chmodOwnerOnly(this.lockPath, 0o600);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        if (await this.recoverStaleLock()) {
          continue;
        }
        await sleep(50);
      }
    }
    throw edgeError(
      "EDGE_PROTOCOL",
      "Local Edge authority store is locked by another process; local mode is single-process only.",
    );
  }

  private async recoverStaleLock(): Promise<boolean> {
    let owner: string;
    try {
      owner = (await readFile(this.lockPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const pid = Number.parseInt(owner, 10);
    if (Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid)) return false;

    const stalePath = `${this.lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await rename(this.lockPath, stalePath);
      await rm(stalePath, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }

  private async ensureOwnerOnlyDirectory(): Promise<void> {
    if (process.platform === "win32") {
      return;
    }
    const { stat } = await import("node:fs/promises");
    const info = await stat(this.options.directory);
    if ((info.mode & 0o077) !== 0) {
      await chmodOwnerOnly(this.options.directory, 0o700);
    }
  }

  private requireOpen(): void {
    if (!this.document || this.closed) {
      throw edgeError("EDGE_PROTOCOL", "Local Edge authority store is not open.");
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Hash a bearer, refresh, or device credential for equality checks at rest. @pk */
export function hashSecret(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Compare a raw secret with a stored hash without leaking timing through length branches beyond the digest. @pk */
export function compareSecretHash(storedHash: string, provided: string): boolean {
  return timingSafeEqualStrings(storedHash, hashSecret(provided));
}

/** Normalize a human user code for durable lookup. @pk */
export function normalizeUserCode(userCode: string): string {
  return userCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Redact secret-bearing values from errors and telemetry payloads. @pk */
export function redactEdgeAuthorityValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (looksLikeSecret(value)) {
      return "[redacted]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactEdgeAuthorityValue(entry));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/(token|secret|credential|private|proof|password|key)/i.test(key)) {
        result[key] = "[redacted]";
      } else {
        result[key] = redactEdgeAuthorityValue(nested);
      }
    }
    return result;
  }
  return value;
}

function createEmptyAuthorityDocument(
  protectionKey: string | Buffer,
  now: () => number,
): EdgeLocalAuthorityDocument {
  const signingKey = randomBytes(32);
  return {
    schemaVersion: EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
    server: {
      serverId: randomBytes(16).toString("base64url"),
      createdAt: now(),
      encryptedSigningKey: encryptBlob(signingKey, protectionKey),
    },
    authorizationSessions: Object.freeze([]),
    refreshCredentials: Object.freeze([]),
    enrolledDevices: Object.freeze([]),
    desiredAssignments: Object.freeze([]),
    usedHelloNonces: Object.freeze([]),
    inventory: Object.freeze({}),
    updatedAt: now(),
  };
}

function migrateAuthorityDocument(
  value: unknown,
  protectionKey: string | Buffer,
  now: () => number,
): EdgeLocalAuthorityDocument {
  if (!value || typeof value !== "object") {
    throw edgeError("EDGE_PROTOCOL", "Local Edge authority state is corrupted.");
  }
  const document = value as Partial<EdgeLocalAuthorityDocument>;
  if (document.schemaVersion === undefined) {
    throw edgeError("EDGE_PROTOCOL", "Local Edge authority state is missing a schema version.");
  }
  if (document.schemaVersion !== EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION) {
    throw edgeError(
      "EDGE_PROTOCOL",
      `Unsupported local Edge authority schema version ${String(document.schemaVersion)}.`,
    );
  }
  if (!document.server?.encryptedSigningKey || !document.server.serverId) {
    throw edgeError("EDGE_PROTOCOL", "Local Edge authority state is missing server identity.");
  }
  // Touch the protection key so corruption in the encrypted blob fails closed at open.
  decryptBlob(document.server.encryptedSigningKey, protectionKey);
  return {
    schemaVersion: EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
    server: document.server,
    authorizationSessions: Object.freeze(
      [...(document.authorizationSessions ?? [])].map(migrateSession).map(freezeSession),
    ),
    refreshCredentials: Object.freeze([...(document.refreshCredentials ?? [])].map((entry) => Object.freeze({ ...entry }))),
    enrolledDevices: Object.freeze([...(document.enrolledDevices ?? [])].map((entry) => Object.freeze({ ...entry }))),
    desiredAssignments: Object.freeze([...(document.desiredAssignments ?? [])].map((entry) => Object.freeze({ ...entry }))),
    usedHelloNonces: Object.freeze([...(document.usedHelloNonces ?? [])].map((entry) => Object.freeze({ ...entry }))),
    inventory: Object.freeze({ ...(document.inventory ?? {}) }),
    updatedAt: typeof document.updatedAt === "number" ? document.updatedAt : now(),
  };
}

function migrateSession(session: EdgeAuthorizationSession & { readonly userCodeNormalized?: string }): EdgeAuthorizationSession {
  if (session.userCodeHash) {
    const { userCodeNormalized: _legacy, ...rest } = session as EdgeAuthorizationSession & {
      readonly userCodeNormalized?: string;
    };
    void _legacy;
    return rest;
  }
  const legacy = (session as { readonly userCodeNormalized?: string }).userCodeNormalized;
  if (!legacy) {
    throw edgeError("EDGE_PROTOCOL", "Local Edge authorization session is missing a user code hash.");
  }
  const { userCodeNormalized: _legacy, ...rest } = session as EdgeAuthorizationSession & {
    readonly userCodeNormalized?: string;
  };
  void _legacy;
  return {
    ...rest,
    userCodeHash: hashSecret(normalizeUserCode(legacy)),
  };
}

function freezeSession(session: EdgeAuthorizationSession): EdgeAuthorizationSession {
  return Object.freeze({
    ...session,
    ...(session.metadata ? { metadata: Object.freeze({ ...session.metadata }) } : {}),
  });
}

function encryptBlob(plaintext: Buffer, key: string | Buffer): EdgeEncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const iterations = 210_000;
  const derived = pbkdf2Sync(key, salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    kdf: {
      name: "pbkdf2-sha256",
      iterations,
      salt: salt.toString("base64"),
      keyLength: 32,
    },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptBlob(blob: EdgeEncryptedBlob, key: string | Buffer): Buffer {
  if (blob.algorithm !== "aes-256-gcm" || blob.kdf.name !== "pbkdf2-sha256") {
    throw edgeError("EDGE_PROTOCOL", "Unsupported local Edge authority encryption envelope.");
  }
  const derived = pbkdf2Sync(key, Buffer.from(blob.kdf.salt, "base64"), blob.kdf.iterations, blob.kdf.keyLength, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "base64")),
    decipher.final(),
  ]);
}

function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function looksLikeSecret(value: string): boolean {
  return value.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

async function chmodOwnerOnly(target: string, mode: number): Promise<void> {
  const { chmod } = await import("node:fs/promises");
  await chmod(target, mode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
