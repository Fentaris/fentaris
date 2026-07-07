## ADDED Requirements

### Requirement: Structured subject domain
The system SHALL expose resolved subject information under `ctx.subject` as the primary subject access pattern for new middleware, route handlers, hooks, and approval-adjacent handlers.

#### Scenario: Authenticated handler reads subject fields
- **WHEN** a request is authenticated and resolved to a declared subject
- **THEN** the handler can read `ctx.subject.id`, `ctx.subject.email`, `ctx.subject.metadata`, `ctx.subject.tenant`, and `ctx.subject.groups`

#### Scenario: Handler checks group membership
- **WHEN** a resolved subject belongs to the `admins` group
- **THEN** `ctx.subject.hasGroup("admins")` returns `true`

#### Scenario: Generic middleware handles unauthenticated request
- **WHEN** a request has not been resolved to a subject
- **THEN** `ctx.subject` is absent and `ctx.auth.authenticated` indicates whether edge authentication succeeded

### Requirement: Structured auth domain
The system SHALL expose edge authentication metadata under `ctx.auth` without exposing raw credential values or API keys.

#### Scenario: Authenticated request exposes auth metadata
- **WHEN** a request is authenticated by an identity strategy
- **THEN** `ctx.auth.authenticated` is `true` and `ctx.auth.strategy`, `ctx.auth.userId`, and non-sensitive `ctx.auth.metadata` are available where resolved

#### Scenario: Unauthenticated request exposes auth state
- **WHEN** a request is not authenticated
- **THEN** `ctx.auth.authenticated` is `false` and raw credentials are not present on `ctx.auth`

### Requirement: Structured policy domain
The system SHALL expose effective authorization metadata under `ctx.policy` for the current operation.

#### Scenario: Tool call reads policy decision
- **WHEN** policy evaluation completes for a tool call
- **THEN** the handler can read `ctx.policy.allowed`, `ctx.policy.reason`, `ctx.policy.matchedGroups`, and `ctx.policy.matchedPermissions`

#### Scenario: Tools list reads policy domain
- **WHEN** a tools list operation builds context before a selected tool exists
- **THEN** `ctx.policy` is still present with matched group and permission arrays defaulting to empty arrays where no decision exists

### Requirement: Policy capability helper
The system SHALL provide `ctx.policy.can(server, tool)` to check whether the current subject is allowed to call a server/tool pair under the configured policy model.

#### Scenario: Subject can call allowed tool
- **WHEN** the current subject belongs to a group whose effective policy allows `github.delete_repo`
- **THEN** `ctx.policy.can("github", "delete_repo")` returns `true`

#### Scenario: Explicit deny overrides allow
- **WHEN** one effective group policy allows `github.delete_repo` and another effective group policy denies it
- **THEN** `ctx.policy.can("github", "delete_repo")` returns `false`

#### Scenario: Missing allow denies when policy is configured
- **WHEN** policy or group policy is configured and no effective permission allows `github.delete_repo`
- **THEN** `ctx.policy.can("github", "delete_repo")` returns `false`

#### Scenario: No policy preserves permissive runtime behavior
- **WHEN** no global policy and no group policies are configured
- **THEN** `ctx.policy.can("github", "delete_repo")` returns `true`

### Requirement: Compatibility aliases remain available
The system SHALL preserve existing context aliases while recommending the structured domains for new code.

#### Scenario: Existing middleware reads legacy aliases
- **WHEN** existing middleware reads `ctx.user`, `ctx.policyDecision`, or `ctx.res`
- **THEN** Fentaris provides behavior compatible with the existing public API

#### Scenario: New middleware uses structured domains
- **WHEN** new middleware reads `ctx.subject`, `ctx.auth`, and `ctx.policy`
- **THEN** Fentaris provides the same resolved runtime information through the structured domain fields
