## Context

The CLI and local secret backend already encrypt credential values, but several operational paths can still leak or misrepresent secrets. Non-TTY secret prompts can echo values into CI logs, `--value` arguments remain visible in process lists, `unset` always reports success, and encrypted files can be created with broad default permissions.

## Goals / Non-Goals

**Goals:**

- Avoid echoing secrets in non-interactive environments.
- Provide safe alternatives for automation.
- Make mutation commands truthful.
- Strengthen local credential encryption and file permissions.
- Improve diagnostics for manifest parsing and secret discovery.
- Reduce duplicated secret helper code.

**Non-Goals:**

- Adding a remote secret manager.
- Removing all command-line compatibility immediately.
- Changing the encrypted payload cipher away from AES-256-GCM.

## Decisions

- Treat non-TTY secret prompting as unsafe by default. Automation should use env variables, files, or stdin options that do not echo prompt text into logs.
- Add `--value-stdin` and prefer env/file based auth key loading over `--value` and `--key` for sensitive values. Existing argv options can remain temporarily with warnings and documentation.
- Change backend `unset` to return a boolean and map no-op removal to warning or non-zero CLI status where appropriate.
- Introduce a versioned credential file format with KDF metadata. New writes use PBKDF2, scrypt, or Argon2 parameters; reads support legacy SHA-256 files and rewrite on successful mutation.
- Apply `chmod 0o600` after credential file writes on Unix platforms.
- Consolidate unused duplicate helpers into the backend path to avoid drift.

## Risks / Trade-offs

- KDF migration can lock users out if implemented without backward compatibility. Mitigation: support legacy reads and only migrate after successful decryption.
- Deprecating argv options can affect scripts. Mitigation: add safer alternatives first and warn before removal.
- File mode tests are platform-specific. Mitigation: gate strict mode checks to Unix.

## Migration Plan

- Add versioned decrypt support for both legacy and new encrypted credential files.
- Write new and updated stores in the new KDF format.
- Emit deprecation warnings for unsafe argv secret values after safe alternatives exist.

## Open Questions

- Which KDF should be the default for Node runtime compatibility and install footprint: PBKDF2 from built-in crypto, scrypt from built-in crypto, or Argon2 via dependency?
