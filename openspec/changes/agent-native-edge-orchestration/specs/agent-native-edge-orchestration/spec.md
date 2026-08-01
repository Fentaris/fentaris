## Purpose

Defines a governed MCP surface through which AI agents can discover eligible computers, select an execution destination, and invoke tools on one or many edge devices.

## ADDED Requirements

### Requirement: Edge Control MCP surface

Fentaris SHALL expose a bounded agent-native Edge Control MCP surface with stable tools for device listing, device inspection, session selection, single-edge invocation, and multi-edge invocation.

#### Scenario: Agent discovers Edge Control tools
- **WHEN** an authorized MCP client performs tool discovery
- **THEN** it receives the stable Edge Control tool schemas without receiving one duplicated copy of every upstream tool for every connected device

#### Scenario: Edge Control is denied by policy
- **WHEN** effective policy denies edge inventory or orchestration to the authenticated subject
- **THEN** the corresponding control tools are hidden or denied through the normal Fentaris capability-governance pipeline

### Requirement: Policy-filtered edge inventory discovery

The Edge Control surface SHALL let agents list and inspect only eligible devices using bounded filtering and pagination, returning descriptions and decision-relevant metadata without exposing credentials, private paths, physical identifiers, or inaccessible inventory.

#### Scenario: Agent searches for a suitable computer
- **WHEN** an agent lists devices filtered by tags, capabilities, platform, pool, status, or deployment readiness
- **THEN** Fentaris returns matching authorized devices with stable public names, concise descriptions, availability, relevant capabilities, and a continuation cursor

#### Scenario: Agent inspects one device
- **WHEN** an agent requests details for a visible device name
- **THEN** Fentaris returns attributed metadata, readiness, allowed tool/deployment summaries, and freshness timestamps without returning local grants or secrets

#### Scenario: Agent requests an inaccessible device
- **WHEN** an agent names a device outside its tenant, subject grants, catalog visibility, or policy
- **THEN** Fentaris returns a non-enumerating authorization error that does not confirm private device existence

### Requirement: Agent-requested session selection

An authorized agent SHALL be able to select an eligible logical target or device for subsequent transparent MCP calls before that target is pinned in the downstream session.

#### Scenario: Agent selects a device before first call
- **WHEN** an agent selects an eligible device for a logical target that has not yet been pinned in the current session
- **THEN** Fentaris records the requested selection and the first ordinary MCP call pins and uses that device

#### Scenario: Agent attempts to replace an active pin
- **WHEN** an agent selects a different device after the logical target is already pinned in the current session
- **THEN** Fentaris rejects the replacement and instructs the caller to start a new session rather than silently moving stateful work

### Requirement: Declarative device selection

The Edge Control surface SHALL accept required constraints and optional preferences and SHALL resolve them only against authorized, online, ready, and capacity-eligible devices.

#### Scenario: Requirements select one computer
- **WHEN** an agent requires `filesystem` and `xcode`, prefers low load, and exactly one eligible device satisfies the hard constraints
- **THEN** Fentaris selects that device and returns a redacted explanation identifying satisfied constraints and applied preferences

#### Scenario: No device satisfies requirements
- **WHEN** no authorized ready device satisfies all required constraints
- **THEN** Fentaris returns `EDGE_UNAVAILABLE` with unmet requirement categories and safe narrowing or setup next actions, without exposing private inventory

#### Scenario: Several devices tie
- **WHEN** multiple devices remain equally eligible after constraints and preferences
- **THEN** Fentaris applies the declared deterministic pool strategy and records the selection inputs and outcome for audit

### Requirement: Explicit single-edge tool invocation

The Edge Control surface SHALL support an explicit call envelope containing a visible edge selector, an effective MCP tool identifier, and that tool's arguments, while validating the arguments and enforcing normal visibility, authorization, policy, setup, deadline, and audit behavior before dispatch.

#### Scenario: Explicit call succeeds
- **WHEN** an agent invokes `edge_call` with an eligible device, an allowed effective tool, and schema-valid arguments
- **THEN** Fentaris executes the tool in a child execution context on that device and returns the MCP-compatible result together with selected-device and correlation metadata

