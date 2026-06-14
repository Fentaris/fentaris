# @fentaris/core

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
