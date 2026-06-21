## 1. Safe Secret Input

- [x] 1.1 Change non-TTY secret prompts to fail closed unless an explicit safe input source is requested.
- [x] 1.2 Add `--value-stdin` or equivalent safe stdin support for secrets commands.
- [x] 1.3 Add warnings or deprecation notices for sensitive `--value` and `--key` argv usage.
- [x] 1.4 Add tests for TTY, non-TTY, stdin, env, and argv paths.

## 2. Accurate CLI Mutations

- [x] 2.1 Change local secret backend `unset` to return whether a value was removed.
- [x] 2.2 Update `secrets unset` output and exit behavior for no-op removal.
- [x] 2.3 Add tests for missing ref, missing scope, missing store, and successful removal.

## 3. Storage Hardening

- [x] 3.1 Add a versioned encrypted credential file format with KDF metadata.
- [x] 3.2 Implement legacy SHA-256 read compatibility and new stretched KDF writes.
- [x] 3.3 Apply owner-only file permissions after writing credential files on Unix.
- [x] 3.4 Add tests for legacy decryption, migrated writes, wrong key behavior, and Unix file mode.

## 4. Doctor And Scanner

- [x] 4.1 Add `secrets doctor --key` parity with other secrets commands.
- [x] 4.2 Extend manifest scanning for scoped `credential()` declarations and supported `credentialEnv` forms.
- [x] 4.3 Wrap malformed manifest JSON parse errors with user-friendly CLI messages.
- [x] 4.4 Add unit tests for scanner scope detection and invalid manifest diagnostics.

## 5. Cleanup And Verification

- [x] 5.1 Remove or consolidate duplicate unused local credential helper functions.
- [x] 5.2 Run focused CLI secrets and core local backend tests.
- [x] 5.3 Update docs for safe automation input, KDF migration, and file permission behavior.
