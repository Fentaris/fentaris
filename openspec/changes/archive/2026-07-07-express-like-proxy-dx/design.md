## Context

Fentaris currently exposes a functional MCP proxy pipeline, but developers interact with it through several adjacent APIs: middleware receives `(request, context, next)`, targeted hooks use `proxy.on("call", ...)`, list transformations use `proxy.onListTools(...)`, lifecycle hooks use `proxy.onLifecycle(...)`, and response helpers live under `ctx.res`. Governance work has already introduced subjects, groups, policy decisions, credential metadata, and safe auth context. Transport work has separated the reusable proxy runtime from downstream exposure concerns.

This change builds on those foundations by making Fentaris feel like a small MCP application framework. The public API should let developers route behavior by server and tool, observe lifecycle and tool events consistently, and use one normalized context object everywhere.

## Goals / Non-Goals

**Goals:**

- Introduce a unified `ctx` object as the primary handler input for middleware, tool routes, events, policy-adjacent callbacks, approval callbacks, and logging helpers.
- Add Express-like middleware with `(ctx, next)` while adapting existing `(request, context, next)` middleware.
- Add global and server-scoped tool routing with pattern syntax that uses `server.tool` names instead of internal `<server>__<tool>` names.
- Add server handles that support `.use(...)`, `.tool(...)`, and `.on(...)` as scoped sugar over the same proxy pipeline and event bus.
- Add a unified event system that covers sessions, tool calls, tool listing, success, failure, and cleanup events.
- Keep group-owned policy as the durable authorization model and use tool/server middleware for runtime behavior.
- Provide a contextual `ctx.log` child logger enriched with safe request metadata.
- Preserve compatibility with current hooks, middleware, response helpers, and context aliases.

**Non-Goals:**

- Do not remove or break `proxy.use((request, context, next) => ...)`, `proxy.on("call", ...)`, `proxy.onListTools(...)`, or `proxy.onLifecycle(...)`.
- Do not move authorization policy out of `Group`/`Policy` declarations.
- Do not add new MCP transport protocols.
- Do not expose decrypted credential values through the unified context.
- Do not require applications to use the new `fentaris(...)`, `mcp.*`, or `http(...)` helper style if they prefer existing constructors.

## Decisions

### Use one proxy context as the primary handler surface

New handlers will receive `ctx` with normalized fields such as `operation`, `transport`, `subject`, `auth`, `policy`, `credentials`, `server`, `tool`, `args`, `raw`, `state`, `log`, and `response`. The context will include convenience aliases such as `ctx.deny(...)`, `ctx.fail(...)`, and `ctx.inject(...)` over `ctx.response`.

Alternative considered: keep `request` and `context` separate and add more fields to each. That preserves the current shape but keeps developers guessing which object owns server/tool/auth/policy information.

### Treat `ctx.subject`, `ctx.auth`, and `ctx.policy` as structured domains

Subject information will live under `ctx.subject`, authentication metadata under `ctx.auth`, and effective authorization metadata under `ctx.policy`. `ctx.user` remains as a compatibility alias, but new docs and examples should prefer `ctx.subject`.

Alternative considered: flatten fields such as `ctx.groups`, `ctx.permissions`, and `ctx.policyDecision` onto the root context. That is convenient for small examples but becomes noisy as governance metadata grows.

### Keep `ctx.log`

The context will expose `ctx.log` as a contextual child logger. Fentaris will enrich it with safe metadata such as operation, subject id, server name, tool name, proxied tool name, transport type, session id, request id, and policy outcome where available.

Alternative considered: require all logging through a proxy-level logger import. That reduces context size but forces applications to repeat metadata manually and increases inconsistent audit logs.

### Use policies for permissions and tool middleware for runtime behavior

Group-owned `Policy` remains the primary place to define who can call which server/tool. `proxy.tool(...)` and `server.tool(...)` handlers are for behavior around an allowed call: validation, argument shaping, approval, audit, rate limiting, runtime guardrails, and response injection.

