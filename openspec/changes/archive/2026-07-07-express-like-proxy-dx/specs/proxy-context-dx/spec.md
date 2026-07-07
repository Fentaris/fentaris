## ADDED Requirements

### Requirement: Unified proxy context
The system SHALL expose a unified proxy context object to new middleware, route handlers, events, approval callbacks, policy-adjacent helpers, and logging helpers.

#### Scenario: Tool call context includes normalized domains
- **WHEN** a tool call enters the proxy pipeline
- **THEN** the handler context includes operation, transport, subject, auth metadata, effective policy metadata, credential source metadata, selected server, selected tool, mutable arguments, raw MCP request data, request-local state, logger, and response helpers

#### Scenario: Tool list context omits selected tool
- **WHEN** a tool list operation enters the proxy pipeline
- **THEN** the handler context includes operation, transport, subject, auth metadata, policy metadata where available, credential source metadata where available, request-local state, logger, and response helpers without requiring selected server or tool fields

### Requirement: Structured subject and policy access
The system SHALL keep user, group, tenant, and permission information organized under structured context domains.

#### Scenario: Handler reads subject groups
- **WHEN** a handler checks the authenticated subject
- **THEN** it can read `ctx.subject.id`, `ctx.subject.groups`, `ctx.subject.tenant`, and `ctx.subject.hasGroup(groupId)` without traversing the group registry

#### Scenario: Handler reads policy outcome
- **WHEN** policy has been evaluated for a tool call
- **THEN** the handler can read `ctx.policy.allowed`, `ctx.policy.reason`, matched groups, matched permissions, and safe permission metadata

### Requirement: Safe authentication and credential context
The system SHALL expose authentication and credential metadata without exposing raw secret values through the public context.

#### Scenario: Handler reads auth metadata
- **WHEN** a request has been authenticated
- **THEN** the handler can read the identity strategy, authenticated state, user id, and non-sensitive auth metadata from `ctx.auth`

#### Scenario: Handler reads credential source
- **WHEN** upstream credentials have been resolved for a tool call
- **THEN** the handler can read credential reference and source metadata without access to decrypted credential values

### Requirement: Contextual logger
The system SHALL expose a contextual logger at `ctx.log` that enriches log entries with safe proxy metadata.

#### Scenario: Handler logs without repeating metadata
- **WHEN** a handler calls `ctx.log.info("validated")` during a tool call
- **THEN** Fentaris records the log with safe metadata such as operation, subject id, server name, tool name, transport type, and session id where available

#### Scenario: Logger redacts sensitive values
- **WHEN** a handler logs metadata that contains configured sensitive fields
- **THEN** Fentaris redacts those fields according to logger configuration

### Requirement: Response helper aliases
The system SHALL provide response helper methods on the unified context while preserving the response controller.

#### Scenario: Handler denies through context alias
- **WHEN** a handler returns `ctx.deny("blocked")`
- **THEN** Fentaris returns an MCP tool error response equivalent to `ctx.response.deny("blocked")`

#### Scenario: Handler injects agent guidance
- **WHEN** a handler calls `ctx.inject("Use read-only mode")` before continuing
- **THEN** Fentaris adds that guidance to the eventual tool result according to response injection behavior

### Requirement: Request-local state
The system SHALL provide a mutable request-local `ctx.state` object shared across handlers for the same operation.

#### Scenario: Middleware stores state for later handler
- **WHEN** an earlier handler sets `ctx.state.startedAt`
- **THEN** later handlers and events for the same operation can read that value without using global state

### Requirement: Compatibility aliases
The system SHALL preserve compatibility aliases for existing context consumers.

#### Scenario: Legacy user alias
- **WHEN** existing code reads `ctx.user.id`
- **THEN** Fentaris provides the compatible resolved user id during the migration period

#### Scenario: Legacy response alias
- **WHEN** existing code calls `ctx.res.deny("blocked")`
- **THEN** Fentaris handles it as an alias for the unified response controller
