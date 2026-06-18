import { z } from "zod";
import {
  decodeSecretScope,
  encodeSecretScope,
  manifestEntryKey,
  secretRefKey,
  type SecretRef,
  type SecretsManifest,
  type SecretsManifestDiff,
  type SecretsManifestEntry,
} from "./types.js";

const manifestEntrySchema = z.object({
  ref: z.string().min(1),
  scope: z.string().min(1),
});

const secretsManifestSchema = z.object({
  version: z.literal(1),
  references: z.array(manifestEntrySchema).default([]),
  envVars: z.array(z.string().min(1)).optional(),
});

/**
 * Parse and validate a secrets manifest.
 * @pk
 */
export function parseManifest(value: unknown): SecretsManifest {
  const parsed = secretsManifestSchema.parse(value);
  for (const entry of parsed.references) {
    decodeSecretScope(entry.scope);
  }
  return parsed;
}

/**
 * Serialize a secrets manifest to JSON.
 * @pk
 */
export function serializeManifest(manifest: SecretsManifest): string {
  const normalized: SecretsManifest = {
    version: 1,
    references: sortManifestEntries(manifest.references),
    ...(manifest.envVars?.length ? { envVars: [...new Set(manifest.envVars)].sort() } : {}),
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

/**
 * Compare required manifest entries against stored secret refs.
 * @pk
 */
export function diffManifest(required: SecretsManifestEntry[], stored: SecretRef[]): SecretsManifestDiff {
  const requiredKeys = new Set(required.map((entry) => manifestEntryKey(entry)));
  const storedKeys = new Set(
    stored.filter((entry) => entry.kind === "credential").map((entry) => secretRefKey(entry.ref, entry.scope)),
  );

  const missing = required.filter((entry) => !storedKeys.has(manifestEntryKey(entry)));
  const extra = stored.filter(
    (entry) => entry.kind === "credential" && !requiredKeys.has(secretRefKey(entry.ref, entry.scope)),
  );
  const stale: SecretsManifestEntry[] = [];

  return { missing, extra, stale };
}

/**
 * Build manifest entries from credential secret refs.
 * @pk
 */
export function manifestFromSecretRefs(refs: SecretRef[], envVars: string[] = []): SecretsManifest {
  return {
    version: 1,
    references: sortManifestEntries(
      refs
        .filter((entry) => entry.kind === "credential")
        .map((entry) => ({ ref: entry.ref, scope: encodeSecretScope(entry.scope) })),
    ),
    ...(envVars.length ? { envVars: [...new Set(envVars)].sort() } : {}),
  };
}

/**
 * Compare two manifests for equality (order-insensitive).
 * @pk
 */
export function manifestsEqual(left: SecretsManifest, right: SecretsManifest): boolean {
  return serializeManifest(left) === serializeManifest(right);
}

function sortManifestEntries(entries: SecretsManifestEntry[]): SecretsManifestEntry[] {
  return [...entries].sort((left, right) => {
    const scopeCompare = left.scope.localeCompare(right.scope);
    return scopeCompare !== 0 ? scopeCompare : left.ref.localeCompare(right.ref);
  });
}
