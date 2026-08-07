## Why

Fentaris can discover some local secret references, but it does not discover declared API-key sources and it allows a proxy with unavailable credentials to start and fail only on the first authenticated request. Projects need one guided, safe setup path and deterministic startup failures before any listener is exposed.

## What Changes

- Add `fentaris secrets setup` to discover, review, and provision all supported local credentials and Fentaris user API keys.
- Extend the version 1 secrets manifest compatibly with source metadata and API-key requirements.
- Expand source scanning to cover `credential`, `credentialJson`, `credentialEnv`, scoped credentials, API-key declarations, and unsupported custom local paths.
- Add canonical JSON, dry-run, and non-interactive behavior that never performs partial setup when external values are unavailable.
- **BREAKING** Make runtime startup resolve every declared credential source and fail before opening transports when any source is unavailable.

## Capabilities

### New Capabilities
- `runtime-credential-readiness`: Fail-fast runtime validation for declared credential sources with sanitized aggregated diagnostics.

### Modified Capabilities
- `secrets-cli-storage-security`: Add guided, idempotent provisioning, complete requirement discovery, and backward-compatible manifest source metadata.
- `local-auth-store`: Require declared local and environment credential sources to be readable before serving requests.

## Impact

- `@fentaris/cli`: new public command, manifest schema additions, scanner and diagnostics changes.
- `@fentaris/core`: public manifest types and breaking runtime startup behavior.
- Documentation, generated API reference, tests, and Changesets for a core major and CLI minor release.
