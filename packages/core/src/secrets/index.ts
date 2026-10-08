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
  SecretsManifestApiKey,
  SecretsManifestDiff,
  SecretsManifestEntry,
  SecretsManifestSource,
  SecretsProvider,
} from "./types.js";
export { ProjectVault, VaultWriteVerificationError, assertVaultName, projectVaultIdentityStrategy } from "./project-vault.js";
export type { ProjectVaultOptions, ProjectSecretSource, ProjectSecretMetadata, SecretConsumer, IncomingKeyMetadata, ExternalSecretProvider } from "./project-vault.js";
export { systemCredentialStore } from "./system-credential-store.js";
export type { SystemCredentialStore } from "./system-credential-store.js";
