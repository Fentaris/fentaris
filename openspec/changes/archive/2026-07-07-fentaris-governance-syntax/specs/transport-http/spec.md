## ADDED Requirements

### Requirement: HTTP transport adapter
The system SHALL provide an HttpTransport that implements listTools, callTool, and close over HTTP.

#### Scenario: Calling a tool over HTTP
- **WHEN** a tool call is made through HttpTransport
- **THEN** the transport performs an HTTP request and returns the upstream tool result

### Requirement: Auth headers for HTTP transport
The system SHALL support injecting auth headers or tokens for HTTP transport requests.

#### Scenario: Authenticated HTTP call
- **WHEN** HttpTransport is configured with an auth token
- **THEN** outbound requests include the configured authorization header
