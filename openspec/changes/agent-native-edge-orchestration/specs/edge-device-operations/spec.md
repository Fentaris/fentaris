## Purpose

Defines the operator and control-plane behavior required to join, describe, supervise, discover, and manage a dynamic fleet of Fentaris edge computers safely.

## ADDED Requirements

### Requirement: One-command edge join

Fentaris SHALL provide a join command that enrolls the current computer, records user-facing metadata, configures persistent agent operation when supported, establishes the outbound edge channel, and returns an actionable result without requiring manual MCP definition on the device.

#### Scenario: New computer joins interactively
- **WHEN** a user runs `fentaris edge join <control-plane>` with a name and description and completes device authorization
- **THEN** Fentaris enrolls the computer, installs or activates the local agent service, connects it to the control plane, and reports its stable device name and readiness

#### Scenario: Computer has no global Fentaris installation
- **WHEN** a user runs the documented `npx @fentaris/edge join <control-plane>` bootstrap command on a supported Node.js installation
- **THEN** the same join and service setup workflow completes without requiring a separate global package-install command

#### Scenario: Join cannot install a service
- **WHEN** the current platform or permissions do not permit service installation
- **THEN** the command completes enrollment without claiming persistent operation and returns an exact foreground start command as a next action

#### Scenario: Join is repeated
- **WHEN** an already enrolled installation runs the join command against its current control plane
- **THEN** Fentaris reuses its device-bound identity and reconciles metadata and service state without creating a duplicate device

### Requirement: Persistent edge agent service

The edge client SHALL support supervised background operation, start at system boot when installed as a service, reconnect after transient failure, and expose explicit install, start, stop, restart, and uninstall lifecycle operations.

#### Scenario: Computer restarts
- **WHEN** an enrolled computer with an installed edge service boots
- **THEN** the edge agent starts without an interactive login and reconnects using its protected device credential

#### Scenario: Control plane is temporarily unavailable
- **WHEN** the persistent agent loses connectivity to the control plane
- **THEN** it stops accepting new remote operations, cleans up affected work according to policy, and retries with bounded exponential backoff and jitter

#### Scenario: Service is uninstalled
- **WHEN** an operator uninstalls the edge service without revoking the device
- **THEN** persistent background operation is removed while the protected enrollment identity remains available for an explicit reinstall or foreground start

### Requirement: Durable descriptive device inventory

The control plane SHALL maintain a durable tenant-scoped inventory record for every enrolled device, with a stable opaque identity and separately attributed user-managed, agent-observed, and control-plane-managed metadata.

#### Scenario: User describes a development computer
- **WHEN** an authorized operator assigns a display name, description, and tags to an enrolled device
- **THEN** the inventory persists those fields as user-managed metadata without changing the device authentication identity

#### Scenario: Agent reports platform facts
- **WHEN** a connected edge reports operating system, architecture, agent version, and locally supported execution features
- **THEN** the control plane stores them as observed facts with capture time and does not represent them as user assertions or security grants

#### Scenario: Pool membership is managed
- **WHEN** an authorized administrator adds a device to a pool
- **THEN** the inventory records control-plane-managed membership independently from self-reported tags or capabilities

### Requirement: Dynamic presence, load, and readiness

Fentaris SHALL derive dynamic device availability from authenticated connection presence, heartbeat freshness, capacity signals, desired deployment readiness, and revocation state.

#### Scenario: Healthy device is available
- **WHEN** a non-revoked device has a current authenticated connection, fresh heartbeat, available capacity, and the requested deployment is ready
- **THEN** inventory and selection may report it as eligible for that deployment

#### Scenario: Heartbeat expires
- **WHEN** a device heartbeat exceeds the configured freshness window
- **THEN** Fentaris marks the device offline or stale and excludes it from new selections without deleting its inventory record

#### Scenario: Deployment setup is blocked
- **WHEN** a connected device lacks consent or local setup for a requested deployment
- **THEN** Fentaris reports non-sensitive blocked readiness and does not treat that deployment as callable on the device

### Requirement: Policy-filtered device management commands

Fentaris SHALL provide `fentaris edge list`, `get`, `status`, `update`, `disconnect`, `revoke`, and service lifecycle commands with human-readable output and canonical `--json` envelopes.

#### Scenario: Agent lists devices as JSON
- **WHEN** an authorized caller runs `fentaris edge list --as <identity> --compact --limit 20 --json`
- **THEN** the CLI returns a bounded canonical envelope containing only devices visible to that identity, pagination metadata, warnings, and safe next actions

#### Scenario: Device metadata is updated
- **WHEN** an authorized operator runs `fentaris edge update <device> --name <name> --description <text> --tag <tag> --json`
- **THEN** Fentaris updates only the permitted user-managed fields and returns the resulting inventory version

#### Scenario: Destructive command lacks confirmation
- **WHEN** a non-interactive caller requests device revocation without explicit confirmation
- **THEN** Fentaris refuses the mutation and returns a stable error with a safe command that includes the required confirmation flag

### Requirement: Production edge control-plane adapters

Fentaris SHALL expose durable adapter contracts for device inventory, presence, desired state, readiness, capability manifests, session bindings, selection coordination, and distributed channel routing while retaining documented in-memory adapters for development.

#### Scenario: Multi-instance control plane routes a request
- **WHEN** the proxy instance selecting a device is different from the gateway instance holding its active connection
- **THEN** the configured durable stores and channel broker route the request with the same authorization, correlation, cancellation, and result semantics

#### Scenario: Reference adapters are used
- **WHEN** an application enables Edge with in-memory reference adapters
- **THEN** Fentaris reports their single-process and non-durable limitations in diagnostics and does not represent the deployment as production-ready
