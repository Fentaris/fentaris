# edge-runtime-setup Specification

## Purpose
TBD - created by archiving change edge-execution-targets. Update Purpose after archive.
## Requirements
### Requirement: Typed runtime references

Fentaris SHALL allow serializable runtime input and secret references in supported `stdio` argument and environment positions while preserving existing plain-string configuration.

#### Scenario: Runtime folder argument is declared
- **WHEN** a `stdio` argument contains `runtime.input("workspace")`
- **THEN** Fentaris records a versioned reference that can be resolved before process launch

#### Scenario: Runtime secret environment value is declared
- **WHEN** a `stdio` environment entry contains `runtime.secret("token")`
- **THEN** Fentaris records a secret reference without serializing its resolved value into the MCP definition

#### Scenario: Existing stdio strings are used
- **WHEN** all `stdio` command, argument, and environment values are plain strings
- **THEN** existing cloud execution behavior remains unchanged

### Requirement: MCP setup schema

An MCP handle SHALL support a setup schema describing every runtime reference required to launch that MCP.

#### Scenario: Setup fields match runtime references
- **WHEN** every runtime reference has one compatible setup field and no unused required field exists
- **THEN** configuration validation accepts the MCP setup

#### Scenario: Runtime reference is undeclared
- **WHEN** a launch recipe references `workspace` but the MCP setup schema does not declare it
- **THEN** configuration validation reports the missing field and reference location

#### Scenario: Setup field type is incompatible
- **WHEN** a runtime secret reference is bound to a non-secret setup field
- **THEN** configuration validation rejects the mismatch

### Requirement: Supported setup field types

The initial setup schema SHALL support folder, file, secret, string, boolean, number, and select fields with required state and safe presentation metadata.

#### Scenario: Folder setup field
- **WHEN** an MCP declares `workspace: edge.folder({ access: "read-write" })`
- **THEN** the edge setup provider requests a local directory grant with the declared access

#### Scenario: Select setup field
- **WHEN** an MCP declares a select field with an allowed value set
- **THEN** the setup provider accepts only a value from that set

#### Scenario: Unsafe secret default
- **WHEN** a setup schema attempts to embed a secret default in cloud-visible configuration
- **THEN** validation rejects the secret value

### Requirement: Cloud target unresolved-input validation

Fentaris SHALL refuse to start an MCP on a cloud target when its launch recipe contains runtime references without cloud-side resolutions.

#### Scenario: Edge-only folder is placed in cloud
- **WHEN** an MCP requiring a local folder grant resolves to the cloud target without a cloud value
- **THEN** startup or pre-dispatch validation returns an actionable unresolved runtime input error

#### Scenario: Cloud value is explicitly supplied
- **WHEN** every runtime reference has a valid cloud-side value
- **THEN** Fentaris compiles the recipe and executes it on the cloud target

### Requirement: Cloud-driven edge setup

The control plane SHALL derive pending setup from desired MCP deployments and SHALL send unresolved setup requirements to the enrolled edge.

#### Scenario: Device enrolls with assigned MCPs
- **WHEN** an edge completes login and has desired MCP deployments with unresolved setup fields
- **THEN** it receives those requirements and invokes its local setup provider

#### Scenario: MCP is assigned after login
- **WHEN** the control plane assigns a new MCP deployment to an already enrolled edge
- **THEN** the edge begins setup without requiring the user to log in again

#### Scenario: Edge CLI attempts to add MCP
- **WHEN** a user attempts to configure an independent MCP definition through the edge CLI
- **THEN** the CLI rejects the operation because desired MCP definitions are controlled by Fentaris

### Requirement: Local grant confidentiality

Resolved local filesystem paths and edge-local secret values SHALL remain on the edge unless a setup field is explicitly defined as cloud-visible and non-sensitive.

#### Scenario: Folder grant is completed
- **WHEN** the user approves a local directory
- **THEN** the edge stores the canonical path locally and reports only an opaque grant reference, schema digest, and readiness state

#### Scenario: Secret is completed
- **WHEN** the user supplies a local secret
- **THEN** the edge stores it in the operating-system credential store when available and never sends the value to the control plane

#### Scenario: Edge logs setup state
- **WHEN** setup or launch events are logged
- **THEN** logs redact resolved local paths, secret values, credentials, and complete command environments

### Requirement: Explicit local consent

The edge agent MUST obtain local consent before first use of a new executable recipe or sensitive local grant, and a local denial MUST override cloud desired state.

#### Scenario: First workload launch
- **WHEN** the control plane requests a recipe that the enrolled device has not approved
- **THEN** the edge presents the workload identity and requested local access before executing it

#### Scenario: User denies folder access
- **WHEN** the local user denies a required folder grant
- **THEN** the deployment remains blocked and the control plane receives a non-sensitive denied status

#### Scenario: User revokes an existing grant
- **WHEN** a local grant is revoked while a dependent workload exists
- **THEN** the edge stops the workload and reports the deployment as blocked

### Requirement: Local launch-plan compilation

The edge agent SHALL compile versioned declarative launch recipes by resolving setup grants locally and SHALL NOT evaluate cloud-supplied executable code.

#### Scenario: Complete recipe is compiled
- **WHEN** every required setup grant is valid and the recipe version is approved
- **THEN** the agent substitutes resolved values into command arguments and environment entries and marks the deployment ready

#### Scenario: Recipe contains executable code
- **WHEN** desired state includes an unsupported function or executable-code payload instead of declarative recipe data
- **THEN** the agent rejects the recipe

#### Scenario: Required grant is missing
- **WHEN** launch compilation cannot resolve a required field
- **THEN** the MCP process is not started and readiness identifies the missing field without exposing other values

### Requirement: Filesystem grant containment

The edge agent SHALL canonicalize approved file and folder grants and verify path containment, requested access, traversal, and symlink boundaries whenever a filesystem-sensitive value is resolved.

#### Scenario: Child path stays inside grant
- **WHEN** a recipe or operation resolves a child path contained by an approved folder grant with sufficient access
- **THEN** the edge permits the resolution

#### Scenario: Traversal escapes grant
- **WHEN** a resolved path uses traversal or symlink resolution to escape the approved root
- **THEN** the edge denies the resolution and emits a redacted security event

#### Scenario: Write exceeds grant access
- **WHEN** a workload requests write access through a read-only grant
- **THEN** the edge denies launch or operation before filesystem mutation

### Requirement: Versioned setup reconciliation

Setup and grant readiness SHALL be keyed by deployment, recipe digest, and setup schema version.

#### Scenario: Unrelated configuration changes
- **WHEN** desired state changes metadata that does not affect a setup field or launch recipe
- **THEN** existing valid grants remain ready

#### Scenario: Folder requirement changes
- **WHEN** a new recipe or schema changes a folder field's required access
- **THEN** only the affected grant becomes pending and dependent workloads stop until renewed consent

#### Scenario: Stale setup response arrives
- **WHEN** the edge reports setup for an older desired-state version
- **THEN** the control plane ignores it for readiness of the current deployment

