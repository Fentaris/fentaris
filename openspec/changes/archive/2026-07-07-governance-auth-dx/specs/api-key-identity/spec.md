## ADDED Requirements

### Requirement: API-key identity strategy
The system SHALL provide an API-key identity strategy that authenticates callers using a configured request header and resolves the key to a declared user subject.

#### Scenario: Valid API key
- **WHEN** a request includes a valid API key in the configured header
- **THEN** Fentaris resolves the API key to its configured user id and authenticates the request

#### Scenario: Missing API key
- **WHEN** a request does not include an API key and the strategy is required
- **THEN** Fentaris returns an unauthorized MCP error and does not call upstream servers

#### Scenario: Invalid API key
- **WHEN** a request includes an API key that is not present in encrypted auth storage
- **THEN** Fentaris returns an unauthorized MCP error and does not call upstream servers

### Requirement: API keys are stored encrypted
The system SHALL store user API keys or verifiable API-key hashes in encrypted local credentials storage.

#### Scenario: Resolve encrypted API key owner
- **WHEN** Fentaris validates a request API key
- **THEN** Fentaris compares it against encrypted auth storage and resolves the owning user id without requiring user id headers

#### Scenario: API key not exposed to middleware
- **WHEN** Fentaris resolves a request API key
- **THEN** Fentaris does not expose the raw API key value to middleware, hooks, logs, or policy callbacks

### Requirement: Multiple API keys per user
The system SHALL allow a user to have multiple active API keys.

#### Scenario: Rotate user API key
- **WHEN** a user has old and new active API keys in encrypted auth storage
- **THEN** Fentaris authenticates requests using either key until the old key is removed

### Requirement: Trusted user id identity remains explicit
The system SHALL allow existing trusted user id identity strategies only when explicitly configured.

#### Scenario: Trusted internal header
- **WHEN** a developer explicitly configures a trusted user id header strategy
- **THEN** Fentaris resolves identity from that header but does not treat it as the recommended secure local default
