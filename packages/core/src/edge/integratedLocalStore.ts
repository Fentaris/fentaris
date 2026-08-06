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
  chmod,
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
  readonly inventory: Readonly<Record<string, unknown>>;
  readonly updatedAt: number;
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
    const normalized = normalizeUserCode(userCode);
    return this.snapshot().authorizationSessions.find((session) => session.userCodeNormalized === normalized);
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

  decryptSigningKey(): Buffer {
    this.requireOpen();
    return decryptBlob(this.document!.server.encryptedSigningKey, this.options.protectionKey);
  }

  private async mutate(
    update: (document: EdgeLocalAuthorityDocument) => EdgeLocalAuthorityDocument,
  ): Promise<void> {
    this.requireOpen();
    const next = update(this.document!);
    const stamped: EdgeLocalAuthorityDocument = {
      ...next,
      schemaVersion: EDGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
      updatedAt: this.now(),
    };
    await this.writeAtomic(stamped);
    this.document = stamped;
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
        await sleep(50);
      }
    }
    throw edgeError(
      "EDGE_PROTOCOL",
      "Local Edge authority store is locked by another process; local mode is single-process only.",
    );
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
    authorizationSessions: Object.freeze([...(document.authorizationSessions ?? [])].map(freezeSession)),
    refreshCredentials: Object.freeze([...(document.refreshCredentials ?? [])].map((entry) => Object.freeze({ ...entry }))),
    enrolledDevices: Object.freeze([...(document.enrolledDevices ?? [])].map((entry) => Object.freeze({ ...entry }))),
    desiredAssignments: Object.freeze([...(document.desiredAssignments ?? [])].map((entry) => Object.freeze({ ...entry }))),
    inventory: Object.freeze({ ...(document.inventory ?? {}) }),
    updatedAt: typeof document.updatedAt === "number" ? document.updatedAt : now(),
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
