## ADDED Requirements

### Requirement: Context-aware server catalog

The proxy SHALL resolve upstream MCP servers through a server catalog using the current user, resolved subject, group membership, and operation context.

#### Scenario: Global servers are resolved

- **WHEN** a proxy is configured with global `servers`
- **THEN** those servers are available to request contexts unless policy or governance denies their capabilities

#### Scenario: Group servers are resolved

- **WHEN** a resolved subject belongs to a group with scoped MCP servers
- **THEN** the catalog includes that group's scoped servers in list and routing operations for that subject

#### Scenario: Non-member cannot see group server

- **WHEN** a resolved subject does not belong to a group with scoped MCP servers
- **THEN** the catalog does not expose that group's scoped servers to the subject

### Requirement: Group server declaration shortcut

Group declarations SHALL support a `servers` shortcut that attaches MCP servers to the group scope while preserving the group policy and credential model.

#### Scenario: Group declares a server

- **WHEN** a group is declared with `servers: [mcp("linear", ...)]`
- **THEN** the proxy normalizes the server into a group-scoped catalog binding for that group

#### Scenario: Existing group declarations omit servers

- **WHEN** a group is declared without `servers`
- **THEN** the group continues to work with users, policy, credentials, and metadata as before

### Requirement: Group-scoped proxy handles

The proxy SHALL provide fluent group-scoped handles for middleware, route, and event registration.

#### Scenario: Group-scoped middleware matches member call

- **WHEN** `proxy.group("engineering").server("linear").use(handler)` is registered and an engineering subject calls a `linear` tool
- **THEN** the handler runs for that operation

#### Scenario: Group-scoped middleware ignores non-member call

- **WHEN** `proxy.group("engineering").server("linear").use(handler)` is registered and a non-engineering subject calls a shared `linear` server
- **THEN** the handler does not run for that operation

### Requirement: Shared server isolation

Shared MCP servers SHALL preserve group-specific behavior boundaries when the same server is available to multiple groups.

#### Scenario: Same server is bound to multiple groups

- **WHEN** the same MCP server name is available to multiple groups
- **THEN** each group's scoped middleware and hooks run only for subjects in that group

#### Scenario: Global and group scopes both reference a server

- **WHEN** a server name appears in both global and group scopes
- **THEN** proxy normalization handles the configuration deterministically and reports ambiguity if the routing model cannot safely distinguish the bindings

### Requirement: Runtime mutation remains deferred

The scoped server catalog SHALL be designed so runtime MCP add/remove can be introduced later without changing the public group-scoped declaration model.

#### Scenario: Initial scoped catalog ships

- **WHEN** the scoped catalog is implemented
- **THEN** it does not expose public runtime add/remove APIs unless capability-change semantics are also specified

#### Scenario: Future runtime add is designed

- **WHEN** a future change adds runtime MCP attachment
- **THEN** it can reuse scoped catalog bindings for global, group, tenant, user, or session scopes
