## ADDED Requirements

### Requirement: Runtime Lifecycle Interface
The system SHALL expose official lifecycle methods on the main Fentaris runtime object for starting, waiting for readiness, stopping, inspecting state, and retrieving health.

#### Scenario: Lifecycle methods are available
- **WHEN** a user creates a runtime with `fentaris(config)`
- **THEN** the returned object exposes `start`, `ready`, `stop`, `state`, and `health` lifecycle methods

#### Scenario: Start reaches ready
- **WHEN** a user calls `start()` and startup succeeds
- **THEN** the runtime transitions through starting state and reaches ready state

### Requirement: Runtime State Machine
The system SHALL track runtime lifecycle states as `created`, `starting`, `ready`, `degraded`, `stopping`, `stopped`, and `failed`.

#### Scenario: State is inspectable
- **WHEN** a user calls `state()`
- **THEN** the runtime returns the current lifecycle state with safe runtime metadata

#### Scenario: Failed startup
- **WHEN** startup fails before readiness
- **THEN** the runtime enters failed state and exposes the normalized failure reason

### Requirement: Graceful Startup And Shutdown
The system SHALL support configurable startup and shutdown timeouts and SHALL cleanly close runtime resources during shutdown.

#### Scenario: Startup timeout
- **WHEN** startup exceeds the configured startup timeout
- **THEN** startup fails with a normalized timeout error and the runtime enters failed state

#### Scenario: Shutdown closes resources
- **WHEN** a user calls `stop()`
- **THEN** the runtime closes exposure transports, downstream sessions, and owned runtime resources before entering stopped state

### Requirement: Health Configuration API
The system SHALL allow health behavior to be configured through both a `health()` builder and a simple object configuration.

#### Scenario: Builder health check
- **WHEN** a user configures `health().check("database", handler)`
- **THEN** the named check is included in runtime health reports

#### Scenario: Object health config
- **WHEN** a user configures `{ checks: true, include: ["runtime", "mcp"] }`
- **THEN** the runtime enables the requested built-in health categories

### Requirement: Health Check Context
The system SHALL provide health check handlers with a typed context for safe runtime, server, group, transport, policy, auth, and identity inspection.

#### Scenario: Server ping through context
- **WHEN** a health check calls `ctx.server("linear").ping()`
- **THEN** the runtime performs a safe server ping or returns an explicit unsupported/unknown result

#### Scenario: Server state through context
- **WHEN** a health check calls `ctx.server("linear").state()`
- **THEN** the runtime returns the known lifecycle/availability state for that server

#### Scenario: Group server inspection
- **WHEN** a health check calls `ctx.group("engineering").servers()`
- **THEN** the runtime returns safe metadata for servers visible to that group

### Requirement: Structured Health Results
The system SHALL normalize health check results into structured reports with status, duration, timestamp, message, metadata, and normalized error fields.

#### Scenario: Successful custom check
- **WHEN** a custom health check returns `{ status: "ok" }`
- **THEN** the runtime includes an ok result with name, duration, and checked timestamp

#### Scenario: Throwing custom check
- **WHEN** a custom health check throws
- **THEN** the runtime includes a down or degraded result with a normalized error instead of crashing the full health report

### Requirement: Built-In Health Checks
The system SHALL support conservative built-in health checks for runtime state, MCP server availability, transport exposure state, and scoped group/server visibility.

#### Scenario: Runtime built-in check
- **WHEN** runtime health is requested with runtime checks enabled
- **THEN** the report includes the current runtime lifecycle state

#### Scenario: MCP built-in check
- **WHEN** MCP health checks are enabled
- **THEN** the report includes one result per configured or scoped MCP server with safe availability metadata

### Requirement: Health Report Aggregation
The system SHALL aggregate individual health checks into an overall status of `ok`, `degraded`, `down`, or `unknown`.

#### Scenario: One degraded check
- **WHEN** at least one check is degraded and none are down
- **THEN** the overall health status is degraded

#### Scenario: One down check
- **WHEN** at least one required check is down
- **THEN** the overall health status is down

### Requirement: Profiler Lifecycle Events
The system SHALL emit profiler events for lifecycle transitions when a profiler is configured.

#### Scenario: Ready event
- **WHEN** the runtime reaches ready state
- **THEN** the profiler receives a runtime ready event with startup duration and safe runtime metadata

#### Scenario: Stop event
- **WHEN** shutdown completes
- **THEN** the profiler receives a runtime stop event with shutdown duration and final state metadata

### Requirement: Profiler Health Events
The system SHALL emit profiler events for health checks and health status reports when a profiler is configured.

#### Scenario: Health check event
- **WHEN** a health check runs
- **THEN** the profiler receives start and success/error events for that check

#### Scenario: Health status event
- **WHEN** a health report is completed
- **THEN** the profiler receives a health status event with overall status and safe summary metadata

### Requirement: Health Check Timeouts
The system SHALL support timeout-bound health checks so a slow check cannot hang the full health report indefinitely.

#### Scenario: Check timeout
- **WHEN** a health check exceeds its configured timeout
- **THEN** the runtime marks the check as down or degraded with a normalized timeout error

### Requirement: Code Comments For Lifecycle And Health Boundaries
The implementation SHALL add targeted code comments at non-obvious lifecycle controller, health context, server ping, and profiler event boundaries and SHALL NOT add broad public documentation pages as part of this change.

#### Scenario: Boundary comments added
- **WHEN** lifecycle and health internals are implemented
- **THEN** concise comments explain the responsibilities and separation between lifecycle, health checks, profiler events, and future resilience features
