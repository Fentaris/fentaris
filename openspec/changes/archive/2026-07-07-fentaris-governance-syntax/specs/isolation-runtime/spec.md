## ADDED Requirements

### Requirement: Per-user isolation runtime
The system SHALL provide an Isolation runtime that queues and executes tool calls per user with configurable timeouts.

#### Scenario: Queue a tool call for isolation
- **WHEN** isolation is enabled for a server and a user issues concurrent calls
- **THEN** calls are queued per user and executed according to isolation limits

### Requirement: Concurrency limits
The system SHALL allow configuring maximum concurrency per user or per server.

#### Scenario: Enforce concurrency limit
- **WHEN** the concurrency limit is reached
- **THEN** additional calls are queued or rejected based on configuration
