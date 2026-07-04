## ADDED Requirements

### Requirement: Edge package and minimal CLI

Fentaris SHALL provide a publishable `@fentaris/edge` package whose CLI covers device enrollment, status, disconnect, and local revocation without independently defining MCP servers.

#### Scenario: Edge login succeeds
- **WHEN** a user runs `fentaris-edge login` and completes browser or device authorization
- **THEN** the agent enrolls the device, starts synchronization, and processes pending cloud-defined setup

#### Scenario: Edge status is requested
- **WHEN** a user runs `fentaris-edge status`
- **THEN** the CLI reports connection, desired deployment, readiness, and blocked-action summaries without printing secrets or private paths

#### Scenario: Unsupported add command
- **WHEN** a user attempts `fentaris-edge add`
- **THEN** the CLI explains that MCP definitions and assignments are managed by Fentaris

### Requirement: Device-bound enrollment identity

Each edge installation SHALL use a random device identity backed by a locally protected keypair and SHALL NOT use a hostname, IP address, or hardware fingerprint as its authentication identity.

#### Scenario: New installation enrolls
- **WHEN** an unregistered edge completes login
- **THEN** the control plane creates an edge node bound to proof of the generated device key

#### Scenario: Hostname changes
- **WHEN** an enrolled computer changes its hostname
- **THEN** the device retains its edge node identity

#### Scenario: Copied configuration lacks key
- **WHEN** an attacker copies non-secret edge configuration without the protected device key
- **THEN** the copied installation cannot authenticate as the enrolled node

### Requirement: Authenticated outbound edge channel

The edge agent SHALL initiate an encrypted outbound connection and every accepted connection or message MUST be bound to the enrolled device, tenant, protocol version, and current connection generation.

#### Scenario: Device behind NAT connects
- **WHEN** an enrolled device has outbound network access but no inbound public port
- **THEN** it can establish the edge channel and receive desired state and MCP requests

#### Scenario: Message claims another deployment
- **WHEN** an authenticated edge sends a message for a tenant, deployment, session, or device outside its server-side grants
- **THEN** the gateway rejects the message and records a security event

#### Scenario: Old connection sends after reconnect
- **WHEN** a new validated connection generation replaces an older connection
- **THEN** messages from the older generation are rejected

### Requirement: Versioned desired-state reconciliation

The edge agent SHALL treat acknowledged Fentaris desired state as the authority for which MCP deployments may run locally.

#### Scenario: Desired deployment is added
- **WHEN** the edge receives a newer desired-state version containing an eligible deployment
- **THEN** it validates setup and consent, reconciles the local workload, and acknowledges the applied or blocked state

#### Scenario: Desired deployment is removed
- **WHEN** a newer desired-state version removes a deployment
- **THEN** the edge stops its workloads, deletes non-retained deployment state, and acknowledges removal

#### Scenario: Desired state is replayed
- **WHEN** the same desired-state version is delivered more than once
- **THEN** reconciliation is idempotent and does not duplicate processes or consent prompts

### Requirement: Session-isolated MCP process lifecycle

The initial edge runtime SHALL isolate each active MCP process by deployment and downstream session.

#### Scenario: Two sessions use one deployment
- **WHEN** two downstream MCP sessions invoke the same edge deployment
- **THEN** the agent uses distinct local MCP process/client instances for the sessions

#### Scenario: Session closes
- **WHEN** Fentaris reports downstream session end
- **THEN** the agent gracefully stops every process owned by that session and applies forced termination after the configured deadline

#### Scenario: Session is abandoned
- **WHEN** no valid activity or lease renewal occurs before the workload idle timeout
- **THEN** the edge terminates the orphaned process and reports cleanup

### Requirement: Governed local process execution

The edge agent MUST enforce approved recipe identity, executable/package policy, setup readiness, concurrency limits, startup timeout, operation deadlines, output limits, and termination behavior before or during local process execution.

#### Scenario: Recipe is not approved
- **WHEN** desired state references a new recipe digest without required local consent
- **THEN** the agent blocks process startup

#### Scenario: Concurrency limit is reached
- **WHEN** a request would exceed the configured edge workload quota
- **THEN** the agent rejects or queues it according to declared policy and reports a structured capacity result

