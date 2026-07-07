## 1. Public Config And Diagnostic Contracts

- [x] 1.1 Add a config module for `defineFentarisConfig`, `validateFentarisConfig`, `assertValidFentarisConfig`, and public config result types.
- [x] 1.2 Define `FentarisDiagnostic`, diagnostic severity, semantic path, related entry, suggestion, formatter options, and validation result types.
- [x] 1.3 Add `FentarisConfigError` with diagnostics storage, plain message fallback, `toJSON()`, and `format(...)`.
- [x] 1.4 Export the config and diagnostic contracts from the official public entrypoint without exposing resolved runtime internals as the primary API.
- [x] 1.5 Add external TypeScript consumer checks for the new config APIs and diagnostic types.

## 2. Internal Resolver

- [x] 2.1 Implement an internal config resolver that normalizes global servers, group-declared servers, defaults, groups, subject index data, and scoped server bindings.
- [x] 2.2 Keep `defineFentarisConfig` lightweight and move heavy normalization into validation/runtime resolution.
- [x] 2.3 Integrate the resolver with `fentaris(...)`, `createProxy(...)`, and `McpProxy` without changing valid existing high-level syntax.
- [x] 2.4 Keep direct runtime classes defensive, but avoid relying on constructor errors as the only user-facing validation path.

## 3. Semantic Validation

- [x] 3.1 Validate config shape, empty ids, duplicate group ids, duplicate server names, and empty server names with structured diagnostics.
- [x] 3.2 Validate scoped MCP ambiguity for global servers, group servers, overlapping groups, and global-plus-group name conflicts.
- [x] 3.3 Validate group policy server visibility against global and group-scoped MCP bindings.
- [x] 3.4 Add warning diagnostics for broad wildcard policy permissions that should not block startup.
- [x] 3.5 Validate identity setup, required identity behavior, API-key declarations, and auth compatibility.
- [x] 3.6 Validate credential references without exposing raw secret values in diagnostics or formatted output.
- [x] 3.7 Validate minimum custom transport contract shape without requiring built-in transport classes.
- [x] 3.8 Validate scoped proxy handle references for unknown groups, unknown servers, and group/server visibility.

## 4. Diagnostic Rendering

- [x] 4.1 Implement a plain renderer that produces stable no-color, ASCII-safe output.
- [x] 4.2 Implement a pretty terminal renderer with severity styling, paths, hints, related entries, suggestions, and semantic config tree frames.
- [x] 4.3 Implement compact and JSON-oriented formatting modes.
- [x] 4.4 Add color and Unicode controls with automatic fallback for `NO_COLOR`, non-TTY, and CI-like environments.
- [x] 4.5 Ensure renderer output never reveals raw credential or auth secret values.

## 5. Runtime Integration

- [x] 5.1 Make high-level `fentaris(config)` and `createProxy(config)` automatically validate and throw `FentarisConfigError` on error-severity diagnostics.
- [x] 5.2 Ensure warning-only configs can start while still exposing warnings through explicit validation APIs.
- [x] 5.3 Preserve existing valid global MCP, group, policy, credential, and transport behavior.
- [x] 5.4 Decide whether `resolveFentarisConfig` remains fully internal or is exported from a clearly marked config subpath, then document the decision in code comments or docs.

## 6. Tests And Documentation

- [x] 6.1 Add unit tests for structured diagnostics across config shape, scoped MCP, policy visibility, identity, credentials, transports, and scoped handles.
- [x] 6.2 Add focused tests for `FentarisConfigError`, `toJSON()`, and `format(...)`.
- [x] 6.3 Add renderer tests for plain, pretty without color, compact, and JSON-oriented output.
- [x] 6.4 Add redaction tests proving secret values do not appear in diagnostics or rendered output.
- [x] 6.5 Add compatibility tests proving existing valid high-level configs still start.
- [x] 6.6 Update examples or docs to show high-level automatic validation and explicit low-level validation/rendering.
- [x] 6.7 Run focused core tests, type checks, and any extension consumer checks affected by the new public API.
