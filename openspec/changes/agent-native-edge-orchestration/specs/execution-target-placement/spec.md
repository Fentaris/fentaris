## MODIFIED Requirements

### Requirement: Contextual and explainable edge device resolution

An edge target SHALL resolve only devices eligible for the authenticated subject, tenant, target selector, deployment, effective policy, current connection state, setup readiness, and capacity, and SHALL provide a redacted machine-readable explanation of applied constraints and preferences when requested.

#### Scenario: Subject default device is resolved
- **WHEN** an edge target uses `userDefaultDevice()` and the subject has one eligible online default device ready for the deployment
- **THEN** Fentaris resolves that enrolled device without exposing its physical identifier to application code

#### Scenario: Shared pool device is resolved
- **WHEN** an edge target selects a shared pool and multiple granted devices are healthy, ready, and within capacity
- **THEN** Fentaris applies the target's declared selection strategy only to eligible devices and can report the non-sensitive factors used

#### Scenario: Declarative requirements are resolved
- **WHEN** an authorized session supplies required capabilities and optional preferences for an edge target
- **THEN** Fentaris filters by hard eligibility and requirements before ranking remaining devices by preferences

#### Scenario: Client and edge identities differ
- **WHEN** a cloud-hosted downstream client invokes an MCP assigned to the subject's remote edge
- **THEN** Fentaris routes by the authenticated subject, target binding, and session binding rather than requiring the downstream client identity to match the edge identity

#### Scenario: No eligible device
- **WHEN** a target selector finds no eligible device
- **THEN** Fentaris returns a structured `EDGE_UNAVAILABLE` error with redacted unmet requirement categories and no private device inventory

## ADDED Requirements

### Requirement: Agent selection preserves session pinning

An explicit agent-requested target or device selection SHALL participate in normal eligibility checks and SHALL become immutable after the corresponding logical target is pinned for the downstream session.

#### Scenario: Eligible requested device is selected
- **WHEN** an authorized agent requests an eligible device before the target's first edge-dependent operation
- **THEN** Fentaris pins that device through the existing session-binding contract

#### Scenario: Requested device becomes ineligible before pinning
- **WHEN** the requested device disconnects, loses readiness, or becomes unauthorized before the first operation
- **THEN** Fentaris fails selection with a structured error and does not silently substitute another device

#### Scenario: Agent changes a pinned selection
- **WHEN** an agent requests another device for a target already pinned in the current session
- **THEN** Fentaris rejects the change and preserves the original pin until session end

### Requirement: Multi-edge child placement bindings

Fentaris SHALL create isolated child placement bindings for explicit multi-edge execution so each resolved device receives its own correlated workload context without mutating the parent session's bindings.

#### Scenario: Fan-out resolves multiple devices
- **WHEN** an authorized orchestration call resolves three eligible devices
- **THEN** Fentaris creates three uniquely correlated child bindings associated with the parent request and target

#### Scenario: Parent session ends during fan-out
- **WHEN** the downstream parent session ends while child calls remain active
- **THEN** Fentaris propagates cancellation and releases every child binding and dependent workload according to lifecycle policy

#### Scenario: One child device reconnects
- **WHEN** a child binding's device disconnects and reconnects with a new connection generation during the operation
- **THEN** Fentaris applies existing no-silent-failover semantics to that child without changing sibling bindings

