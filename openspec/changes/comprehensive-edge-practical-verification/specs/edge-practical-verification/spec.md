## Purpose

Defines a repeatable, evidence-backed macOS campaign for verifying an exact Fentaris Edge release candidate from packed artifacts through realistic single-device, multi-device, lifecycle, installation, orchestration, and security scenarios.

## ADDED Requirements

### Requirement: Immutable isolated verification attempt
The verification system SHALL run each campaign in a newly allocated `install<N>` directory, SHALL never reuse or delete an earlier attempt, and SHALL materialize the exact committed candidate rather than the visible workspace.

#### Scenario: Next attempt is allocated
- **WHEN** a maintainer starts a campaign without an explicit attempt directory
- **THEN** the system atomically creates the next unused `../installation_tests/install<N>` directory
- **AND** all caches, temporary files, generated projects, artifacts, and evidence remain inside that directory

#### Scenario: Candidate identity cannot be proven
- **WHEN** the source head, tree, target `dev` ancestry, or materialized candidate cannot be verified
- **THEN** the campaign reports `BLOCKED`
- **AND** it does not claim that the candidate was tested

#### Scenario: Candidate identity is proven
- **WHEN** a campaign is allowed to execute
- **THEN** the named branch resolves to the declared full source commit
- **AND** that commit resolves to the declared tree and descends from the declared target `dev`
- **AND** every materialized file, executable mode, and Git blob identity matches the committed tree

### Requirement: Candidate artifact verification
The verification system SHALL install the candidate packages from newly packed tarballs in empty consumer projects and SHALL record the filename and SHA-256 identity of every installed tarball.

#### Scenario: Package smoke succeeds
- **WHEN** the candidate passes runtime preflight, frozen installation, repository verification, release verification, artifact inspection, runtime imports, type checking, and binary smoke checks
- **THEN** the package-smoke stage records `PASS` with retained command logs

#### Scenario: Workspace dependency leaks into a package
- **WHEN** a packed manifest contains a workspace, file, link, or portal dependency reference
- **THEN** the package-smoke stage reports `FAIL`

### Requirement: Progressive practical project ladder
The campaign SHALL execute the mandatory macOS stages in order from the smallest package consumer to the final security soak, and a later stage SHALL NOT hide or replace a failure from an earlier stage.

#### Scenario: Deterministic stage progression
- **WHEN** a campaign runs in core mode
- **THEN** it executes package smoke, minimal control plane, single-Edge enrollment, basic MCP workload, local setup, managed installation, macOS resilience and launchd, multi-Edge routing, agent-native orchestration, and security soak stages
- **AND** each stage uses isolated state and retained logs
- **AND** every stage after package smoke installs the candidate tarballs in its own consumer and records a phase-specific observable result

#### Scenario: Stage fails
- **WHEN** a mandatory assertion or command exits unexpectedly
- **THEN** that stage and the campaign report `FAIL`
- **AND** subsequent cleanup still runs

#### Scenario: Stage command times out
- **WHEN** a command exceeds its bounded deadline
- **THEN** the campaign terminates its process group gracefully and then forcibly if needed
- **AND** waits for exit and retains partial stdout and stderr before continuing

### Requirement: Complete requirement-to-evidence matrix
The campaign SHALL map every applicable macOS Edge requirement to at least one executed scenario, observable expectation, result, and retained evidence path.

Each matrix row SHALL name the exact command evidence that satisfies its expectation and SHALL NOT inherit success merely because another requirement from the same source specification passed.

#### Scenario: Core verification is complete
- **WHEN** every mandatory matrix row passes and no row is skipped
- **THEN** the deterministic core verdict is `PASS`

#### Scenario: Requirement has no executed evidence
- **WHEN** an applicable requirement has no successful scenario or evidence path
- **THEN** the deterministic core verdict is not `PASS`

### Requirement: Realistic Edge isolation and lifecycle
The campaign SHALL use loopback endpoints, dynamic ports, non-secret sentinel credentials, and a distinct absolute `FENTARIS_EDGE_STATE_DIR` for each Edge profile. On macOS it SHALL exercise launchd install, start, status, restart, stop, and uninstall without requiring a physical reboot.

