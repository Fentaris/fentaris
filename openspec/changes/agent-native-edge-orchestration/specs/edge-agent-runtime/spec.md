## MODIFIED Requirements

### Requirement: Edge package and operator CLI

Fentaris SHALL provide a publishable `@fentaris/edge` package and a `fentaris edge` operator command domain covering one-command device join, persistent service lifecycle, status, metadata management, disconnect, and local or remote revocation without independently defining MCP servers. The existing `fentaris-edge` entry point SHALL remain compatible during the documented migration period.

#### Scenario: Edge join succeeds
- **WHEN** a user runs `fentaris edge join <control-plane>` and completes browser or device authorization
- **THEN** the agent enrolls the device, records permitted descriptive metadata, configures persistent operation when supported, starts synchronization, and processes pending cloud-defined setup

#### Scenario: Edge status is requested
- **WHEN** a user runs `fentaris edge status`
- **THEN** the CLI reports enrollment, service, connection, desired deployment, readiness, blocked-action, reconnect, and version summaries without printing secrets or private paths

#### Scenario: Legacy entry point is used
- **WHEN** a user invokes a supported `fentaris-edge` lifecycle command during the migration period
- **THEN** it preserves compatible behavior and points to the equivalent `fentaris edge` command without changing device identity

#### Scenario: Unsupported add command
- **WHEN** a user attempts to add an MCP definition through either edge CLI surface
- **THEN** the CLI explains that MCP definitions and assignments are managed by Fentaris

### Requirement: Edge disconnect and reconnect behavior

The gateway and agent SHALL make connection loss explicit, clean up in-flight work, and allow only validated reconnection by the same enrolled device; a persistent agent SHALL retry transient connection failures with bounded exponential backoff and jitter.

#### Scenario: Connection drops during request
- **WHEN** the edge channel closes before an MCP operation completes
- **THEN** Fentaris fails or marks the operation indeterminate according to operation safety metadata and the agent cleans up or expires orphaned work after reconnect

#### Scenario: Same device reconnects
- **WHEN** the enrolled device proves its credential and receives a new connection generation
- **THEN** it reconciles current desired state before accepting new MCP operations and resets reconnect backoff after a stable connection

#### Scenario: Different device attempts takeover
- **WHEN** another enrolled edge attempts to resume a session-target binding pinned to a different edge node
- **THEN** the gateway rejects the takeover

#### Scenario: Reconnect is repeatedly rejected
- **WHEN** authentication, revocation, or protocol incompatibility makes reconnect non-transient
- **THEN** the agent stops automatic retry or backs off to the configured terminal interval and reports an actionable local status

## ADDED Requirements

### Requirement: Attributed device metadata and presence reporting

The edge agent SHALL report authenticated observed facts, heartbeat freshness, load, capacity, agent version, and deployment readiness separately from user-managed descriptions and control-plane-managed grants or pool membership.

#### Scenario: Agent connects with observed facts
- **WHEN** an enrolled edge establishes a current connection
- **THEN** it reports its supported protocol, agent version, platform, architecture, execution features, and capacity using bounded versioned fields

#### Scenario: User description conflicts with observed fact
- **WHEN** a user-managed tag claims a capability that the current agent does not report or the deployment cannot provide
- **THEN** Fentaris preserves the descriptive tag but does not treat it as observed readiness or an authorization fact

