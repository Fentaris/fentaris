## ADDED Requirements

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
