## Purpose

Defines how Fentaris safely prepares, installs, verifies, updates, and removes MCP dependencies on enrolled Edge devices while preserving local operator authority over custom code execution.

## ADDED Requirements

### Requirement: Versioned installation recipes
Fentaris SHALL represent every managed Edge installation as a versioned declarative recipe with a stable digest covering provider, immutable source identity, installer entrypoint and arguments, requested permissions, platform constraints, verification, output mapping, and removal behavior.

#### Scenario: Installation recipe is unchanged
- **WHEN** an Edge has already completed and verified the exact installation recipe digest requested by current desired state
- **THEN** reconciliation reuses the verified installation without downloading or executing the installer again

#### Scenario: Mutable source is declared
- **WHEN** an installation recipe references an unpinned branch, floating package version, archive without integrity, or other source whose content can change without changing recipe identity
- **THEN** validation rejects the recipe before it is assigned to an Edge

#### Scenario: Platform is unsupported
- **WHEN** an installation recipe does not support the Edge operating system, architecture, or required runtime
- **THEN** the deployment reports a non-sensitive incompatible status and does not execute the installer

### Requirement: Managed and extensible installation providers
Fentaris SHALL support typed installation providers for common package, binary, container, and manual prerequisites and SHALL expose an adapter contract for organization-specific artifact sources without allowing providers to bypass lifecycle, consent, policy, integrity, or reporting requirements.

#### Scenario: Managed package is already present
- **WHEN** a provider verifies that the exact requested package version and integrity are already available in Fentaris-managed storage
- **THEN** the installation transitions to verified without mutating the host

#### Scenario: Manual prerequisite is missing
- **WHEN** a deployment requires a host application that Fentaris is not permitted to install automatically
- **THEN** the deployment remains setup-required and reports a safe manual next action

#### Scenario: Organization source adapter is used
- **WHEN** an approved adapter resolves an immutable artifact from an enterprise source
- **THEN** the resolved content passes through the same integrity, consent, isolation, verification, and lifecycle controls as built-in providers

### Requirement: Custom installation sources
Fentaris SHALL support custom installation recipes sourced from an immutable Git revision, an integrity-pinned archive, an approved local or enterprise artifact reference, or an inline script whose complete content is covered by the recipe digest.

#### Scenario: Pinned Git installer is assigned
- **WHEN** a custom recipe identifies a repository and exact commit, selects an installer entrypoint inside that revision, and declares its requested permissions
- **THEN** the Edge may stage that exact revision for local review without executing it

#### Scenario: Private source needs a credential
- **WHEN** a custom source requires authentication
- **THEN** the Edge resolves the credential from a protected local setup secret and does not send the value or authenticated source URL to the control plane

#### Scenario: Source escapes staging root
- **WHEN** an archive, symlink, submodule, installer path, or generated output attempts to escape its Fentaris-managed staging or installation root
- **THEN** the Edge blocks the installation and reports a redacted integrity error

### Requirement: Exact local approval for custom execution
The Edge MUST obtain explicit local approval before executing a new or changed custom installer, and approval MUST be bound to the recipe digest, displayed source identity, script content or entrypoint, interpreter, arguments, requested network access, filesystem scope, executable requirements, and privilege level.

#### Scenario: Operator approves reviewed installer
- **WHEN** the local operator reviews the exact custom installation plan and approves it
- **THEN** the Edge records approval for that digest and may execute only the reviewed plan within its declared constraints

#### Scenario: Installer content changes
- **WHEN** source content, revision, script, arguments, permissions, interpreter, verification, or removal behavior changes
- **THEN** the prior approval is invalid and the deployment returns to approval-required

#### Scenario: Operator denies installer
- **WHEN** the local operator denies the custom installation plan
- **THEN** the deployment becomes blocked and desired-state replay cannot execute it until the operator explicitly renews consent

### Requirement: Bounded custom installer execution
The Edge MUST execute approved custom installers as the Edge service user inside a Fentaris-managed working directory with enforced time, process, output, filesystem, disk, network, executable, and privilege controls declared by local policy; it MUST NOT grant automatic elevation or silently claim a control that the host cannot enforce.

