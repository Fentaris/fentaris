## ADDED Requirements

### Requirement: Legacy middleware compatibility
The system SHALL continue to support middleware registered with the existing `(request, context, next)` signature.

#### Scenario: Existing middleware observes request
- **WHEN** existing middleware reads `request.serverName`, `request.toolName`, and `context.subject`
- **THEN** Fentaris provides values equivalent to the current public API

#### Scenario: Existing middleware denies request
- **WHEN** existing middleware returns `context.res.deny("blocked")`
- **THEN** Fentaris returns the same MCP tool error response as before

### Requirement: Legacy call hook compatibility
The system SHALL continue to support `proxy.on("call", ...)` and filtered `proxy.on("call", filter, ...)` handlers.

#### Scenario: Existing call hook runs
- **WHEN** an application registers `proxy.on("call", { server: "github" }, handler)`
- **THEN** Fentaris invokes the handler for matching GitHub tool calls with the existing request and context parameters

#### Scenario: Existing call hook short-circuits
- **WHEN** an existing call hook returns a tool result
- **THEN** Fentaris returns that result without forwarding the tool call upstream

### Requirement: Legacy list tools hook compatibility
The system SHALL continue to support `proxy.onListTools(handler)`.

#### Scenario: Existing list hook transforms tools
- **WHEN** `proxy.onListTools(handler)` returns a transformed tool array
- **THEN** Fentaris returns the transformed tool list as before

### Requirement: Legacy lifecycle hook compatibility
The system SHALL continue to support `proxy.onLifecycle(event, handler)`.

#### Scenario: Existing lifecycle hook runs
- **WHEN** `proxy.onLifecycle("sessionStart", handler)` is registered and a session starts
- **THEN** Fentaris invokes the handler with the existing lifecycle event and context shape

### Requirement: Mixed API composition
The system SHALL allow applications to combine legacy APIs and new Express-like APIs predictably.

#### Scenario: Legacy and new middleware compose
- **WHEN** an application registers both legacy middleware and new `(ctx, next)` middleware
- **THEN** Fentaris executes matching middleware in registration order

#### Scenario: Legacy hooks and new events coexist
- **WHEN** an application registers `proxy.on("call", legacyHandler)` and `proxy.on("tool:success", eventHandler)`
- **THEN** Fentaris invokes the legacy handler at its compatible point and emits the new success event after a successful call

### Requirement: Migration documentation
The system SHALL document the new API as recommended while preserving legacy API documentation for compatibility.

#### Scenario: Developer reads migration guide
- **WHEN** a developer reads the middleware and hooks documentation
- **THEN** the docs show how to translate legacy request/context handlers into unified context handlers
