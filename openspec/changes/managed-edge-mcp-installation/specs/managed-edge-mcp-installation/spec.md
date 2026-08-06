## Purpose

Defines how Fentaris declares, installs, verifies, launches, reports, and removes the MCP server software a governed edge deployment needs, so that an enrolled device runs exactly the code the control plane pinned without manual provisioning.

## ADDED Requirements

### Requirement: Declarative install plan

A launch recipe SHALL be able to carry a serializable install plan that pins the package source, an exact package name, an exact version, the bin entry to launch, and optionally an expected integrity digest and registry URL. An install plan MUST NOT contain executable code.

#### Scenario: Managed npm install is declared
- **WHEN** a deployment declares `edge.npm({ package: "@scope/server", version: "1.4.2" })` for its stdio transport
- **THEN** Fentaris compiles a data-only install plan carrying the package, exact version, bin entry, and plan digest into the launch recipe

#### Scenario: Version is not exact
- **WHEN** an install plan declares a range, a dist-tag, or `latest` as its version
- **THEN** Fentaris rejects the plan at authoring time and again on the device

#### Scenario: Package name or bin is unsafe
- **WHEN** an install plan declares a package name that is not a valid registry name, or a bin containing a path separator or traversal segment
- **THEN** Fentaris rejects the plan without attempting installation

#### Scenario: Install plan contains executable data
- **WHEN** desired state carries an install plan containing a function, symbol, or other non-serializable payload
- **THEN** the device rejects the recipe before installation

### Requirement: Install plans are covered by the recipe digest

The recipe digest SHALL cover the install plan, and a recipe without an install plan SHALL keep its existing digest.

#### Scenario: Package version changes
- **WHEN** the control plane republishes a deployment with a different pinned version
- **THEN** the recipe digest changes, the previously approved digest does not authorize it, and the device requests local consent again before installing

#### Scenario: Recipe has no install plan
- **WHEN** a recipe declares no install plan
- **THEN** its digest and launch behavior are identical to the digest and behavior before managed installation existed

### Requirement: Cloud targets reject managed installs

Fentaris SHALL refuse to run a managed-install recipe on a cloud target and SHALL report an actionable configuration error.

#### Scenario: Managed install is placed in cloud
- **WHEN** an MCP declaring a managed install resolves to the cloud target
- **THEN** validation or pre-dispatch returns an actionable error explaining that managed installation requires an edge target

### Requirement: Local approval precedes any package fetch

The device MUST evaluate its local package policy against the install plan, and MUST hold local consent for the current recipe digest, before contacting a package registry.

#### Scenario: Package is not allowlisted
- **WHEN** an install plan names a package that the device package allowlist does not contain
- **THEN** the device denies the installation, performs no network fetch, and reports a denied install state

#### Scenario: Allowlist is empty
- **WHEN** a device has no configured package allowlist
- **THEN** every managed installation is denied

#### Scenario: User denies the deployment
- **WHEN** the local user declines consent for a recipe digest that declares an install plan
- **THEN** no package is fetched and the deployment stays blocked

### Requirement: Protected install execution

Managed installation MUST run with package lifecycle scripts disabled, without shell interpretation, with a minimal environment and a Fentaris-owned package cache, and under a bounded timeout.

#### Scenario: Package declares lifecycle scripts
- **WHEN** a declared package contains install, preinstall, or postinstall scripts
- **THEN** the device installs the package without executing those scripts

#### Scenario: Installation exceeds the time budget
- **WHEN** installation does not complete inside the configured timeout
- **THEN** the device abandons the attempt, removes partial state, and records a failed install with a non-sensitive reason category

#### Scenario: Installation repeatedly fails
- **WHEN** installation for one install digest keeps failing across reconciliations
- **THEN** the device applies a bounded attempt budget with backoff instead of refetching on every reconnect

### Requirement: Verification before first use

An installed package MUST be verified before it becomes launchable: the installed manifest version MUST equal the requested version, the declared bin MUST exist inside the managed install directory, and a declared integrity digest MUST match the integrity recorded for the installed package.

#### Scenario: Installed version differs
- **WHEN** the installed package manifest reports a version other than the requested version
- **THEN** the device discards the install and reports a verification failure

#### Scenario: Integrity does not match
- **WHEN** the plan declares an integrity digest and the recorded integrity of the installed package differs
- **THEN** the device discards the install, reports a verification failure, and does not launch the workload

#### Scenario: Bin escapes the install directory
- **WHEN** the resolved bin path leaves the managed install directory through a link or traversal
- **THEN** the device refuses to launch and reports a verification failure

#### Scenario: Partial install is never promoted
- **WHEN** installation or verification fails after files were written
- **THEN** the staged directory is removed and no partially installed tree becomes visible to launch resolution

### Requirement: Deterministic launch from the managed install

When a recipe declares an install plan, the device SHALL resolve the launch command from the managed install directory instead of the ambient device `PATH`, and the recipe command MUST be a bare bin name.

#### Scenario: Managed workload starts
- **WHEN** a verified managed install exists for the current recipe digest
- **THEN** the device launches the bin from inside the managed install directory with the resolved arguments and environment

#### Scenario: Command is a path
- **WHEN** a recipe declares an install plan and a command containing a path separator
- **THEN** the device rejects the recipe

#### Scenario: Install is missing at launch
- **WHEN** a launch is attempted for a deployment whose managed install is absent, pending, or failed
- **THEN** the device refuses the launch with an actionable install error instead of falling back to a `PATH` executable

### Requirement: Install reuse, persistence, and pruning

Managed installs SHALL be keyed by package, version, and install digest, reused across deployments, sessions, and agent restarts, and removed when no desired deployment references them.

#### Scenario: Two deployments share a package
- **WHEN** two deployments declare the same package and version
- **THEN** the device installs it once and both deployments launch from the same managed install

#### Scenario: Agent restarts
- **WHEN** the agent restarts and reconciles unchanged desired state
- **THEN** it reuses the existing verified install without refetching

#### Scenario: Deployment is removed
- **WHEN** desired state no longer references an installed package and version
- **THEN** the device prunes that managed install directory and its state record

#### Scenario: Enrollment is cleared
- **WHEN** local state is cleared after revocation
- **THEN** managed installs and install state are removed with the rest of the local state

### Requirement: Non-sensitive install reporting

The device SHALL report install progress and outcome as bounded, non-sensitive state, and MUST NOT report local paths, cache locations, or raw package-manager output.

#### Scenario: Install is pending
- **WHEN** a deployment is consented and granted but its package is not installed yet
- **THEN** the device reports an `install-required` readiness status with an `install-pending` reason category, and the deployment is not callable

#### Scenario: Install completes
- **WHEN** installation and verification succeed
- **THEN** the device reports the deployment as ready, and reports the installed package identifier and resolved version in its setup status

#### Scenario: Install fails
- **WHEN** installation, verification, or policy denies the package
- **THEN** the device reports `install-required` with a failed, verification-failed, or denied reason category and a safe next action

#### Scenario: Operator inspects the device
- **WHEN** an operator inspects local agent status
- **THEN** it reports installed, pending, and failed managed install counts without exposing install directories or registry credentials
