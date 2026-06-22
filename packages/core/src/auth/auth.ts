import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { IdentityStrategy } from "../types/policy.js";
import type { CredentialSourceMetadata, ResolvedSubject } from "../types/shared.js";

const encryptedCredentialsSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const credentialValueSchema = z.string().min(1);

const localCredentialsSchema = z.object({
  users: z.record(
    z.string(),
    z.object({
      apiKeys: z.array(z.string().min(1)).default([]),
      credentials: z.record(z.string(), credentialValueSchema).default({}),
    }),
  ).default({}),
  groups: z.record(z.string(), z.record(z.string(), credentialValueSchema)).default({}),
  defaults: z.record(z.string(), credentialValueSchema).default({}),
});

const upstreamAuthBindingSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    credential: z.string().min(1),
  }),
  z.object({
    type: z.literal("header"),
    header: z.string().min(1),
    credential: z.string().min(1),
  }),
  z.object({
    type: z.literal("env"),
    env: z.string().min(1),
    credential: z.string().min(1),
  }),
]);

const upstreamAuthBindingsSchema = z.object({
  servers: z.record(z.string(), upstreamAuthBindingSchema).default({}),
  credentialConflict: z.enum(["first", "error"]).default("first"),
});

export type LocalCredentials = z.infer<typeof localCredentialsSchema>;
export type UpstreamAuthBinding = z.infer<typeof upstreamAuthBindingSchema>;
export type UpstreamAuthBindings = z.infer<typeof upstreamAuthBindingsSchema>;

export type LocalAuthOptions = {
  dir: string;
  key: string | Buffer;
  credentialsFile?: string;
  upstreamAuthFile?: string;
  upstreamAuth?: UpstreamAuthBindings;
};

export type CredentialResolution = CredentialSourceMetadata & {
  value: string;
};

/**
 * Unified local auth configuration.
 * @pk
 */
export class FentarisAuth {
  private readonly credentials: LocalCredentials;
  private readonly bindings: UpstreamAuthBindings;

  private constructor(credentials: LocalCredentials, bindings: UpstreamAuthBindings) {
    this.credentials = credentials;
    this.bindings = bindings;
  }

  /**
   * Load local encrypted credentials and upstream auth bindings from a directory.
   * @pk
   */
  static async local(options: LocalAuthOptions): Promise<FentarisAuth> {
    const credentialsPath = path.join(options.dir, options.credentialsFile ?? "credentials.enc.json");
    const upstreamAuthPath = path.join(options.dir, options.upstreamAuthFile ?? "upstream-auth.json");

    const encryptedCredentials = await readJson(credentialsPath, "encrypted credentials");
    const upstreamBindings = options.upstreamAuth ?? (await readOptionalJson(upstreamAuthPath, { servers: {} }));

    const envelope = parseWithError(encryptedCredentialsSchema, encryptedCredentials, "Invalid encrypted credentials file");
    const decrypted = decryptLocalCredentials(envelope, options.key);
    const credentials = parseWithError(localCredentialsSchema, decrypted, "Invalid decrypted credentials payload");
    const bindings = parseWithError(upstreamAuthBindingsSchema, upstreamBindings, "Invalid upstream auth bindings file");

    return new FentarisAuth(credentials, bindings);
  }

  /**
   * Build an encrypted credentials envelope for local auth files.
   * @pk
   */
  static encryptCredentials(credentials: LocalCredentials, key: string | Buffer): z.infer<typeof encryptedCredentialsSchema> {
    const validated = localCredentialsSchema.parse(credentials);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(key, salt), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(validated), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: 1,
      algorithm: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  /**
   * Decrypt and validate a local credentials envelope.
   * @pk
   */
  static decryptCredentials(envelope: unknown, key: string | Buffer): LocalCredentials {
    const parsedEnvelope = parseWithError(encryptedCredentialsSchema, envelope, "Invalid encrypted credentials file");
    return parseWithError(localCredentialsSchema, decryptLocalCredentials(parsedEnvelope, key), "Invalid decrypted credentials payload");
  }

  /**
   * Return the supported API-key hash encoding for local credentials.
   * @pk
   */
  static hashApiKey(apiKey: string): string {
    return `sha256:${hashApiKey(apiKey)}`;
  }

  /**
   * Compare a stored API key or hash with a provided API key.
   * @pk
   */
  static compareApiKey(candidate: string, provided: string): boolean {
    return compareApiKey(candidate, provided);
  }

  resolveApiKey(apiKey: string): string | null {
    for (const [userId, entry] of Object.entries(this.credentials.users)) {
      if (entry.apiKeys.some((candidate) => FentarisAuth.compareApiKey(candidate, apiKey))) {
        return userId;
      }
    }

    return null;
  }

  identityStrategy(options: { header?: string; name?: string } = {}): IdentityStrategy {
    return apiKeyIdentityStrategy({ auth: this, ...options });
  }

  getBinding(serverName: string): UpstreamAuthBinding | undefined {
    return this.bindings.servers[serverName];
  }

  resolveCredential(reference: string, subject: ResolvedSubject): CredentialResolution | null {
    const userCredential = this.credentials.users[subject.id]?.credentials[reference];
    if (userCredential) {
      return { reference, value: userCredential, source: "user", userId: subject.id };
    }

    const matches = subject.groups.flatMap((group) => {
      const value = this.credentials.groups[group.id]?.[reference];
      return value ? [{ groupId: group.id, value }] : [];
    });

    if (matches.length > 1 && this.bindings.credentialConflict === "error") {
      throw new Error(`Credential reference "${reference}" is provided by multiple groups`);
    }

    const groupCredential = matches[0];
    if (groupCredential) {
      return { reference, value: groupCredential.value, source: "group", groupId: groupCredential.groupId };
    }

    const defaultCredential = this.credentials.defaults[reference];
    if (defaultCredential) {
      return { reference, value: defaultCredential, source: "default" };
    }

    return null;
  }
}

/**
 * API-key identity strategy backed by encrypted local auth storage.
 * @pk
 */
export function apiKeyIdentityStrategy(options: {
  auth: FentarisAuth;
  header?: string;
  name?: string;
}): IdentityStrategy {
  const header = (options.header ?? "x-fentaris-api-key").toLowerCase();

  return {
    name: options.name ?? "api-key",
    resolve(request) {
      const apiKey = request.headers?.[header];
      if (!apiKey) {
        return null;
      }

      const userId = options.auth.resolveApiKey(apiKey);
      return userId ? { id: userId } : null;
    },
  };
}

function decryptLocalCredentials(envelope: z.infer<typeof encryptedCredentialsSchema>, key: string | Buffer): unknown {
  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(key, salt), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error("Unable to decrypt local credentials with the provided key");
  }
}

function deriveKey(key: string | Buffer, salt: Buffer): Buffer {
  return createHash("sha256").update(key).update(salt).digest();
}

function compareApiKey(candidate: string, provided: string): boolean {
  const normalizedCandidate = candidate.startsWith("sha256:") ? candidate.slice("sha256:".length) : hashApiKey(candidate);
  const normalizedProvided = hashApiKey(provided);
  const left = Buffer.from(normalizedCandidate, "hex");
  const right = Buffer.from(normalizedProvided, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing ${label} file at ${filePath}`, { cause: error });
    }

    throw new Error(`Unable to read ${label} file at ${filePath}`, { cause: error });
  }
}

async function readOptionalJson(filePath: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    throw new Error(`Unable to read upstream auth bindings file at ${filePath}`, { cause: error });
  }
}

function parseWithError<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${message}: ${result.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
  }

  return result.data;
}
