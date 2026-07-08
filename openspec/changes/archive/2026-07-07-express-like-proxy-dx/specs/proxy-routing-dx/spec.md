## ADDED Requirements

### Requirement: Express-like middleware signature
The system SHALL support new middleware handlers that receive `(ctx, next)`.

#### Scenario: New middleware continues
- **WHEN** `proxy.use(async (ctx, next) => next())` is registered
- **THEN** Fentaris executes it for matching operations and continues to the next handler

#### Scenario: New middleware short-circuits
- **WHEN** new middleware returns a tool result or denial response
- **THEN** Fentaris stops the remaining route pipeline and returns that response to the MCP client

### Requirement: Global tool routing
The system SHALL allow applications to register global tool handlers with public `server.tool` pattern strings.

#### Scenario: Exact tool pattern matches
- **WHEN** `proxy.tool("github.create_issue", handler)` is registered and `github__create_issue` is called
- **THEN** Fentaris runs the handler before forwarding the call upstream

#### Scenario: Server wildcard matches
- **WHEN** `proxy.tool("github.*", handler)` is registered and any GitHub tool is called
- **THEN** Fentaris runs the handler for that GitHub tool call

#### Scenario: Tool wildcard matches across servers
- **WHEN** `proxy.tool("*.search_*", handler)` is registered and a matching search tool is called on any server
- **THEN** Fentaris runs the handler for each matching call

### Requirement: Server-scoped routes
The system SHALL expose server handles that register scoped middleware and tool handlers.

#### Scenario: Server handle registers middleware
- **WHEN** `github.use(handler)` is registered
- **THEN** Fentaris runs the handler only for operations scoped to the GitHub upstream server

#### Scenario: Server handle registers tool handler
- **WHEN** `github.tool("create_issue", handler)` is registered and `github__create_issue` is called
- **THEN** Fentaris runs the handler for that tool call

### Requirement: Deterministic route ordering
The system SHALL execute matching middleware and route handlers in registration order.

#### Scenario: Global and server routes compose
- **WHEN** a global middleware is registered, then a server middleware is registered, then a global tool handler is registered
- **THEN** Fentaris executes the matching handlers in that registration order for a matching tool call

#### Scenario: Multiple tool handlers compose
- **WHEN** multiple matching tool handlers call `next()`
- **THEN** Fentaris runs each handler once and then forwards the call upstream

### Requirement: Tool route behavior scope
The system SHALL treat tool routes as tool-call handlers unless explicitly extended by a future API.

#### Scenario: Tool route does not run for list operation
- **WHEN** `proxy.tool("github.*", handler)` is registered and a client lists tools
- **THEN** Fentaris does not execute the tool route handler for the list operation

### Requirement: Policy remains authorization source
The system SHALL keep group-owned policy as the primary authorization model while route handlers provide runtime behavior.

#### Scenario: Policy denies before upstream forwarding
- **WHEN** group policy denies a tool call
- **THEN** Fentaris returns the policy denial without relying on `server.tool(..., requireGroup(...))` style runtime authorization

#### Scenario: Tool route validates allowed call
- **WHEN** group policy allows a tool call and a matching tool route validates arguments
- **THEN** Fentaris runs the route validation before forwarding the allowed call upstream
