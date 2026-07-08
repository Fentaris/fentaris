## Context

Fentaris configuration now combines runtime objects, helpers, scoped MCP servers, groups, policies, credentials, identity strategies, transports, and proxy handles. Some invariants are currently enforced inside constructors such as `Group`, `McpProxy`, and `ServerCatalog`, which keeps invalid state out of runtime but produces ordinary thrown errors and scatters semantic validation across modules.

The pre-alpha DX should make invalid configuration obvious before runtime behavior starts. The same diagnostic data must be useful in application code, tests, CLI output, logs, and future editor or web integrations.

## Goals / Non-Goals

**Goals:**

- Keep `fentaris({...})` as the high-level API where config validation is automatic and invisible.
- Add an explicit low-level API for users and tooling that want to define, validate, assert, and format config diagnostics.
- Keep diagnostics structured and renderer-independent.
- Provide a beautiful default terminal renderer without making ANSI output the source of truth.
- Normalize high-level shortcuts through an internal resolver before proxy runtime setup.
- Validate scoped MCP visibility, policy references, credentials, identity setup, transports, and scoped proxy handles.
- Preserve constructor-level local invariants for simple invalid values.

**Non-Goals:**

- Do not make the resolved runtime config the primary public API in this change.
- Do not introduce JSON/YAML config files or schema-first config loading yet.
- Do not require a large terminal UI dependency for core diagnostics.
- Do not implement runtime MCP add/remove validation in this change.
- Do not replace TypeScript type checking; this adds semantic validation that types cannot express.

## Decisions

### Use a TypeScript-first config helper as the stable public input

`defineFentarisConfig(config)` will preserve inference and mark an object as Fentaris config without doing heavy runtime work. `fentaris(config)` and `createProxy(config)` remain the high-level creation path and validate automatically before runtime setup.

Alternative considered: keep all validation inside `new McpProxy(options)`. This is simpler but keeps errors late, less structured, and less reusable for CLI/tests.

### Provide explicit validation and assertion APIs

`validateFentarisConfig(config)` will return structured diagnostics. `assertValidFentarisConfig(config)` will throw `FentarisConfigError` when error-severity diagnostics exist.

This gives tool authors a non-throwing path while keeping high-level app startup strict.

Alternative considered: only throw errors. That prevents tooling from collecting multiple issues and weakens custom rendering.

### Keep the resolved config internal for now

An internal resolver will normalize global `servers`, group `servers`, subject index data, defaults, and scoped catalog bindings into runtime-ready data. The primary public contract remains input config and diagnostics. If exposed, the resolved type should be marked internal or clearly documented as not the main extension surface.

Alternative considered: make `resolveFentarisConfig()` public and encourage `createProxy(resolved)`. That is architecturally clean but risks freezing an internal representation too early.

### Separate diagnostics from rendering

Diagnostics will be plain data with stable `code`, `severity`, `title`, `message`, semantic `path`, optional `hint`, `docsUrl`, `related`, and `suggestions`. Renderers consume these diagnostics and produce pretty terminal, plain text, compact, or JSON-compatible output.

This follows the same broad split used by mature diagnostic systems: structured issues are separate from human formatting. It enables future CLI, editor, web, and log renderers without changing validation.

Alternative considered: put ANSI-formatted text directly in `FentarisConfigError.message`. That looks good in one context but is hard to test, hard to parse, and hostile to non-terminal consumers.

### Prefer semantic config frames before source code frames

Runtime TypeScript config does not always have file, line, or column spans. The first renderer should therefore show semantic paths and a compact config tree frame, such as group -> policy -> server reference. Source code frames can be added later by CLI loaders that know the originating file and spans.

Alternative considered: implement Babel-style code frames immediately. That is attractive for config files, but unreliable for direct object config built in application code.

### Use dependency-light color and terminal capability handling

Pretty rendering should support automatic color, explicit color on/off, Unicode/ASCII mode, `NO_COLOR`, and CI-safe fallback. The implementation should start with a small local renderer or a minimal dependency only if it materially improves maintainability.

Alternative considered: depend on a full diagnostic rendering package. That may be worthwhile later but is unnecessary before the exact output model is proven.

### Move semantic catalog checks toward validation while keeping local safety

Duplicate names, ambiguous scoped bindings, and group visibility should be reported as config diagnostics before `ServerCatalog` runtime use. `ServerCatalog` may keep defensive checks for direct construction or internal misuse, but those checks should not be the only user-facing validation path.

## Risks / Trade-offs

- [Risk] Diagnostic codes become public API too early. -> Mitigation: define a small stable prefix set and document that new codes can be added without breaking changes.
- [Risk] Pretty renderer snapshots become brittle. -> Mitigation: snapshot plain output and key pretty examples while testing structured diagnostics separately.
- [Risk] Validation duplicates runtime checks. -> Mitigation: extract shared validation helpers where practical and keep runtime checks as defensive assertions.
- [Risk] Internal resolver leaks into public usage. -> Mitigation: do not document resolved config as the normal path and avoid exporting runtime-only fields from the main entrypoint.
- [Risk] Over-validating custom transports rejects valid third-party integrations. -> Mitigation: validate only contract shape and required functions, not implementation details.
- [Risk] Warnings become noisy. -> Mitigation: categorize warnings carefully and provide formatter options for warning visibility.

## Migration Plan

1. Add config and diagnostic types without changing existing high-level user syntax.
2. Add validation and formatting APIs, then integrate automatic validation into `fentaris(...)` and `createProxy(...)`.
3. Move broad scoped MCP and policy visibility checks into validation while preserving existing defensive constructor errors.
4. Add tests for both structured diagnostics and rendered output.
5. Keep old constructor behavior working; invalid configs should fail with richer `FentarisConfigError` through the high-level APIs.

## Open Questions

- Should `resolveFentarisConfig()` be exported from a config subpath as experimental, or kept fully internal for the first pre-alpha?
- Should pretty rendering live in `@fentaris/core` or a later CLI package once CLI ownership is clearer?
- What is the exact diagnostic code naming convention: `config.server.not_visible` or `FENTARIS_CONFIG_SERVER_NOT_VISIBLE`?
