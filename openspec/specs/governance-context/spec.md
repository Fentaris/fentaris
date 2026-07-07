# governance-context Specification

## Purpose
TBD - created by archiving change improve-proxy-context-dx. Update Purpose after archive.
## Requirements
### Requirement: Subject domain mirrors declared subject metadata
The system SHALL expose declared non-sensitive subject metadata through `ctx.subject` after identity and group resolution.

#### Scenario: Declared metadata is readable
- **WHEN** a declared user includes email, tenant metadata, and custom metadata
- **THEN** handlers can read those values from `ctx.subject.email`, `ctx.subject.tenant`, and `ctx.subject.metadata`

#### Scenario: Group memberships are normalized
- **WHEN** a subject belongs to one or more groups
- **THEN** `ctx.subject.groups` contains normalized group membership metadata and `ctx.subject.hasGroup(groupId)` checks membership by id

### Requirement: Policy domain supports capability checks
The system SHALL allow handlers to ask whether the current subject can call a specific server/tool pair through `ctx.policy.can(server, tool)`.

#### Scenario: Capability check uses current subject groups
- **WHEN** `ctx.policy.can("github", "delete_repo")` is called for a grouped subject
- **THEN** Fentaris evaluates the subject's effective group policies for the requested server/tool pair

#### Scenario: Capability check uses global policy
- **WHEN** no groups are configured but a global policy is configured
- **THEN** `ctx.policy.can(server, tool)` evaluates that global policy for the current subject

#### Scenario: Capability check does not expose internals
- **WHEN** `ctx.policy.can(server, tool)` returns a boolean
- **THEN** the helper does not expose raw policy internals, raw credentials, or decrypted secret values

### Requirement: Policy decision metadata remains inspectable
The system SHALL keep current request policy metadata inspectable under `ctx.policy`.

#### Scenario: Denied current request includes reason
- **WHEN** a current tool call is denied by policy
- **THEN** `ctx.policy.allowed` is `false`, `ctx.policy.reason` describes the denial, and `ctx.policy.matchedPermissions` includes safe matched permission metadata where available

#### Scenario: Allowed current request includes matched groups
- **WHEN** a current tool call is allowed by an effective group policy
- **THEN** `ctx.policy.allowed` is `true` and `ctx.policy.matchedGroups` includes the matching group ids where available

### Requirement: Subject context
The system SHALL expose a resolved subject context to middleware, hooks, policy callbacks, approval callbacks, and logging helpers.

#### Scenario: Middleware reads subject
- **WHEN** middleware runs for an authenticated request
- **THEN** the context includes the resolved subject id, non-sensitive user metadata, group names, and tenant metadata

#### Scenario: Subject group helper
- **WHEN** middleware checks whether a subject belongs to a group
- **THEN** Fentaris provides a helper or equivalent API that returns membership without requiring direct group graph traversal

### Requirement: Policy context
The system SHALL expose effective policy metadata for the current request without exposing raw policy internals unnecessarily.

#### Scenario: Policy decision metadata
- **WHEN** policy evaluation completes for a tool call
- **THEN** middleware, hooks, logs, and error mapping can access the policy name, matched groups, matched server/tool permission metadata, and allow/deny reason

#### Scenario: Approval callback context
- **WHEN** an approval callback is invoked
- **THEN** Fentaris passes request, subject, groups, policy metadata, logger, timing metadata, and response helpers to the callback

### Requirement: Credential metadata without secret values
The system SHALL expose credential resolution metadata without exposing decrypted credential values in normal context.

#### Scenario: Credential source metadata
- **WHEN** upstream auth resolves a credential for a request
- **THEN** Fentaris can expose the credential reference and source type, such as user, group, or default, without exposing the credential value

#### Scenario: Secret value not available
- **WHEN** middleware or hooks inspect the governance context
- **THEN** raw decrypted credential values are not present in the public context object

### Requirement: Backward-compatible user context
The system SHALL provide a compatibility path for existing middleware that reads `context.user`.

#### Scenario: Existing middleware reads user id
- **WHEN** existing middleware reads `context.user.id`
- **THEN** Fentaris provides the resolved subject id during the compatibility period

#### Scenario: New middleware reads subject
- **WHEN** new middleware reads `context.subject`
- **THEN** Fentaris provides richer subject and group context than the legacy user object

