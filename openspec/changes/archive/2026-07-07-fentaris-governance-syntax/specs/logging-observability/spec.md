## ADDED Requirements

### Requirement: Pluggable logger drivers with auto-logging
The system SHALL support logger drivers and an auto-log pipeline for requests, responses, and timing metrics.

#### Scenario: Auto-log tool call
- **WHEN** auto-logging is enabled and a tool call is executed
- **THEN** the logger records request, response, and duration with user context

### Requirement: Lifecycle hooks for observability
The system SHALL emit lifecycle hooks for session start, session end, and tool call failures.

#### Scenario: Session end hook
- **WHEN** a client session closes
- **THEN** the session-end hook is emitted with session and user metadata
