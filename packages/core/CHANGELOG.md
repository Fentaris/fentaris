# @fentaris/core

## 0.6.1

### Patch Changes

- 97ed1cb: Load runtime port and path defaults from the nearest project `fentaris.json` when starting an app without explicit options.

## 0.6.0

### Minor Changes

- 2a952cf: Add app-level fluent governance declarations with `app.policy(...)`, `app.group(...).users(...)`, and named group policy assignment.
- c8023e5: Add cloud-ready local secrets management with a `SecretsBackend` abstraction, `fentaris secrets list`, `manifest`, `doctor`, and `unset` commands, plus a committable `.fentaris/secrets.manifest.json` schema.

### Patch Changes

- 8e20832: Fix secrets manifest generation and local secrets presence checks.

  Generated projects now allow `.fentaris/secrets.manifest.json` to be committed while keeping local secret files ignored, and `fentaris secrets manifest` creates the auth directory before writing the manifest. The local secrets backend no longer reports arbitrary user-scoped credentials as present when a user only has API keys.

## 0.5.1

### Patch Changes

- 192dd8b: Allow policies to reference upstream MCP servers registered later through `app.mcp(...)`, with final policy server visibility validation deferred until startup.

## 0.5.0

### Minor Changes

- ced04e2: Improve the generated project and runtime DX: `fentaris()` now picks up local project defaults, deferred MCP declarations can satisfy policy validation before start, scoped middleware receives contextual types, and a concise `rateLimit({ max, per })` helper is available.

  `fentaris dev` now runs the configured entrypoint directly, loads `.env`, and forwards termination signals to the child process.

## 0.4.0

### Minor Changes

- ab74382: Add approval decision helpers on middleware context and enrich tool approval requests with operation metadata while preserving tool names, proxy names, arguments, and raw MCP params.
- f2d29f2: Expose placeholder plugin contracts from `@fentaris/core/experimental/plugins` and document that plugin support is experimental and not runtime-ready.
- 683ae94: Add runtime lifecycle and health APIs with typed health checks, lifecycle state inspection, timeout handling, built-in health reports, and profiler events.

### Patch Changes

- fa23cad: Fix runtime lifecycle cleanup, repeated explicit exposure registration, and recovered health readiness transitions.

## 0.3.0

### Minor Changes

- be8e9e1: Add TypeScript-first config validation APIs, structured diagnostics, diagnostic renderers, and automatic high-level startup validation.

### Patch Changes

- a2cd723: Add the runtime profiler API, typed runtime events, structured runtime errors, redacted sink dispatch, and automatic proxy instrumentation.

## 0.2.0

### Minor Changes

- de87ca4: Add the public `@fentaris/core/extensions` entrypoint for extension contract types and document supported API tiers for framework users.
- 94bfaf9: Add a scoped MCP server catalog with group-scoped server declarations and group-scoped proxy handles.

## 0.1.1

### Patch Changes

- 1a37457: Fix the exported plugin context type so lint passes cleanly in release CI.
