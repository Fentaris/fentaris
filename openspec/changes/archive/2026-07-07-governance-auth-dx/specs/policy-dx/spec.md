## ADDED Requirements

### Requirement: First-class Policy API
The system SHALL provide a `Policy` API that is the primary developer-facing policy abstraction.

#### Scenario: Create policy with fluent server permissions
- **WHEN** a developer declares a policy using fluent server, allow, and deny helpers
- **THEN** Fentaris converts the declaration into executable tool permissions for policy evaluation and tool discovery filtering

#### Scenario: Allow all policy
- **WHEN** a developer assigns `Policy.allowAll()` to a group
- **THEN** Fentaris allows all tools on all configured servers for subjects in that group unless another effective policy explicitly denies the call

### Requirement: Tool permission helpers
The system SHALL provide concise helpers for allow, deny, limit, approval, and sensitive operation metadata.

#### Scenario: Permission with limiter
- **WHEN** a permission includes a limiter helper
- **THEN** Fentaris enforces the limiter during tool calls using the resolved subject and request context

#### Scenario: Permission with approval
- **WHEN** a permission includes an approval helper
- **THEN** Fentaris invokes the approval handler with request, subject, group, policy, timing, and logging context before forwarding the upstream call

#### Scenario: Sensitive permission metadata
- **WHEN** a permission is marked sensitive
- **THEN** Fentaris includes sensitive metadata in policy decisions and logs without changing allow/deny semantics by itself

### Requirement: Group policy evaluation
The system SHALL evaluate policies assigned to the authenticated subject's groups.

#### Scenario: Allowed by group policy
- **WHEN** a subject belongs to a group whose policy allows the requested server and tool
- **THEN** Fentaris permits the tool call unless an effective deny or failed approval/limit blocks it

#### Scenario: Denied by group policy
- **WHEN** any effective group policy explicitly denies the requested server and tool
- **THEN** Fentaris denies the tool call and does not call the upstream server

### Requirement: Policy conflict behavior
The system SHALL define deterministic behavior when multiple group policies match the same request.

#### Scenario: Deny overrides allow
- **WHEN** one group policy allows a tool and another effective group policy denies the same tool
- **THEN** Fentaris treats the request as denied

#### Scenario: Multiple matching limits
- **WHEN** multiple effective permissions add rate limits to the same request
- **THEN** Fentaris enforces all matching limits before forwarding the upstream call
