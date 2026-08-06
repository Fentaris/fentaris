## 1. Core Installation Contracts

- [ ] 1.1 Add versioned installation recipe, immutable source, provider, permission, verification, output, retention, and cleanup types to `@fentaris/core`
- [ ] 1.2 Implement canonical installation recipe serialization, digest calculation, parsing, and strict validation
- [ ] 1.3 Add public `edge.install` builders for managed packages, Python, binary/archive, container, manual, and custom providers
- [ ] 1.4 Add serializable installed-artifact runtime references and validate them against declared installation outputs
- [ ] 1.5 Add detailed installation/deployment lifecycle states, stable reason codes, retryability, attempt metadata, and normalized compatibility readiness
- [ ] 1.6 Add installation provider, source resolver, attempt store, approval store, lifecycle store, artifact store, and mutation-lock adapter contracts
- [ ] 1.7 Add deterministic in-memory reference adapters for the new core contracts and expose single-process readiness warnings

## 2. Desired State and Protocol

- [ ] 2.1 Extend desired deployments with optional installation recipes and installation/launch digest correlation
- [ ] 2.2 Add negotiated Edge protocol messages for installation lifecycle, approval-required summaries, attempt correlation, explicit retry, and managed removal
- [ ] 2.3 Preserve launch-only behavior for compatible older agents and report `agent-upgrade-required` for installable deployments they cannot process
- [ ] 2.4 Extend control-plane desired-state and readiness stores to persist bounded installation identity and lifecycle summaries
- [ ] 2.5 Reject stale desired-state, lifecycle, approval, and attempt messages by device, deployment, version, digest, and connection generation

## 3. Local Persistence and Reconciliation

- [ ] 3.1 Add protected local persistence for installation records, attempts, active artifact pointers, approvals, retention references, and terminal results
- [ ] 3.2 Implement per-installation-root mutation locking and idempotent desired-state reconciliation
- [ ] 3.3 Implement crash recovery that terminates or proves termination of orphaned installer process trees and marks interrupted attempts explicitly
- [ ] 3.4 Implement explicit retry with new attempt identity while preserving prior bounded audit history
- [ ] 3.5 Implement reference-counted managed artifact retention and removal without deleting non-Fentaris host content

## 4. Source Resolution and Integrity

- [ ] 4.1 Implement immutable Git source staging with exact commit verification, bounded submodule policy, and canonical path containment
- [ ] 4.2 Implement integrity-pinned archive download and extraction with size limits, traversal, symlink, and special-file rejection
- [ ] 4.3 Implement inline-script staging whose complete content participates in recipe and approval identity
- [ ] 4.4 Implement approved local file/folder source resolution through existing canonical Edge grants
- [ ] 4.5 Implement the enterprise source resolver adapter path and verify all returned content before provider execution
- [ ] 4.6 Resolve private-source credentials through protected local setup channels without placing them in URLs, arguments, desired state, or control-plane reports

## 5. Custom Installer Consent and Execution

- [ ] 5.1 Build the exact effective custom installation review model covering source, digest, script, interpreter, arguments, permissions, limits, outputs, verification, and cleanup
- [ ] 5.2 Extend terminal/local-control setup interactions to display bounded review material and record explicit approval or denial
- [ ] 5.3 Bind approval to the complete effective plan and invalidate it when any source, script, permission, verification, or cleanup input changes
- [ ] 5.4 Implement a managed staging/install directory runner with process-tree supervision, time, output, disk, environment, executable, and no-elevation controls
- [ ] 5.5 Add platform capability adapters for enforceable filesystem and network isolation and fail closed when required isolation is unavailable
- [ ] 5.6 Sanitize installer output and errors against protected values before bounded local persistence or control-plane reporting
- [ ] 5.7 Require separate exact approval before executing a custom cleanup script that can mutate state outside managed-directory deletion

## 6. Installation Providers and Activation

