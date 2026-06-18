/**
 * Secret scope for credential storage.
 * @pk
 */
export type SecretScope =
  | { kind: "default" }
  | { kind: "user"; id: string }
  | { kind: "group"; id: string };

/**
 * Reference to a stored secret without exposing its value.
 * @pk
 */
export type SecretRef = {
  ref: string;
  scope: SecretScope;
  kind: "credential" | "apiKey";
  /** Number of API keys for apiKey kind; always 1 for credentials. */
  count: number;
};

/**
 * Committable secrets manifest — schema only, no values.
 * @pk
 */
export type SecretsManifest = {
  version: 1;
  references: SecretsManifestEntry[];
  envVars?: string[];
};

/**
 * Single manifest entry with string scope encoding.
 * @pk
 */
export type SecretsManifestEntry = {
  ref: string;
  scope: string;
};

/**
 * Result of comparing required vs stored secret references.
 * @pk
 */
export type SecretsManifestDiff = {
  missing: SecretsManifestEntry[];
  extra: SecretRef[];
  stale: SecretsManifestEntry[];
};

/**
 * Secrets storage backend — local now, cloud in Phase 2.
 * @pk
 */
export type SecretsProvider = "local" | "panther" | "hybrid";

/**
 * Secrets storage backend contract.
 * @pk
 */
export interface SecretsBackend {
  readonly provider: SecretsProvider;
  listRefs(): Promise<SecretRef[]>;
  has(ref: string, scope: SecretScope): Promise<boolean>;
  set(ref: string, value: string, scope: SecretScope): Promise<void>;
  unset(ref: string, scope: SecretScope): Promise<void>;
}

/**
 * Encode a secret scope to manifest string form.
 * @pk
 */
export function encodeSecretScope(scope: SecretScope): string {
  if (scope.kind === "default") {
    return "default";
  }
  if (scope.kind === "user") {
    return `user:${scope.id}`;
  }
  return `group:${scope.id}`;
}

/**
 * Decode a manifest scope string to a secret scope.
 * @pk
 */
export function decodeSecretScope(encoded: string): SecretScope {
  if (encoded === "default") {
    return { kind: "default" };
  }
  if (encoded.startsWith("user:")) {
    return { kind: "user", id: encoded.slice("user:".length) };
  }
  if (encoded.startsWith("group:")) {
    return { kind: "group", id: encoded.slice("group:".length) };
  }
  throw new Error(`Invalid secret scope: ${encoded}`);
}

/**
 * Stable key for comparing secret references.
 * @pk
 */
export function secretRefKey(ref: string, scope: SecretScope): string {
  return `${encodeSecretScope(scope)}:${ref}`;
}

/**
 * Stable key for manifest entries.
 * @pk
 */
export function manifestEntryKey(entry: SecretsManifestEntry): string {
  return `${entry.scope}:${entry.ref}`;
}
