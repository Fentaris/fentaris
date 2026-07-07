## Why

Fentaris's current proxy core is capable, but its developer surface is split across middleware, call hooks, list-tools hooks, lifecycle hooks, and separate request/context objects. Now that governance and transport work have established the runtime foundation, Fentaris needs a cohesive Express-like DX that makes proxy behavior easy to compose without leaking internal MCP routing details.

## What Changes

- Add a unified proxy context object for middleware, events, server routes, tool routes, policy callbacks, approval callbacks, and logging.
- Add Express-like middleware signatures that receive `(ctx, next)` while preserving compatibility with the existing `(request, context, next)` middleware signature.
- Add global tool routing with server/tool patterns such as `github.create_issue`, `github.*`, and `*.search_*`.
- Add server-scoped routing so configured server handles can register `.use(...)`, `.tool(...)`, and `.on(...)` behavior.
- Add a unified event system using names such as `session:start`, `session:end`, `tools:list:after`, `tool:start`, `tool:success`, and `tool:error`.
- Keep group-owned policy as the primary authorization model; tool/server middleware is for runtime behavior such as validation, mutation, audit, approval, and guardrails.
- Add contextual logger behavior through `ctx.log`, automatically enriched with safe request metadata.
- Preserve existing public APIs during migration, including `proxy.use(...)`, `proxy.on("call", ...)`, `proxy.onListTools(...)`, `proxy.onLifecycle(...)`, `ctx.user`, and `ctx.res`.

## Capabilities

### New Capabilities

- `proxy-context-dx`: Unified context shape, contextual logging, subject/policy/auth access, response helpers, and compatibility aliases.
- `proxy-routing-dx`: Express-like global and server-scoped middleware/tool routing with pattern matching.
- `proxy-events-dx`: Unified proxy and server-scoped event registration for sessions, tool calls, and tool listing.
- `proxy-migration-compat`: Backward-compatible adapters and migration behavior for the existing hook and middleware APIs.

### Modified Capabilities

None.

## Impact

- Affects `packages/core` public APIs around `McpProxy`, `McpServer` registration, middleware types, hook types, context types, response helpers, and exports.
- Affects docs for middleware, hooks, governance/auth, proxy setup, logger, and generated API reference.
- Requires tests for context shape, routing order, wildcard matching, server-local sugar, event ordering, contextual logging metadata, and compatibility with current APIs.
- Does not add a new transport protocol, replace group policy semantics, or remove the current public API in this change.
