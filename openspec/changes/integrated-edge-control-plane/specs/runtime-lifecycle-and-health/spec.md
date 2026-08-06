## ADDED Requirements

### Requirement: Integrated Edge lifecycle ownership
When the integrated Edge control plane is enabled, the Fentaris runtime SHALL own authorization services, protected state, desired-state reconciliation, gateway exposure, active connections, and their cleanup as one ordered application lifecycle.

#### Scenario: Integrated Edge startup succeeds
- **WHEN** protected state, adapters, authorization services, reconciliation, HTTP routes, and the gateway become ready within the startup deadline
- **THEN** the Fentaris runtime reaches ready and reports the Edge control plane as available

#### Scenario: Required Edge component fails during startup
- **WHEN** an enabled required Edge component cannot initialize or bind safely
- **THEN** startup rolls back already-created Edge resources, the runtime enters failed state, and no partial enrollment endpoint remains available

#### Scenario: Runtime stops with connected Edges
- **WHEN** the application stops while Edge devices or requests are active
- **THEN** Fentaris stops new authorization and enrollment, drains or cancels bounded work, closes current gateway generations, persists terminal state, and releases owned resources before entering stopped state

### Requirement: Integrated Edge health reporting
Fentaris SHALL expose bounded health checks for integrated Edge exposure, authorization and token services, protected state, adapter guarantees, gateway reachability, connection freshness, protocol distribution, reconciliation lag, desired-state acknowledgements, readiness, and stale capability manifests without disclosing protected values.

#### Scenario: Control plane is healthy
- **WHEN** required routes are bound, adapters satisfy their configured mode, reconciliation is current, and the gateway can accept supported devices
- **THEN** health reports an ok Edge control-plane result with safe version and count metadata

#### Scenario: Reconciliation is stale
- **WHEN** desired state has not been published or acknowledged within configured bounds for an otherwise connected eligible device
- **THEN** health reports a degraded or down result with a safe next action and no desired-state payload

#### Scenario: Incompatible agents are connected
- **WHEN** connected Edge agents cannot negotiate the protocol revision required by assigned deployments
- **THEN** health reports bounded incompatible-version counts and upgrade guidance without enumerating unauthorized devices

#### Scenario: Local reference mode is inspected
- **WHEN** health runs against the documented local single-process mode
- **THEN** it reports the mode and its non-multi-instance limitation as a warning rather than misclassifying configured local use as managed production readiness
