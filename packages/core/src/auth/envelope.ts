import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { z } from "zod";

const legacyEnvelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const currentEnvelopeSchema = z.object({
  version: z.literal(2),
  algorithm: z.literal("aes-256-gcm"),
  kdf: z.object({
    name: z.literal("pbkdf2-sha256"),
    iterations: z.number().int().positive(),
    salt: z.string(),
    keyLength: z.literal(32),
  }),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

/**
 * Schema for the AES-256-GCM encrypted envelope used by local Fentaris stores.
 * @pk
 */
export const encryptedEnvelopeSchema = z.discriminatedUnion("version", [legacyEnvelopeSchema, currentEnvelopeSchema]);

/**
 * Encrypted envelope payload persisted by local Fentaris stores.
 * @pk
 */
export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

/**
 * Current encrypted envelope version produced by {@link encryptEnvelope}.
 * @pk
 */
export type EncryptedEnvelopeV2 = z.infer<typeof currentEnvelopeSchema>;

export const defaultKdfIterations = 210_000;

/**
 * Encrypt a JSON-serializable payload into a versioned AES-256-GCM envelope.
 * @pk
 */
export function encryptEnvelope(payload: unknown, key: string | Buffer): EncryptedEnvelopeV2 {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveStretchedKey(key, salt, defaultKdfIterations), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 2,
    algorithm: "aes-256-gcm",
    kdf: {
      name: "pbkdf2-sha256",
      iterations: defaultKdfIterations,
      salt: salt.toString("base64"),
      keyLength: 32,
    },
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt a versioned AES-256-GCM envelope back into its JSON payload.
 * @pk
 */
export function decryptEnvelope(envelope: EncryptedEnvelope, key: string | Buffer, failureMessage: string): unknown {
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveEnvelopeKey(envelope, key), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error(failureMessage);
  }
}

/**
 * Parse a value against a schema and raise a sanitized error listing the offending paths.
 * @pk
 */
export function parseWithError<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${message}: ${result.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
  }

  return result.data;
}

function deriveEnvelopeKey(envelope: EncryptedEnvelope, key: string | Buffer): Buffer {
  if (envelope.version === 1) {
    return deriveLegacyKey(key, Buffer.from(envelope.salt, "base64"));
  }

  return deriveStretchedKey(key, Buffer.from(envelope.kdf.salt, "base64"), envelope.kdf.iterations);
}

function deriveLegacyKey(key: string | Buffer, salt: Buffer): Buffer {
  return createHash("sha256").update(key).update(salt).digest();
}

function deriveStretchedKey(key: string | Buffer, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(key, salt, iterations, 32, "sha256");
}
