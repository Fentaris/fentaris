## Purpose

Defines how a Fentaris application securely exposes and operates a complete Edge control plane so enrolled computers can join, receive application-owned MCP assignments, and serve governed sessions without application-authored gateway infrastructure.

## ADDED Requirements

### Requirement: Integrated control-plane exposure
Fentaris SHALL allow an application to explicitly enable an integrated Edge control plane that serves device authorization, token refresh, enrollment, revocation, and authenticated WebSocket gateway operations alongside the normal MCP exposure without requiring application-authored route handlers or store wiring.

#### Scenario: Integrated Edge is enabled
- **WHEN** a valid application enables the integrated Edge control plane and starts
- **THEN** the configured Edge base path accepts the documented join and gateway protocol while the existing MCP endpoint remains available

#### Scenario: Integrated Edge is disabled
- **WHEN** an application does not enable the integrated Edge control plane
- **THEN** Fentaris exposes no device authorization, enrollment, revocation, or Edge WebSocket routes implicitly

#### Scenario: Edge path conflicts with another route
- **WHEN** the configured Edge base path overlaps the MCP endpoint or another owned exposure route
- **THEN** startup fails with a structured configuration diagnostic before either route becomes ready

### Requirement: Explicit device-code authorization
The integrated control plane MUST keep every device-code request pending until an authorized human or trusted external authorization adapter explicitly approves the exact unexpired request for its tenant, and it MUST bound polling, lifetime, failed attempts, and approval replay.

#### Scenario: New computer requests authorization
- **WHEN** an unenrolled Edge begins the join flow
- **THEN** Fentaris returns a short-lived device code, user code, verification URI, polling interval, and expiry without granting device access

#### Scenario: Code has not been approved
- **WHEN** the Edge polls a valid pending device code
- **THEN** the control plane returns a pending or slow-down result and does not issue access or refresh tokens

#### Scenario: Authorized operator approves the code
- **WHEN** an authorized operator approves the exact pending code before expiry
- **THEN** the next conforming poll receives short-lived access credentials scoped to the approved tenant and enrollment operation

#### Scenario: Code is expired, denied, or replayed
- **WHEN** a device code is expired, denied, already consumed, or submitted outside its approved tenant
- **THEN** the control plane rejects authorization without revealing another request or issuing credentials

### Requirement: Device-bound enrollment and gateway authentication
The integrated control plane MUST bind enrollment and every accepted gateway generation to the approved tenant, random device credential, enrolled public key, proof of key possession, current token state, and server-side device record; hostnames, IP addresses, forwarded headers, and self-reported metadata MUST NOT establish identity or authorization.

#### Scenario: Enrollment proof is valid
- **WHEN** an approved Edge submits its public key and a valid proof over the enrollment challenge
- **THEN** Fentaris creates or resumes the authorized device record and returns a credential plus the configured gateway URL

#### Scenario: Gateway proof is valid
- **WHEN** an enrolled Edge opens the gateway and proves its key and current device credential
- **THEN** Fentaris negotiates the supported Edge protocol and binds a new monotonically increasing connection generation

#### Scenario: Credential or proof is invalid
- **WHEN** enrollment or gateway authentication contains an unknown, revoked, mismatched, expired, replayed, or cryptographically invalid credential or proof
- **THEN** Fentaris rejects the request, returns no enumerable device detail, and emits a redacted security event

#### Scenario: Device is revoked
- **WHEN** an authorized operator or the enrolled device revokes the device
- **THEN** refresh credentials are invalidated, the current gateway generation is closed, new connections are rejected, and server-side enrollment remains auditable without retaining recoverable secret values

### Requirement: Automatic application-owned desired state
Fentaris SHALL derive versioned per-device desired state from the application's registered MCP transports, setup schemas, Edge placements, subject membership, device and deployment authorization, and current installation contracts, and SHALL publish only deployments eligible for that device without requiring application-side recipe compilation or publication.

#### Scenario: Application starts with an eligible Edge deployment
- **WHEN** an MCP declaration has a valid Edge placement and an enrolled device satisfies its selector and authorization
- **THEN** Fentaris compiles the current setup and launch identity into that device's desired state with a stable deployment identifier and version