Alternative considered: document `server.tool(..., requireGroup(...))` as the primary RBAC style. That would duplicate policy semantics and make durable permissions harder to inspect.

### Implement routing as ordered middleware entries

Global middleware, global tool routes, server middleware, and server tool routes will compile into one ordered route table. Matching routes run in registration order and call `next()` to continue. Tool routes match only `tools/call` operations unless explicitly extended later.

Alternative considered: dispatch server routes separately from proxy routes. That looks simpler internally but makes ordering less predictable when global and server-local behavior interact.

### Use `server.tool` pattern names in the public DX

Public pattern strings will use dot notation such as `github.create_issue`, `github.*`, and `*.search_*`. Fentaris will translate them to the internal namespaced MCP names used for client-facing tool names.

Alternative considered: expose `<server>__<tool>` in patterns. That mirrors MCP routing internals but leaks an implementation detail into user code.

### Make server handles scoped views over the proxy

`const github = proxy.server("github", transportOrServerOptions)` returns a server handle. `github.use(...)`, `github.tool(...)`, and `github.on(...)` register scoped behavior on the owning proxy. Internally this is equivalent to adding a server filter.

Alternative considered: keep only `proxy.on(..., { server })` and `proxy.tool("github.*", ...)`. That is sufficient but makes larger applications less modular.

### Unify events under `proxy.on(...)`

Events will use explicit names such as `session:start`, `session:end`, `tools:list:after`, `tool:start`, `tool:success`, `tool:error`, and `tool:after`. Server handles expose `.on(...)` as filtered sugar. Event payloads include `ctx` plus event-specific data such as `tools`, `result`, `error`, and `durationMs`.

Alternative considered: keep adding specialized methods such as `onListTools` and `onLifecycle`. That keeps each callback narrow but fragments the public API.

### Compatibility adapters stay explicit internally

The implementation will keep the old public APIs and adapt them into the new dispatcher. Legacy middleware receives projected `request` and `context` objects. Legacy `ctx.res` remains an alias for `ctx.response`. Legacy hooks keep their current ordering unless explicitly documented otherwise.

Alternative considered: introduce the new API as a breaking replacement. That would simplify internals but is not necessary for this milestone.

## Risks / Trade-offs

- Route ordering can become surprising when global and server-scoped handlers are mixed -> Document deterministic registration-order semantics and add tests for mixed ordering.
- Pattern matching can become too expressive too quickly -> Start with exact match and `*` wildcards for server/tool segments, then add richer matchers only if needed.
- A richer `ctx` can feel heavy -> Keep the root shape small and group related metadata under `subject`, `auth`, `policy`, `credentials`, `transport`, and `response`.
- Contextual logging could accidentally include sensitive values -> Use allowlisted metadata enrichment and keep raw credentials out of context.
- Compatibility adapters can hide migration issues -> Add deprecation-oriented docs and tests proving old and new APIs compose predictably.

## Migration Plan

1. Introduce the unified context types and build them inside the existing proxy runtime.
2. Add new middleware, route, event, and server-handle registration APIs while keeping existing APIs.
3. Adapt old middleware and hooks into the new dispatcher without changing their documented behavior.
4. Update docs to recommend the new API and mark legacy APIs as compatibility paths.
5. Add tests for both new APIs and mixed old/new usage.

Rollback is straightforward because this change is additive: remove the new exports and route/event adapters while leaving existing `McpProxy`, middleware, and hooks intact.

## Open Questions

- Should `fentaris(...)`, `mcp.stdio(...)`, `mcp.http(...)`, and `http(...)` helpers ship in the same change or remain documented aliases over existing constructors until a follow-up?
- Should event handlers be allowed to transform `tools:list:after` results only, or should future before/after events allow mutation more broadly?
- Should `ctx.policy.can(server, tool)` consult only the current effective policy snapshot, or trigger a fresh policy evaluation for arbitrary server/tool checks?