#### Scenario: Two Edge profiles run concurrently
- **WHEN** the multi-Edge stage starts two enrolled profiles
- **THEN** their identity, credentials, local control endpoints, setup grants, workloads, and logs remain isolated

#### Scenario: Lifecycle cleanup completes
- **WHEN** a launchd or resilience scenario finishes or fails
- **THEN** the campaign stops only its owned processes, unloads only its owned LaunchAgent, removes transient sockets and locks, and retains its evidence

### Requirement: Edge behavior coverage
The deterministic campaign SHALL exercise enrollment and revocation, complete supported MCP forwarding, local setup and consent, managed installation lifecycle, reconnection and recovery, placement and session pinning, multi-device orchestration, policy enforcement, and redaction using local fixtures.

#### Scenario: MCP operation matrix runs
- **WHEN** the basic workload is ready
- **THEN** the campaign exercises `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`, and `completion/complete`
- **AND** it covers success, local failure, timeout, cancellation, output limit, startup failure, and forced shutdown

#### Scenario: Managed installation matrix runs
- **WHEN** the managed-installation stage executes
- **THEN** it covers manual, binary, custom, Node package, Python, and container providers with deterministic adapters or fixtures
- **AND** it covers approval, denial, revocation, retry, update, verification, activation, rollback, cleanup, integrity failure, containment failure, elevation denial, bounded execution, unavailable isolation, and interrupted recovery

#### Scenario: Orchestration matrix runs
- **WHEN** two eligible Edge profiles are connected
- **THEN** the campaign exercises selection, explicit invocation, bounded fan-out, collect and fail-fast policies, concurrency, deadlines, isolated child bindings, session pinning, policy denial, malformed output, disconnects, and cleanup

### Requirement: External canary separation
Network-dependent npm, Python, Git/archive, and container checks SHALL report a canary status independently from the deterministic core verdict.

#### Scenario: Canary prerequisites are available
- **WHEN** the required network access and runtime are available
- **THEN** configured canaries execute against immutable public identities and report `COMPLETE` only if all pass

#### Scenario: Canary prerequisite is unavailable
- **WHEN** a canary lacks network access, Python packaging support, Docker, or Podman
- **THEN** the report records `PARTIAL` or `BLOCKED` with the exact reason
- **AND** the core verdict remains determined only by mandatory deterministic scenarios

### Requirement: Evidence, secrecy, and integrity
The campaign SHALL write a human-readable report, a human-readable matrix, a machine-readable matrix, separate stdout and stderr logs, before-and-after candidate integrity evidence, and a scan for sentinel secrets and prohibited sensitive values.

#### Scenario: Sensitive value appears in evidence
- **WHEN** a token, sentinel secret, complete environment, protected credential, or prohibited private value appears in retained output
- **THEN** the security stage and campaign report `FAIL`

#### Scenario: Candidate file changes during verification
- **WHEN** the final candidate integrity differs from the pre-install snapshot
- **THEN** the campaign reports `FAIL`
- **AND** identifies every changed candidate file including the lockfile

### Requirement: Structured verdict and remediation loop
The report SHALL use `PASS`, `FAIL`, or `BLOCKED`, SHALL list every command and exit status, SHALL identify skipped checks and residual risks, and SHALL require a new immutable attempt after any candidate correction.

#### Scenario: Product defect is corrected
- **WHEN** a mandatory scenario finds a compatible Edge defect
- **THEN** the change adds an automated regression, applies the fix and applicable documentation and Changeset updates, commits a new candidate, and runs the campaign in `install<N+1>`

#### Scenario: Fix requires a breaking product decision
- **WHEN** remediation requires a breaking API or unresolved product decision
- **THEN** the campaign reports `BLOCKED`
- **AND** the behavior change is moved to a separate OpenSpec

### Requirement: Explicit platform boundary
The campaign SHALL define real macOS verification as in scope and SHALL identify physical reboot plus real Linux and Windows lifecycle verification as out of scope.

#### Scenario: Non-macOS adapter coverage is reported
- **WHEN** the final report summarizes platform coverage
- **THEN** it records Linux and Windows adapter tests from the repository suite separately from real macOS lifecycle evidence
- **AND** it does not claim that Linux or Windows were practically exercised
