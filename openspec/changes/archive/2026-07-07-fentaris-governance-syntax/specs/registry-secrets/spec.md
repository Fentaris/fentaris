## ADDED Requirements

### Requirement: Registry interface for user data and secrets
The system SHALL define a Registry interface that can resolve user records and per-user secrets/tokens by user identity.

#### Scenario: Resolve secrets for a user
- **WHEN** a tool call needs user-specific credentials
- **THEN** the Registry returns the user record and secrets for that user id

### Requirement: Built-in registry implementations
The system SHALL ship a MemoryRegistry for development and a Redis-backed Registry for distributed deployments.

#### Scenario: Using a Redis-backed registry
- **WHEN** the Registry is configured with Redis storage
- **THEN** secrets are resolved from Redis and are available to policy and transport env injection
