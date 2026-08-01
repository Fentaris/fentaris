## ADDED Requirements

### Requirement: Policy-filtered edge readiness discovery

Fentaris SHALL expose only non-sensitive deployment readiness and actionable setup categories needed for authorized device selection and orchestration while keeping grant identifiers, resolved paths, secret values, and denied private details outside agent-visible inventory.

#### Scenario: Ready deployment is discoverable
- **WHEN** an authorized agent inspects an eligible edge for a visible MCP deployment whose current recipe and setup schema are ready
- **THEN** Fentaris reports that deployment as callable with freshness and recipe-version metadata that does not reveal local grant values

#### Scenario: Setup is pending
- **WHEN** an otherwise eligible device has unresolved local setup for a visible deployment
- **THEN** Fentaris reports a bounded `setup-required` readiness category and a safe operator next action without exposing field values or private paths

#### Scenario: Deployment is hidden by policy
- **WHEN** a device has a ready deployment that is not visible or callable for the authenticated subject
- **THEN** inventory and orchestration discovery omit the deployment and do not reveal its readiness

### Requirement: Independent consent for multi-edge execution

Every device selected by a multi-edge operation MUST independently satisfy the current recipe approval, local grant, executable policy, and setup schema requirements before its child workload starts.

#### Scenario: Some devices are ready
- **WHEN** a fan-out resolves three devices and only two have valid consent and grants for the requested deployment
- **THEN** Fentaris starts child workloads only on the two ready devices and returns `EDGE_SETUP_REQUIRED` for the blocked child according to the declared failure policy

#### Scenario: Consent changes during orchestration
- **WHEN** a local user revokes a required grant while a multi-edge operation is active
- **THEN** that device stops the dependent child workload and reports a redacted terminal error without affecting consent or grants on sibling devices

