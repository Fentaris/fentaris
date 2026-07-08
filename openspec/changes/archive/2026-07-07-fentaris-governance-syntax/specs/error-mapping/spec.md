## ADDED Requirements

### Requirement: Standardized error mapping
The system SHALL map upstream and policy errors to MCP error responses with consistent error codes.

#### Scenario: Policy deny error mapping
- **WHEN** a policy denies a tool call
- **THEN** the response is an MCP error with a policy-specific error code and message

### Requirement: Explicit error injection API
The system SHALL provide an API to return structured MCP errors from middleware without throwing.

#### Scenario: Middleware fails a request
- **WHEN** middleware calls the error injection API with a code and message
- **THEN** the client receives a structured MCP error response
