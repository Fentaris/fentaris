## ADDED Requirements

### Requirement: Identity resolution at the proxy edge
The system SHALL resolve UserContext from incoming HTTP requests using configurable identity strategies.

#### Scenario: Resolve user from headers
- **WHEN** a request includes identity headers configured by the proxy
- **THEN** the UserContext is populated with the resolved user id and metadata

### Requirement: Unauthorized handling
The system SHALL provide a configurable response when identity resolution fails.

#### Scenario: Missing identity
- **WHEN** identity resolution fails for a request that requires authentication
- **THEN** the proxy returns an unauthorized MCP error and does not call upstream servers
