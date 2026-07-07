## Why

The local secrets workflow can expose secrets in non-interactive terminals, command argv, permissive file modes, and weak key derivation, while some CLI commands provide misleading or unfriendly feedback. This change hardens secret entry, storage, scanning, and diagnostics.

## What Changes

- Fail closed or require explicit safe input methods for secret prompts on non-TTY stdin/stdout.
- Add safer secret input alternatives such as env-based key loading and `--value-stdin`.
- Return accurate `secrets unset` status when no secret was removed.
- Version encrypted credential storage and migrate key derivation from single SHA-256 to a stretched KDF.
- Write local encrypted credential files with owner-only permissions on Unix.
- Add `secrets doctor --key` parity with other secrets commands.
- Improve manifest secret scanning for scoped credentials and `credentialEnv` usage.
- Wrap malformed manifest JSON errors with user-friendly CLI messages.
- Remove or consolidate unused duplicate local credential helpers.

## Capabilities

### New Capabilities

- `secrets-cli-storage-security`: Covers safe CLI secret input, accurate secret mutation results, encrypted storage KDF and permissions, doctor/scanner diagnostics, and local store cleanup.

### Modified Capabilities

- None.

## Impact

- Affects `packages/cli/src/platform/runtime.ts`, `packages/cli/src/commands/secrets.ts`, CLI auth local store helpers, secrets doctor/scanner modules, and `packages/core/src/secrets/local-backend.ts`.
- May require migration logic for existing `credentials.enc.json` files.
- Requires tests for non-TTY prompts, unset no-op behavior, argv-safe paths, KDF compatibility, file modes, scanner coverage, and malformed manifest handling.
