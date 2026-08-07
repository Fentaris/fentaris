## ADDED Requirements

### Requirement: Installation-aware desired-state reconciliation
The Edge agent SHALL reconcile installation recipes as part of cloud-defined desired state without allowing locally discovered or installed MCPs to become callable outside a Fentaris assignment.

#### Scenario: New installable deployment is assigned
- **WHEN** an Edge receives newer desired state containing an eligible MCP deployment and installation recipe
- **THEN** it reconciles installation, local setup, workload startup, and capability reporting in order and acknowledges the latest bounded lifecycle state

#### Scenario: Local software appears independently
- **WHEN** an executable or MCP is installed locally without a matching authorized desired deployment
- **THEN** the Edge does not publish, launch, or expose it through the Fentaris catalog

#### Scenario: Older Edge receives installation recipe
- **WHEN** an agent protocol version cannot validate or execute the requested installation recipe
- **THEN** the deployment reports agent-upgrade-required and no installation or workload execution occurs

### Requirement: Durable deployment lifecycle attempts
The Edge agent SHALL persist installation and deployment lifecycle state across service restarts, including current recipe digests, approvals, active attempt identity, terminal result, retryability, and activation state.

#### Scenario: Edge service restarts during installation
- **WHEN** the Edge agent restarts while a custom installer attempt was active
- **THEN** it cleans up or proves termination of the orphaned process tree, marks the interrupted attempt explicitly, and requires safe reconciliation before retry

#### Scenario: Edge reconnects after successful activation
- **WHEN** the Edge reconnects with a verified installation and ready deployment matching current desired state
- **THEN** it reports the persisted state and does not reinstall solely because the connection generation changed

### Requirement: Installation lifecycle status and controls
The Edge CLI and protected local control channel SHALL expose bounded per-deployment installation status, pending approvals, explicit retry, local denial, approval revocation, and safe cleanup actions without accepting arbitrary remote command execution.

#### Scenario: Operator inspects status
- **WHEN** a local operator requests Edge status
- **THEN** the result separates device presence, service state, installation state, setup state, workload readiness, and safe next actions for each deployment

#### Scenario: Remote caller requests retry
- **WHEN** a remote caller requests an installation retry without the required control-plane authorization or local consent state
- **THEN** the Edge rejects the mutation and does not execute an installer

#### Scenario: Operator reviews custom installer
- **WHEN** a custom installation is approval-required
- **THEN** the local interaction displays the exact bounded review material and records approval or denial without exposing protected source credentials

### Requirement: Installation telemetry and health
Edge telemetry and health diagnostics SHALL report installation reconciliation, approval, attempts, activation, rollback availability, cleanup, and failure using stable redacted metadata.

#### Scenario: Installation blocks selection
- **WHEN** a deployment is not ready because installation is incomplete or failed
- **THEN** health and inventory explain the bounded readiness category and device selection excludes that deployment

#### Scenario: Installation event contains sensitive data
- **WHEN** a provider error includes a token, private path, authenticated URL, environment value, script body, or raw process output
- **THEN** telemetry replaces it with a stable redacted reason and retains sensitive diagnostics only under bounded local policy