#### Scenario: Process ignores graceful shutdown
- **WHEN** a local MCP process does not exit within its shutdown deadline
- **THEN** the agent forcefully terminates it and emits a workload failure event

### Requirement: Complete MCP operation forwarding

The edge channel SHALL forward supported MCP tool, resource, resource-template, prompt, completion, ping, cancellation, and result/error operations with correlated request and session context.

#### Scenario: Tool call succeeds
- **WHEN** Fentaris dispatches a governed tool call to a ready edge workload
- **THEN** the agent invokes the local MCP and returns the correlated MCP-compatible result through the normal proxy pipeline

#### Scenario: Resource read fails locally
- **WHEN** the local MCP returns an error for a resource read
- **THEN** Fentaris maps the correlated error through its existing normalized error and event pipeline

#### Scenario: Cloud operation is cancelled
- **WHEN** the downstream request is cancelled or exceeds its deadline
- **THEN** cancellation propagates to the edge workload and late results cannot satisfy another request

### Requirement: Edge disconnect and reconnect behavior

The gateway and agent SHALL make connection loss explicit, clean up in-flight work, and allow only validated reconnection by the same enrolled device.

#### Scenario: Connection drops during request
- **WHEN** the edge channel closes before an MCP operation completes
- **THEN** Fentaris fails the operation with `EDGE_UNAVAILABLE` and the agent cleans up or expires orphaned work after reconnect

#### Scenario: Same device reconnects
- **WHEN** the enrolled device proves its credential and receives a new connection generation
- **THEN** it reconciles current desired state before accepting new MCP operations

#### Scenario: Different device attempts takeover
- **WHEN** another enrolled edge attempts to resume a session-target binding pinned to a different edge node
- **THEN** the gateway rejects the takeover

### Requirement: Capability manifest reporting and caching

The edge agent SHALL report MCP capability manifests keyed by deployment and recipe digest, and Fentaris SHALL cache only validated manifests without changing public MCP names.

#### Scenario: Deployment becomes ready
- **WHEN** a local MCP initializes successfully
- **THEN** the edge reports its supported capabilities and Fentaris caches the manifest under the current recipe digest

#### Scenario: Edge is offline with cached manifest
- **WHEN** discovery occurs after a valid manifest was cached but the pinned edge is currently offline
- **THEN** Fentaris may return the stable cached capabilities while calls fail explicitly with `EDGE_UNAVAILABLE`

#### Scenario: No manifest exists
- **WHEN** an edge deployment has never initialized successfully
- **THEN** discovery returns no capabilities for that deployment and exposes non-sensitive readiness diagnostics

### Requirement: Local revocation overrides cloud state

The edge agent SHALL provide a local deny and revocation mechanism whose result takes precedence over desired state until the local user explicitly restores consent.

#### Scenario: Device disconnect is requested locally
- **WHEN** the user runs `fentaris-edge disconnect`
- **THEN** the agent closes the edge channel and stops workloads according to shutdown policy

#### Scenario: Deployment consent is revoked locally
- **WHEN** the user revokes an executable recipe or local grant
- **THEN** dependent workloads stop and later desired-state replay cannot restart them without renewed consent

### Requirement: Edge observability and secret redaction

Fentaris SHALL emit structured edge target, connection, setup, workload, request, duration, timeout, cancellation, and error events while redacting sensitive local data.

#### Scenario: Edge request completes
- **WHEN** an MCP operation completes through an edge target
- **THEN** profiler and audit events include subject, target, deployment, device alias or opaque ID, session, request, outcome, and duration metadata

#### Scenario: Setup or process fails
- **WHEN** an edge setup or process error contains paths, secrets, credentials, or full environment values
- **THEN** cloud and local structured logs replace those values with redacted metadata

### Requirement: Edge gateway adapter contracts

Fentaris SHALL expose replaceable contracts for edge connections, device/deployment state, capability manifests, and session bindings, with reference single-process implementations.

#### Scenario: Reference runtime is used
- **WHEN** a self-hosted application enables edge support without durable adapters
- **THEN** Fentaris uses documented in-memory stores and the reference edge gateway with single-instance limitations

#### Scenario: Managed cloud supplies adapters
- **WHEN** a deployment provides durable stores and a distributed channel broker
- **THEN** edge routing and desired-state reconciliation preserve the same public target and agent protocol semantics across Fentaris instances
