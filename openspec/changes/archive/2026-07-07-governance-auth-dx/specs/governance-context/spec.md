## ADDED Requirements

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
