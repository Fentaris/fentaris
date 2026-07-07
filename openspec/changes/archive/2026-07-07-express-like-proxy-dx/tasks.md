## 1. Context Model

- [x] 1.1 Define unified proxy context types for operations, transport metadata, subject, auth, policy, credentials, server, tool, args, raw request data, state, logger, and response helpers
- [x] 1.2 Add response helper aliases on the unified context for deny, fail, continue, inject, and error handling
- [x] 1.3 Add compatibility aliases for existing `ctx.user` and `ctx.res` behavior
- [x] 1.4 Implement context construction for tool call operations using the existing resolved user, subject, identity, policy decision, credential source, logger, and response controller data
- [x] 1.5 Implement context construction for list tools operations without requiring selected server or tool fields
- [x] 1.6 Ensure raw decrypted credentials and API keys are not attached to the unified context
- [x] 1.7 Add unit tests for context shape, subject helpers, policy metadata, credential metadata, response aliases, and request-local state sharing

## 2. Contextual Logging

- [x] 2.1 Add a helper that creates contextual child loggers from safe metadata on the unified context
- [x] 2.2 Enrich tool-call logs with operation, subject id, server name, tool name, proxy tool name, transport type, session id, and policy outcome where available
- [x] 2.3 Enrich list-tools and session logs with operation, subject id, transport type, and session id where available
- [x] 2.4 Preserve existing logger redaction behavior for metadata emitted through `ctx.log`
- [x] 2.5 Add tests proving handlers can call `ctx.log.info(...)` without manually passing standard proxy metadata

## 3. Middleware Dispatcher

- [x] 3.1 Define new middleware and route handler types using `(ctx, next)`
- [x] 3.2 Implement an internal route entry model that can represent global middleware, global tool routes, server middleware, and server tool routes
- [x] 3.3 Update the tool call pipeline to dispatch matching new handlers in deterministic registration order before forwarding upstream
- [x] 3.4 Ensure handlers that return a tool result or denial response short-circuit the remaining pipeline
- [x] 3.5 Preserve `next()` multiple-call protection for the new dispatcher
- [x] 3.6 Add tests for continuation, short-circuiting, handler ordering, and mixed global/server route ordering

## 4. Tool Pattern Matching

- [x] 4.1 Implement public tool pattern parsing for exact patterns such as `github.create_issue`
- [x] 4.2 Implement wildcard matching for server patterns such as `github.*`
- [x] 4.3 Implement wildcard matching for cross-server tool patterns such as `*.search_*`
- [x] 4.4 Translate public dot-pattern matches to internal server/tool names without exposing `<server>__<tool>` in the new DX
- [x] 4.5 Validate invalid patterns with clear startup or registration errors
- [x] 4.6 Add tests for exact matches, server wildcards, tool wildcards, non-matches, and invalid patterns

## 5. Server Handles

- [x] 5.1 Add a server handle type returned by `proxy.server(name, serverOrOptions?)`
- [x] 5.2 Support registering or retrieving an upstream server through the server handle API without breaking constructor-based `servers` configuration
- [x] 5.3 Implement `serverHandle.use(handler)` as scoped middleware for that server
- [x] 5.4 Implement `serverHandle.tool(toolPattern, handler)` as scoped tool routing for that server
- [x] 5.5 Implement `serverHandle.on(eventName, handler)` as scoped event registration for that server
- [x] 5.6 Add tests proving server handles only affect their server and compose with global proxy routes

## 6. Unified Events

- [x] 6.1 Define event name and event payload types for session, tool call, tool list, success, failure, and after events
- [x] 6.2 Implement `proxy.on(eventName, handler)` for new event names
- [x] 6.3 Implement `proxy.on(eventName, filter, handler)` for filtered tool/list/session events where applicable
- [x] 6.4 Emit `tool:start`, `tool:success`, `tool:error`, and `tool:after` from the tool call pipeline with unified context and timing metadata
- [x] 6.5 Emit `tools:list:after` from the list-tools pipeline and allow handlers to transform the returned tool list
- [x] 6.6 Emit `session:start` and `session:end` through the unified event bus from downstream exposure lifecycle hooks
- [x] 6.7 Add tests for event ordering, filtered events, server-scoped events, tool list transformation, and event payload metadata

## 7. Legacy Compatibility

- [x] 7.1 Adapt existing `(request, context, next)` middleware into the new dispatcher without changing observable behavior
- [x] 7.2 Preserve `proxy.on("call", handler)` and filtered `proxy.on("call", filter, handler)` behavior, including short-circuit results
- [x] 7.3 Preserve `proxy.onListTools(handler)` behavior and compose it predictably with `tools:list:after`
- [x] 7.4 Preserve `proxy.onLifecycle(event, handler)` behavior by bridging lifecycle events from the unified event bus
- [x] 7.5 Add tests for mixed legacy and new middleware registration order
- [x] 7.6 Add tests for legacy hooks coexisting with new events

## 8. Helper API And Exports

- [x] 8.1 Decide whether this change exports `fentaris(...)`, `mcp.*`, and `http(...)` helper aliases or leaves them for a follow-up
- [x] 8.2 Export new context, middleware, route, server handle, event, filter, and pattern types from `packages/core/src/index.ts`
- [x] 8.3 Keep existing constructor exports and type exports stable
- [x] 8.4 Add API-level tests or type tests for the recommended syntax examples

## 9. Documentation

- [x] 9.1 Update middleware docs to prefer `(ctx, next)` and show migration from `(request, context, next)`
- [x] 9.2 Update hooks docs to prefer unified events and server-scoped `.on(...)`
- [x] 9.3 Update governance/auth docs to show policy in groups and runtime behavior in `server.tool(...)`
- [x] 9.4 Update logger docs to explain contextual `ctx.log` enrichment and redaction
- [x] 9.5 Update proxy setup docs with a complete Express-like DX example
- [x] 9.6 Regenerate typed reference docs if required by the existing docs workflow

## 10. Verification

- [x] 10.1 Run `pnpm --filter @fentaris/core test`
- [x] 10.2 Run `pnpm --filter @fentaris/core build`
- [x] 10.3 Run `pnpm lint`
- [x] 10.4 Run `pnpm typecheck`
- [x] 10.5 Verify `openspec status --change "express-like-proxy-dx"` reports the change as apply-ready