- [ ] 6.1 Implement the custom script provider over the shared source, consent, runner, verification, and lifecycle pipeline
- [ ] 6.2 Implement managed Node package installation with exact versions, integrity checks, lifecycle-script risk disclosure, and managed storage
- [ ] 6.3 Implement isolated Python package/environment installation with exact dependency identity and managed storage
- [ ] 6.4 Implement integrity-pinned binary/archive installation and executable verification
- [ ] 6.5 Implement container-image installation with immutable image digest validation where a governed container runtime is available
- [ ] 6.6 Implement manual prerequisite detection that returns actionable setup requirements without attempting privileged host installation
- [ ] 6.7 Implement provider verification and atomic activation of a verified artifact root for new sessions
- [ ] 6.8 Implement bounded previous-version retention and safe pointer rollback only for verified installations without undeclared external side effects

## 7. Setup, Workload, and Runtime Integration

- [ ] 7.1 Sequence installation preflight and verification before existing runtime setup and launch-plan compilation
- [ ] 7.2 Keep installation approval, source grants, launch recipe consent, and runtime grants independently revocable
- [ ] 7.3 Resolve installed-artifact references into contained launch commands and reject missing, stale, or escaping outputs
- [ ] 7.4 Prevent local software discovery from publishing or launching an MCP without an authorized desired deployment
- [ ] 7.5 Stop dependent workloads when installation authority is revoked and preserve verified artifacts when only runtime setup is denied
- [ ] 7.6 Keep active session workloads pinned to their verified artifact while routing new sessions only after atomic activation

## 8. Inventory, CLI, Health, and Observability

- [ ] 8.1 Extend Edge inventory with policy-filtered per-deployment installation, setup, startup, readiness, retryability, and safe next-action summaries
- [ ] 8.2 Update Edge selection to require online presence, fresh readiness, capacity, and a ready current installation/deployment digest
- [ ] 8.3 Extend `fentaris edge status` and canonical JSON output to separate device, service, installation, setup, workload, and readiness states
- [ ] 8.4 Add authorized CLI/local-control operations for reviewing, approving, denying, retrying, revoking, and cleaning up installations
- [ ] 8.5 Extend Edge Control discovery with bounded lifecycle states while omitting inaccessible deployments and sensitive local details
- [ ] 8.6 Add health checks for interrupted attempts, stale lifecycle reports, installation storage pressure, unsupported isolation, orphaned artifacts, and upgrade requirements
- [ ] 8.7 Emit correlated redacted telemetry for source resolution, approval, attempts, verification, activation, rollback availability, and cleanup

## 9. Verification and Security Tests

- [ ] 9.1 Add core tests for recipe canonicalization, digest invalidation, builder validation, lifecycle normalization, and protocol compatibility
- [ ] 9.2 Add source tests for floating-reference rejection, digest mismatch, archive traversal, symlink escape, submodule policy, and private credential redaction
- [ ] 9.3 Add consent tests proving exact approval binding, denial stickiness, independent revocation, changed-plan reapproval, and custom cleanup approval
- [ ] 9.4 Add bounded-runner tests for timeout, output and disk limits, process-tree cleanup, environment allowlisting, executable denial, elevation rejection, and unavailable isolation
- [ ] 9.5 Add provider conformance tests covering preflight, install, verify, activation, failed verification, retry, update, and removal
- [ ] 9.6 Add lifecycle persistence tests for replay, concurrent reconciliation, crash interruption, reconnect, reference counting, and stale message rejection
- [ ] 9.7 Add end-to-end tests from live desired-state assignment through installation, setup, MCP initialization, capability publication, selection, invocation, update, and removal
- [ ] 9.8 Add mixed-state inventory tests proving one online Edge can expose ready, installing, blocked, degraded, and failed deployments without leaking hidden deployments
- [ ] 9.9 Run focused package tests followed by repository build, typecheck, lint, and strict OpenSpec validation

## 10. Documentation and Release

- [ ] 10.1 Document installation providers, immutable source rules, custom script review, local consent, private-source credentials, and security boundaries
- [ ] 10.2 Document lifecycle states, CLI recovery flows, manual prerequisites, update/removal semantics, and agent compatibility behavior
- [ ] 10.3 Add a safe example using a pinned custom Git MCP installer and a separate manual desktop-application prerequisite
- [ ] 10.4 Regenerate API reference for new public Edge installation contracts and builders
- [ ] 10.5 Add a minor Changeset for affected published Fentaris packages
