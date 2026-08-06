## MODIFIED Requirements

### Requirement: Explicit local consent

The edge agent MUST obtain local consent before first use of a new executable recipe, a new managed software installation, or a sensitive local grant, and a local denial MUST override cloud desired state.

#### Scenario: First workload launch
- **WHEN** the control plane requests a recipe that the enrolled device has not approved
- **THEN** the edge presents the workload identity and requested local access before executing it

#### Scenario: Managed installation is requested
- **WHEN** the requested recipe declares a managed install plan whose digest the device has not approved
- **THEN** the edge presents the package identifier and pinned version before installing anything and performs no registry fetch until the user approves

#### Scenario: User denies folder access
- **WHEN** the local user denies a required folder grant
- **THEN** the deployment remains blocked and the control plane receives a non-sensitive denied status

#### Scenario: User denies an installation
- **WHEN** the local user declines a managed installation
- **THEN** the deployment remains blocked, no package is fetched, and the control plane receives a non-sensitive denied status

#### Scenario: User revokes an existing grant
- **WHEN** a local grant is revoked while a dependent workload exists
- **THEN** the edge stops the workload and reports the deployment as blocked

### Requirement: Local launch-plan compilation

The edge agent SHALL compile versioned declarative launch recipes by resolving setup grants locally and, for recipes declaring a managed install plan, by resolving the executable from the verified managed install directory rather than the ambient device `PATH`. The agent SHALL NOT evaluate cloud-supplied executable code.

#### Scenario: Complete recipe is compiled
- **WHEN** every required setup grant is valid and the recipe version is approved
- **THEN** the agent substitutes resolved values into command arguments and environment entries and marks the deployment ready

#### Scenario: Managed install recipe is compiled
- **WHEN** a recipe declares a managed install plan and the corresponding install is present and verified
- **THEN** the agent resolves the declared bin inside the managed install directory, verifies containment, and compiles a launch plan bound to that absolute executable

#### Scenario: Managed install is not ready
- **WHEN** a recipe declares a managed install plan whose install is pending, denied, or failed
- **THEN** compilation fails with an actionable install error and the agent does not fall back to a `PATH` executable

#### Scenario: Recipe contains executable code
- **WHEN** desired state includes an unsupported function or executable-code payload instead of declarative recipe data
- **THEN** the agent rejects the recipe

#### Scenario: Required grant is missing
- **WHEN** launch compilation cannot resolve a required field
- **THEN** the MCP process is not started and readiness identifies the missing field without exposing other values

### Requirement: Cloud target unresolved-input validation

Fentaris SHALL refuse to start an MCP on a cloud target when its launch recipe contains runtime references without cloud-side resolutions, or when it declares a managed install plan.

#### Scenario: Edge-only folder is placed in cloud
- **WHEN** an MCP requiring a local folder grant resolves to the cloud target without a cloud value
- **THEN** startup or pre-dispatch validation returns an actionable unresolved runtime input error

#### Scenario: Managed install is placed in cloud
- **WHEN** an MCP declaring a managed install plan resolves to the cloud target
- **THEN** startup or pre-dispatch validation returns an actionable error explaining that managed installation requires an edge target

#### Scenario: Cloud value is explicitly supplied
- **WHEN** every runtime reference has a valid cloud-side value
- **THEN** Fentaris compiles the recipe and executes it on the cloud target

### Requirement: Versioned setup reconciliation

Setup, grant, and managed install readiness SHALL be keyed by deployment, recipe digest, setup schema version, and install digest.

#### Scenario: Unrelated configuration changes
- **WHEN** desired state changes metadata that does not affect a setup field, launch recipe, or install plan
- **THEN** existing valid grants and managed installs remain ready

#### Scenario: Folder requirement changes
- **WHEN** a new recipe or schema changes a folder field's required access
- **THEN** only the affected grant becomes pending and dependent workloads stop until renewed consent

#### Scenario: Pinned version changes
- **WHEN** a new recipe pins a different package version
- **THEN** only the affected install becomes pending, the deployment stops until the new install is consented and verified, and the superseded install is pruned once unreferenced

#### Scenario: Stale setup response arrives
- **WHEN** the edge reports setup for an older desired-state version
- **THEN** the control plane ignores it for readiness of the current deployment
