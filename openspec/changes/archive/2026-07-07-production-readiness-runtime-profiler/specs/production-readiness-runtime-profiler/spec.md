## ADDED Requirements

### Requirement: Profiler Configuration API
The system SHALL allow runtime profiling to be configured through both a composable `profiler()` builder and a simple object configuration accepted by the high-level Fentaris configuration.

#### Scenario: Builder profiler configuration
- **WHEN** a user passes `profiler().pretty().level("info").track("errors", "timeouts").sink(customSink)` into the Fentaris config
- **THEN** the runtime uses the configured preset, level, tracked categories, and sink without requiring manual logging calls

#### Scenario: Object profiler configuration
- **WHEN** a user passes `{ preset: "pretty", level: "warn", track: ["errors", "policy"] }` as profiler config
- **THEN** the runtime resolves it into equivalent profiler behavior

### Requirement: Typed Runtime Event Model
The system SHALL define runtime event names and payloads as TypeScript types so event names are discoverable and event handlers receive event-specific payload types.

#### Scenario: Event name autocomplete
- **WHEN** a developer calls `profiler().on(...)`
- **THEN** TypeScript exposes the supported runtime event names as literal event name suggestions

#### Scenario: Event payload narrowing
- **WHEN** a developer handles `"mcp.call.timeout"`
- **THEN** TypeScript exposes timeout-specific fields such as server, operation, timeout, and duration on the event payload

### Requirement: Automatic Runtime Instrumentation
The system SHALL automatically emit runtime events for lifecycle, MCP calls, policy decisions, transport failures, extension failures, timeout paths, and runtime errors.

#### Scenario: MCP call instrumentation
- **WHEN** a proxied MCP tool call starts and completes successfully
- **THEN** the profiler receives start and success events with operation, server, group, user, and duration metadata

#### Scenario: Policy decision instrumentation
- **WHEN** a policy allows or denies a request
- **THEN** the profiler receives a policy event with the decision, matched context, and safe reason metadata

### Requirement: Runtime Error Taxonomy
The system SHALL provide structured Fentaris runtime error classes for runtime, MCP, transport, policy, extension, and timeout failures.

#### Scenario: MCP failure normalization
- **WHEN** an upstream MCP server throws an unknown error
- **THEN** the runtime normalizes it into a Fentaris MCP error with a stable code, severity, cause, operation context, and hints where available

#### Scenario: Timeout failure normalization
- **WHEN** an operation exceeds its timeout
- **THEN** the runtime produces a Fentaris timeout error with timeout, duration, operation, server, group, and user context

### Requirement: Error Event Emission
The system SHALL emit typed profiler events for normalized runtime errors.

#### Scenario: Transport error event
- **WHEN** a downstream exposure transport fails while handling a request
- **THEN** the profiler receives a transport error event with redacted request/session context and the normalized error

#### Scenario: Extension error event
- **WHEN** a custom hook, sink, middleware, or extension throws
- **THEN** the profiler receives an extension error event that identifies the boundary and preserves the original cause

### Requirement: Pretty Runtime Error Rendering
The system SHALL support rendering normalized runtime errors in a human-readable terminal format without making the rendered text the source of truth.

#### Scenario: Pretty timeout rendering
- **WHEN** a timeout error is rendered for the terminal
- **THEN** the output includes the stable code, message, server, group, operation, timeout, duration, and actionable hint when available

#### Scenario: Structured error remains canonical
- **WHEN** the same error is sent to a machine-oriented sink
- **THEN** the sink receives the structured error data rather than parsing terminal output

### Requirement: Profiler Filtering
The system SHALL allow profiler output to be filtered by event category, severity/level, server, group, user, operation, and duration.

#### Scenario: Server and group filter
- **WHEN** a profiler is configured with a server and group filter
- **THEN** only events matching both scoped dimensions are delivered to the filtered sink or handler

#### Scenario: Slow operation filter
- **WHEN** a profiler is configured with a minimum duration filter
- **THEN** only events whose duration meets or exceeds the threshold are delivered to the filtered sink or handler

### Requirement: Profiler Sink Contract
The system SHALL expose a sink contract that allows runtime events to be written to built-in sinks and user-defined sinks.

#### Scenario: Custom sink receives events
- **WHEN** a user registers a custom sink
- **THEN** the sink receives structured runtime events that match the profiler track and filter configuration

#### Scenario: Multiple sinks receive events
- **WHEN** a profiler is configured with multiple sinks
- **THEN** each matching event is delivered to each sink without requiring duplicate runtime instrumentation

### Requirement: Logger Compatibility
The system SHALL preserve compatibility with the existing logger by adapting logger writes into the profiler/sink model where practical.

#### Scenario: Existing logger option still works
- **WHEN** a user configures the existing logger option without a profiler
- **THEN** current logging behavior remains available

#### Scenario: Logger as profiler sink
- **WHEN** a user configures profiler output to use the logger sink
- **THEN** profiler events are written through the existing logger driver shape with structured metadata

### Requirement: Runtime Lifecycle Readiness
The system SHALL expose minimal lifecycle readiness events and state for start, ready, degraded, stop, and runtime error conditions.

#### Scenario: Runtime ready event
- **WHEN** the proxy finishes startup successfully
- **THEN** the profiler receives a ready event with runtime identity and startup duration metadata

#### Scenario: Runtime degraded event
- **WHEN** a runtime component enters a degraded state without requiring immediate shutdown
- **THEN** the profiler receives a degraded event with component and reason metadata

### Requirement: Default Redaction
The system SHALL redact sensitive data from profiler events, normalized runtime errors, and sink payloads by default.

#### Scenario: Secret metadata redaction
- **WHEN** an event contains token, password, authorization, api key, credential, or secret fields
- **THEN** the sink receives redacted values unless redaction is explicitly disabled or customized

#### Scenario: Custom redaction rules
- **WHEN** a user provides custom redaction rules
- **THEN** the profiler applies those rules before dispatching matching events to sinks

### Requirement: Sink Failure Isolation
The system SHALL isolate profiler sink failures from normal runtime operation unless strict failure behavior is explicitly configured.

#### Scenario: Sink throws during event write
- **WHEN** a custom sink throws while handling an event
- **THEN** the runtime captures the sink failure as a profiler or extension error without crashing the original MCP operation by default

### Requirement: Code Comments For Architecture
The implementation SHALL add targeted code comments at non-obvious architecture boundaries and SHALL NOT add broad public documentation pages as part of this change.

#### Scenario: Architecture comments added
- **WHEN** the profiler, sink, event model, redaction, and error normalization boundaries are implemented
- **THEN** the code includes concise comments explaining their responsibilities and separation