#### Scenario: Tool arguments are invalid
- **WHEN** the explicit call arguments do not satisfy the effective tool input schema
- **THEN** Fentaris rejects the request before edge dispatch with a stable validation error and a next action for inspecting the tool schema

#### Scenario: Explicit call targets a hidden tool
- **WHEN** the subject can see a device but policy or catalog scope hides the requested MCP tool
- **THEN** Fentaris denies the call without revealing hidden tool or deployment details

### Requirement: Parallel multi-edge tool invocation

The Edge Control surface SHALL support invoking the same effective tool over an explicit device list or declarative selector set with bounded fan-out, bounded concurrency, a shared deadline, and a declared `collect` or `fail-fast` failure policy.

#### Scenario: Parallel calls all succeed
- **WHEN** an agent invokes `edge_call_many` over three eligible devices with a maximum concurrency of two
- **THEN** Fentaris runs no more than two child calls concurrently and returns one correlated success result per resolved device plus aggregate counts

#### Scenario: Collect mode has partial failures
- **WHEN** one child call fails and the failure policy is `collect`
- **THEN** Fentaris allows remaining calls to finish and returns a stable per-device result entry for every resolved device with aggregate success and failure counts

#### Scenario: Fail-fast mode encounters failure
- **WHEN** one child call fails and the failure policy is `fail-fast`
- **THEN** Fentaris cancels pending and cancellable in-flight child calls, preserves terminal results already received, and marks unstarted or cancelled entries explicitly

#### Scenario: Fan-out exceeds policy limit
- **WHEN** a request resolves more devices or concurrency than the caller's configured orchestration limits
- **THEN** Fentaris rejects the request before dispatch or requires an explicitly permitted bounded subset without silently widening execution

### Requirement: Isolated child execution contexts

Explicit single-edge and multi-edge calls SHALL use child execution contexts and per-device bindings that do not mutate or bypass the downstream session's transparent placement pin.

#### Scenario: Multi-edge call follows a transparent call
- **WHEN** the downstream session is pinned to one personal device and then invokes a multi-edge operation
- **THEN** every fan-out branch uses an isolated child binding while the original transparent session pin remains unchanged

#### Scenario: Child execution ends
- **WHEN** an explicit edge call completes, fails, expires, or is cancelled
- **THEN** Fentaris releases its child binding and associated edge workload according to lifecycle policy

### Requirement: Safe orchestration result contract

Edge Control invocation tools SHALL return structured results with stable status values, aggregate counts, per-device correlation identifiers, warnings, and actionable next actions, and SHALL preserve MCP content without mixing untrusted device output into routing fields.

#### Scenario: Mixed result set is returned
- **WHEN** a multi-edge invocation produces successes, failures, and cancellations
- **THEN** the structured result reports each resolved device exactly once with `succeeded`, `failed`, `cancelled`, or `not-started` status and reports consistent aggregate counts

#### Scenario: Device returns malformed output
- **WHEN** one edge returns an oversized, malformed, or non-serializable result
- **THEN** Fentaris records a bounded structured error for that child without corrupting other results or the aggregate envelope

### Requirement: Orchestration safety and audit

Every explicit or multi-edge operation MUST enforce per-device local consent and limits, MUST emit per-child and aggregate audit events, and MUST NOT automatically retry mutating tools unless policy and tool metadata establish safe idempotency.

#### Scenario: One device lacks local consent
- **WHEN** a multi-edge call includes a device where the deployment or local grant is not approved
- **THEN** that child returns `EDGE_SETUP_REQUIRED` and no workload starts on that device

#### Scenario: Broadcast operation is high impact
- **WHEN** policy classifies a multi-edge tool call as destructive or high impact
- **THEN** Fentaris requires the configured approval before dispatch and includes the resolved device count and scope in the approval context

#### Scenario: Mutating child loses connection
- **WHEN** a mutating tool call loses its edge connection after dispatch and no valid idempotency contract exists
- **THEN** Fentaris reports an indeterminate child outcome and does not retry it automatically on the same or another device

