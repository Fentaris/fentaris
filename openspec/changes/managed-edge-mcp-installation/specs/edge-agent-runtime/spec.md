## MODIFIED Requirements

### Requirement: Versioned desired-state reconciliation

The edge agent SHALL treat acknowledged Fentaris desired state as the authority for which MCP deployments may run locally, including which MCP software versions are installed locally on its behalf.

#### Scenario: Desired deployment is added
- **WHEN** the edge receives a newer desired-state version containing an eligible deployment
- **THEN** it validates setup and consent, installs and verifies any declared managed package, reconciles the local workload, and acknowledges the applied or blocked state

#### Scenario: Desired deployment is removed
- **WHEN** a newer desired-state version removes a deployment
- **THEN** the edge stops its workloads, deletes non-retained deployment state, prunes managed installs that no remaining deployment references, and acknowledges removal

#### Scenario: Desired state is replayed
- **WHEN** the same desired-state version is delivered more than once
- **THEN** reconciliation is idempotent and does not duplicate processes, consent prompts, or package installations

### Requirement: Governed local process execution

The edge agent MUST enforce approved recipe identity, executable/package policy, managed install verification, setup readiness, concurrency limits, startup timeout, operation deadlines, output limits, and termination behavior before or during local process execution.

#### Scenario: Recipe is not approved
- **WHEN** desired state references a new recipe digest without required local consent
- **THEN** the agent blocks process startup

#### Scenario: Managed package is not allowlisted
- **WHEN** a recipe declares a managed install plan for a package outside the local package policy
- **THEN** the agent denies the installation before any registry fetch and blocks process startup

#### Scenario: Concurrency limit is reached
- **WHEN** a request would exceed the configured edge workload quota
- **THEN** the agent rejects or queues it according to declared policy and reports a structured capacity result

#### Scenario: Process ignores graceful shutdown
- **WHEN** a local MCP process does not exit within its shutdown deadline
- **THEN** the agent forcefully terminates it and emits a workload failure event

### Requirement: Edge observability and secret redaction

Edge logs, telemetry, and status output SHALL describe enrollment, setup, installation, and workload activity without exposing secrets, resolved local paths, package cache locations, or complete process environments.

#### Scenario: Setup or install event is logged
- **WHEN** the agent records a setup transition or a managed installation outcome
- **THEN** the record identifies the deployment, digests, status, and bounded reason category without secret values, resolved paths, or raw package-manager output

#### Scenario: Local status is requested
- **WHEN** an operator inspects local agent status
- **THEN** it summarizes desired, ready, blocked, and managed install counts without exposing install directories or credentials

#### Scenario: Workload fails
- **WHEN** a local MCP process fails to start or exits unexpectedly
- **THEN** the agent emits a redacted failure event that identifies the deployment and failure category
