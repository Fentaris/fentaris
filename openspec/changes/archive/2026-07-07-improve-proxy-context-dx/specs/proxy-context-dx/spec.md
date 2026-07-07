## ADDED Requirements

### Requirement: Context domains are stable across operations
The system SHALL construct `ctx.auth`, `ctx.policy`, `ctx.credentials`, `ctx.transport`, `ctx.response`, and `ctx.state` for every unified proxy context, regardless of whether the operation is a tool call, tool list, session start, or session end.

#### Scenario: Session context has structured domains
- **WHEN** a session lifecycle event handler receives `ctx`
- **THEN** `ctx.auth`, `ctx.policy`, `ctx.credentials`, `ctx.transport`, `ctx.response`, and `ctx.state` are present

#### Scenario: Tool list context has no selected tool
- **WHEN** a tools list handler receives `ctx`
- **THEN** `ctx.server` and `ctx.tool` may be absent while structured context domains remain present

### Requirement: Subject access follows authentication resolution
The system SHALL attach `ctx.subject` only when a request has been resolved to a declared subject or equivalent trusted subject record.

#### Scenario: Authenticated subject is available
- **WHEN** identity resolution maps a request to a declared user
- **THEN** `ctx.subject` contains the resolved subject and group memberships

#### Scenario: Missing subject remains explicit
- **WHEN** identity resolution is absent, optional, or fails without producing a subject
- **THEN** `ctx.subject` is absent rather than an anonymous placeholder object

### Requirement: Structured domains avoid raw secrets
The system SHALL keep raw API keys, decrypted credentials, bearer tokens, and environment secret values out of the public structured context domains.

#### Scenario: Handler inspects context
- **WHEN** middleware, routes, hooks, or events inspect `ctx.subject`, `ctx.auth`, `ctx.policy`, and `ctx.credentials`
- **THEN** those domains contain only non-sensitive metadata and credential source references
