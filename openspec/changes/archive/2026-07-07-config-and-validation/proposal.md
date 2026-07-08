## Why

Fentaris now has a public extension surface and a scoped MCP catalog, but configuration errors are still discovered through runtime constructors and scattered invariants. Before pre-alpha, Fentaris needs a TypeScript-first configuration validation layer that catches ambiguous MCP scope, policy, identity, credential, and hook mistakes early with diagnostics that are structured for tools and beautiful for humans.

## What Changes

- Introduce a high-level config path where `fentaris({...})` keeps the simple DX and automatically validates before creating runtime state.
- Introduce an explicit low-level config path with `defineFentarisConfig(...)`, `validateFentarisConfig(...)`, and `assertValidFentarisConfig(...)`.
- Add an internal config resolver that normalizes shortcuts into runtime-ready structures without making the resolved representation part of the primary public API for now.
- Add structured diagnostics with stable codes, severities, semantic paths, hints, related entries, and fix suggestions.
- Add diagnostic renderers that are separate from validation, including pretty terminal, plain text, compact, and JSON-oriented output.
- Add a `FentarisConfigError` that carries diagnostics and can format them without making ANSI strings the source of truth.
- Move broad semantic validation out of runtime constructors where practical, while keeping local constructor invariants for obviously invalid values.
- Cover config structure, scoped MCP catalog visibility, policy references, identity setup, credentials, transports, and scoped proxy handle registration.
- Defer schema-driven JSON/YAML config validation until a later change; this change stays focused on runtime TypeScript config.

## Capabilities

### New Capabilities

- `config-and-validation`: TypeScript-first config definition, semantic validation, internal resolution, structured diagnostics, and diagnostic rendering.

### Modified Capabilities

None.

## Impact

- Affects public exports for config helpers, diagnostics, formatter options, and `FentarisConfigError`.
- Affects `fentaris(...)`, `createProxy(...)`, `McpProxy`, `ServerCatalog`, group declarations, policy declarations, credentials, transports, and proxy scoped handles.
- Integrates with the scoped MCP catalog behavior and the extension API contracts introduced by separate changes.
- Adds tests for diagnostics as data and snapshot-style tests for pretty/plain renderer output.
- No new required runtime dependency should be added unless the implementation demonstrates that a small color/terminal capability helper is worth the tradeoff.
