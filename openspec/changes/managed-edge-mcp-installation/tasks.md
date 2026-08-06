## 1. Install Plan Contracts

- [x] 1.1 Add versioned, data-only install plan types with exact package/version validation, safe bin validation, optional integrity and registry validation, canonical digest computation, and a stable package identifier helper.
- [x] 1.2 Carry the install plan in the launch recipe, cover it with the recipe digest, keep digests unchanged for recipes without an install plan, and require a bare bin name as the command when an install plan is present.
- [x] 1.3 Add the `edge.npm(...)` authoring builder and accept an install declaration on the stdio transport.
- [x] 1.4 Reject managed installs on the cloud target with an actionable error at transport connect and in configuration validation.
- [x] 1.5 Add core tests for plan validation, digest stability, recipe round-trip, malformed plans, and cloud rejection.

## 2. Managed Install Store and Installer

- [x] 2.1 Add a managed install root under the edge data directory with content-addressed install directories, an isolated package cache, and a durable per-deployment install state record.
- [x] 2.2 Add an install command-runner seam plus a default package-manager implementation with lifecycle scripts disabled, no shell, a minimal environment, and a bounded timeout.
- [x] 2.3 Install into a staging directory and promote atomically only after verification succeeds; remove partial state on any failure.
- [x] 2.4 Verify installed version, declared bin presence, containment of the resolved bin, and declared integrity against the integrity recorded by the package manager.
- [x] 2.5 Reuse verified installs across deployments and restarts, apply a bounded attempt budget with backoff for failures, and prune installs no desired deployment references.
- [x] 2.6 Add edge installer tests with a fake command runner for success, reuse, version mismatch, integrity mismatch, bin escape, timeout, attempt budget, pruning, and clearing local state.

## 3. Setup, Policy, and Supervisor Integration

- [x] 3.1 Evaluate local package policy against the install plan before any fetch and extend the executable allowlist policy to answer install checks and managed-install launch plans by package name.
- [x] 3.2 Include the pinned package and version in the local consent prompt for recipes that declare an install plan.
- [x] 3.3 Resolve the launch command from the verified managed install during launch-plan compilation and fail with an actionable install error when it is missing.
- [x] 3.4 Install during desired-state reconciliation after consent and grants, keep pending/failed installs non-callable, and prune unreferenced installs on reconcile and on local-state clear.
- [x] 3.5 Add edge tests for policy denial before fetch, consent text, compilation with and without a ready install, reconcile blocking, idempotent replay, and pruning on deployment removal.

## 4. Install Reporting

- [x] 4.1 Add the `install-required` deployment readiness status with bounded install reason categories across readiness types, protocol validation, and Edge Control discovery schemas.
- [x] 4.2 Add an optional bounded install report to the setup-status message and populate it from local install state without exposing paths or package-manager output.
- [x] 4.3 Report install readiness in presence snapshots and add install counters to local agent status and the CLI local status envelope.
- [x] 4.4 Add tests for readiness mapping, bounded protocol validation, redaction of local install detail, and CLI status output.

## 5. Documentation and Release

- [x] 5.1 Document managed installation in the edge device guide and edge execution concepts, including allowlist requirements, pinning, consent, and failure recovery.
- [x] 5.2 Update the edge API reference and troubleshooting documentation with the new install types, readiness status, and reason categories.
- [x] 5.3 Add minor changesets for `@fentaris/core`, `@fentaris/edge`, and `@fentaris/cli`.
- [x] 5.4 Run focused core, edge, and CLI tests, then repository build, typecheck, and lint.
