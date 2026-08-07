## Context

The CLI currently stores local credentials safely and scans a subset of source syntax, but its manifest cannot represent API-key requirements or distinguish local values from environment values. Runtime resolution is lazy, so configuration validation can pass even when a declared source cannot be read.

## Goals / Non-Goals

**Goals:**
- Use one sanitized requirement model across manifest generation, doctor, list, and setup.
- Make setup idempotent and avoid partial non-interactive writes.
- Validate actual runtime objects before all exposure paths.

**Non-Goals:**
- Fetch or generate third-party provider tokens.
- Add Fentaris Cloud secret synchronization.
- Automatically provision custom JSON files outside the standard local backend.

## Decisions

### Extend manifest v1 compatibly

Reference entries gain optional source metadata, and the manifest gains optional API-key requirements. Missing metadata defaults to the current local behavior. This avoids a migration-only version bump while allowing new clients to make correct setup decisions.

Alternative: introduce manifest v2. Rejected because all additions are optional and old readers can safely ignore them.

### Scan declarations into a richer internal requirement model

The scanner will distinguish logical local references, environment requirements, standard local API-key slots, and unsupported custom JSON sources. Manifest serialization derives from this model rather than guessing all `credential(...)` calls are default local values.

Alternative: use only the existing manifest arrays. Rejected because they cannot map an environment variable back to a scoped reference or represent API keys.

### Preflight setup before writes

Setup first calculates stored and environment state. Interactive mode collects all missing external values in memory before confirmation and writes. JSON and non-interactive modes require external values to exist already; otherwise they return an incomplete result without generating keys or files. Successful reruns only report existing state.

### Validate runtime configuration directly

The core collects credential sources from normalized defaults, groups, users, and API keys, deduplicates low-level resolution work, and retains all usage labels for diagnostics. Both `start()` and the first `listen()` await this validation before starting lifecycle or transport work. The manifest is not used by the runtime.

### Use structured sanitized errors

Unavailable sources produce a `FentarisRuntimeError` with code `FENTARIS_CREDENTIALS_UNAVAILABLE`, setup guidance, and sanitized context. Source keys and values are excluded from both messages and context.

## Risks / Trade-offs

- [Breaking startup behavior] → Release `@fentaris/core` as a major version and document migration through `fentaris secrets setup`.
- [Regex scanning cannot understand arbitrary TypeScript] → Support documented declarative shapes, emit unsupported diagnostics, and keep runtime validation authoritative.
- [Multi-file writes can fail after preflight] → Order writes safely, make every operation idempotent, and report completed versus remaining requirements for a clean rerun.
- [Generated client keys are sensitive output] → Emit them only after successful persistence and only in the command invocation that generated them.

## Migration Plan

1. Release the CLI minor with manifest compatibility and setup support alongside the core major.
2. Existing projects run `fentaris secrets manifest` and `fentaris secrets setup` before upgrading the runtime.
3. Rollback uses the previous core version; manifest additions remain harmless because they are optional.
