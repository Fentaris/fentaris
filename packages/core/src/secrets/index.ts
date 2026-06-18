export {
  diffManifest,
  manifestFromSecretRefs,
  manifestsEqual,
  parseManifest,
  serializeManifest,
} from "./manifest.js";
export { credentialsToRefs, LocalSecretsBackend } from "./local-backend.js";
export type { LocalSecretsBackendOptions } from "./local-backend.js";
export {
  decodeSecretScope,
  encodeSecretScope,
  manifestEntryKey,
  secretRefKey,
} from "./types.js";
export type {
  SecretRef,
  SecretScope,
  SecretsBackend,
  SecretsManifest,
  SecretsManifestDiff,
  SecretsManifestEntry,
  SecretsProvider,
} from "./types.js";