#### Scenario: Installer requests elevation
- **WHEN** a custom installer invokes or requests administrator, root, sudo, or equivalent elevation
- **THEN** the Edge terminates or refuses the installer and reports that privileged manual setup is required

#### Scenario: Required isolation is unavailable
- **WHEN** local policy requires a filesystem or network restriction that the current platform adapter cannot enforce
- **THEN** the Edge blocks execution rather than running with weaker unreported isolation

#### Scenario: Installer exceeds a limit
- **WHEN** an installer exceeds its deadline, output, disk, child-process, or other configured resource limit
- **THEN** the Edge terminates the bounded process tree, retains redacted diagnostics, and marks the attempt failed

### Requirement: Installation verification and activation
Fentaris SHALL treat installation completion and deployment readiness as separate states, and an installed artifact SHALL become active only after provider verification and successful MCP initialization produce a capability manifest for the current installation and launch recipe digests.

#### Scenario: Installer exits successfully but verification fails
- **WHEN** a custom script exits with success but its declared artifact, version, integrity, or executable verification fails
- **THEN** Fentaris marks installation failed and does not start the MCP

#### Scenario: MCP initializes successfully
- **WHEN** installation, local setup, launch compilation, process startup, and MCP initialization all succeed
- **THEN** the deployment becomes ready and reports a capability manifest bound to the current digests

#### Scenario: Existing verified version is being updated
- **WHEN** a new installation digest is assigned while a previous verified version exists
- **THEN** Fentaris stages and verifies the new version before activation and does not route new sessions to a partially installed version

### Requirement: Per-deployment lifecycle reporting
Fentaris SHALL track device presence independently from each MCP deployment lifecycle and SHALL expose policy-filtered states covering assignment, checking, approval-required, installing, setup-required, configuring, starting, ready, degraded, failed, blocked, and removing.

#### Scenario: Edge has mixed deployment states
- **WHEN** one deployment is ready, one is installing, and one is blocked on the same online Edge
- **THEN** inventory reports the Edge as online with separate bounded lifecycle summaries for each visible deployment

#### Scenario: Unauthorized caller inspects an Edge
- **WHEN** a caller cannot access a deployment through catalog and policy evaluation
- **THEN** inventory omits that deployment and its installation state

#### Scenario: Installation fails
- **WHEN** a provider or custom installer fails
- **THEN** lifecycle reporting includes a stable redacted reason code, retryability, attempt time, and safe next action without exposing secrets, private paths, authenticated URLs, full scripts, or raw installer output

### Requirement: Idempotent retry, update, and removal
Installation reconciliation SHALL be idempotent by desired-state version and recipe digest, SHALL serialize mutations for the same installation root, and SHALL distinguish explicit retry from desired-state replay.

#### Scenario: Desired state is replayed during installation
- **WHEN** the Edge receives the same desired-state version and installation digest while an attempt is active or terminal
- **THEN** it does not start a duplicate installer or reset the terminal result

#### Scenario: Retry is authorized
- **WHEN** an operator explicitly retries a retryable failed installation without changing its recipe
- **THEN** Fentaris creates a new bounded attempt while preserving prior redacted audit metadata

#### Scenario: Deployment is removed
- **WHEN** desired state removes the final deployment referencing a Fentaris-managed installation
- **THEN** the Edge stops dependent workloads and removes managed artifacts according to declared retention policy

#### Scenario: Custom cleanup can mutate external state
- **WHEN** removal requires a custom cleanup script outside automatic managed-directory deletion
- **THEN** the Edge requires a separate exact local approval before executing the cleanup

### Requirement: Installation confidentiality and audit
Fentaris SHALL emit correlated installation audit events while keeping source credentials, local secrets, private paths, authenticated URLs, environment values, and unbounded installer output on the Edge.

#### Scenario: Custom installer is approved and executed
- **WHEN** a local operator approves and runs a custom installer
- **THEN** audit records tenant, device, deployment, provider, recipe digest, source type, approval decision, attempt, timing, terminal state, and bounded redacted reason metadata

#### Scenario: Installer prints a secret
- **WHEN** installer output contains a known secret or sensitive environment value
- **THEN** local retention redacts the value and control-plane reporting contains only bounded sanitized diagnostics

