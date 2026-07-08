# app-governance-dx Specification

## Purpose
TBD - created by archiving change app-policy-group-dx. Update Purpose after archive.
## Requirements
### Requirement: App-level policy declaration
Fentaris SHALL allow applications to declare named policies through the app-level fluent API.

#### Scenario: Declaring a readonly policy
- **WHEN** an application calls `app.policy("readonly").mcp("github").allow("read")`
- **THEN** Fentaris registers a named `readonly` policy whose permissions allow the `read` tool on the `github` MCP server

#### Scenario: Reusing a policy declaration
- **WHEN** an application calls `app.policy("readonly")` more than once
- **THEN** Fentaris returns the same named policy declaration for additional fluent permission configuration

### Requirement: App-level group declaration
Fentaris SHALL allow applications to declare groups through the app-level fluent API.

#### Scenario: Declaring group users
- **WHEN** an application calls `app.group("guests").users(user("guest"))`
- **THEN** Fentaris registers a `guests` group containing the `guest` user

#### Scenario: Appending group users
- **WHEN** an application calls `app.group("maintainers").users(user("alice")).users(user("bob"))`
- **THEN** Fentaris registers a `maintainers` group containing both `alice` and `bob`

### Requirement: Named policy assignment
Fentaris SHALL allow fluent groups to attach policies by name when the policy is declared through `app.policy(...)`.

#### Scenario: Assigning a named policy to a group
- **WHEN** an application declares `app.policy("readonly").mcp("github").allow("read")` and `app.group("guests").users(user("guest")).policy("readonly")`
- **THEN** requests from `guest` are evaluated with the `readonly` policy

#### Scenario: Missing named policy
- **WHEN** an application calls `app.group("guests").users(user("guest")).policy("missing")`
- **THEN** Fentaris reports a configuration diagnostic before serving requests

### Requirement: Config-first governance compatibility
Fentaris SHALL preserve existing governance declarations through `fentaris({ policy, groups })`, `policy(...)`, and `group(...)` while supporting app-level declarations.

#### Scenario: Existing config-first app
- **WHEN** an application uses `fentaris({ groups: [group({ id: "guests", users: [user("guest")], policy: policy("readonly").mcp("github").allow("read") })] })`
- **THEN** Fentaris evaluates governance exactly as before

#### Scenario: Mixed config-first and fluent app
- **WHEN** an application declares some groups in `fentaris({ groups })` and additional groups through `app.group(...)`
- **THEN** Fentaris evaluates all configured and fluently declared groups together

### Requirement: Deferred fluent validation
Fentaris SHALL validate app-level policy and group declarations with the existing configuration validation lifecycle.

#### Scenario: Policy references deferred MCP server
- **WHEN** an application calls `app.policy("readonly").mcp("github").allow("read")` before calling `app.mcp("github", options)`
- **THEN** Fentaris accepts the fluent declaration and validates server visibility before start or in-process operations

#### Scenario: Empty fluent group
- **WHEN** an application declares `app.group("guests").policy("readonly")` without users
- **THEN** Fentaris reports a configuration diagnostic before serving requests