#### Scenario: Newly enrolled device becomes eligible
- **WHEN** Fentaris is already running and a new device enrolls or reconnects into an eligible named target, user default, or pool
- **THEN** the control plane reconciles and sends the current desired state before routing new MCP work to that device

#### Scenario: Caller cannot use a deployment on the device
- **WHEN** placement, catalog visibility, policy, subject assignment, or device authorization does not permit a deployment on a device
- **THEN** that deployment is absent from the device's desired state and cannot be inferred from inventory or version changes

#### Scenario: Effective declaration changes before restart
- **WHEN** application configuration changes the recipe, setup schema, installation recipe, assignment, or removal and the application restarts
- **THEN** the reconciler publishes a strictly newer desired version for affected devices and replay remains idempotent

#### Scenario: Assignment cannot be resolved safely
- **WHEN** placement or adapter state is ambiguous, stale, or insufficient to prove device eligibility
- **THEN** Fentaris withholds the deployment and reports a bounded diagnostic rather than assigning it broadly

### Requirement: Reconciliation ordering and dispatch safety
The integrated control plane MUST serialize desired-state publication per device, persist or durably coordinate the acknowledged version, and route MCP operations only when the current connection generation, desired recipe, local setup, readiness, and capability manifest agree.

#### Scenario: Device connects during reconciliation
- **WHEN** an Edge gateway connection becomes authenticated while desired state is being computed
- **THEN** Fentaris sends one coherent current version or follows it with a newer version without allowing a stale version to overwrite it

#### Scenario: Device reports stale readiness
- **WHEN** readiness or a capability manifest references an older desired recipe or connection generation
- **THEN** Fentaris rejects it for dispatch eligibility and preserves the current desired state

#### Scenario: Control plane restarts
- **WHEN** an integrated control plane restarts with protected local or managed state
- **THEN** reconnecting devices receive the current idempotent desired state and prior connection generations cannot resume routing

### Requirement: Protected single-process mode and managed adapters
Fentaris SHALL provide a documented single-process mode backed by owner-protected local state for development and small self-hosted deployments, and SHALL preserve replaceable durable authorization, token, inventory, desired-state, presence, readiness, capability, session, and channel adapters for managed multi-instance deployments.

#### Scenario: Local mode initializes
- **WHEN** local mode starts with a writable protected auth directory
- **THEN** Fentaris creates or loads server identity and enrollment state with owner-only permissions and excludes recoverable credentials from application source and ordinary diagnostics

#### Scenario: Local mode is restarted
- **WHEN** the same local application restarts
- **THEN** enrolled device identity, revocation, approval consumption, desired versions, and aliases survive while active presence and connection generations are safely re-established

#### Scenario: Managed mode lacks required adapter guarantees
- **WHEN** managed or multi-instance mode is configured with an in-memory, non-atomic, or non-distributed adapter where durable coordination is required
- **THEN** startup fails or remains unready with a diagnostic naming the missing consistency category

### Requirement: Confidential and bounded control-plane responses
The integrated control plane MUST bound request bodies, polling, codes, metadata, collections, frames, output, and error detail and MUST NOT expose device credentials, refresh tokens, signing keys, raw access tokens, private keys, local grants, local paths, environment values, inaccessible devices, or complete desired-state contents to unauthorized callers.

#### Scenario: Malformed or oversized request arrives
- **WHEN** an authorization, enrollment, revocation, token, or gateway request exceeds its schema or configured limit
- **THEN** Fentaris rejects it before state mutation with a stable sanitized error

#### Scenario: Unauthorized caller probes a device
- **WHEN** a caller requests enrollment, revocation, inventory, or gateway behavior for a device it cannot access
- **THEN** the response does not confirm whether the target device or credential exists

#### Scenario: Control-plane event is logged
- **WHEN** authorization, enrollment, reconciliation, connection, revocation, or failure occurs
- **THEN** telemetry contains bounded correlation and outcome metadata with all credential and local-only values redacted
