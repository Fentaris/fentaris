## Purpose

Ensures a Fentaris runtime proves that every declared credential source is readable before exposing any downstream listener or Edge transport.

## ADDED Requirements

### Requirement: Declared credentials are ready before startup
The runtime SHALL resolve every credential source declared for defaults, groups, users, and user API-key identity before opening a transport.

#### Scenario: All sources available
- **WHEN** every declared local JSON and environment source resolves to a non-empty value
- **THEN** runtime startup continues normally

#### Scenario: One or more sources unavailable
- **WHEN** any declared source is missing, unreadable, or cannot be decrypted
- **THEN** startup fails before opening HTTP, Edge, or custom exposure transports

### Requirement: Credential readiness failures are sanitized and actionable
The runtime SHALL aggregate unavailable declarations without including decrypted or raw secret values.

#### Scenario: Several declarations fail
- **WHEN** multiple credential declarations cannot be resolved
- **THEN** one `FENTARIS_CREDENTIALS_UNAVAILABLE` error identifies each affected user, scope, or reference and suggests `fentaris secrets setup`

#### Scenario: Shared source fails
- **WHEN** multiple declarations use the same unavailable source
- **THEN** the diagnostics retain each affected declaration while avoiding repeated low-level failure details
