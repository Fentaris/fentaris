## 1. OpenSpec and command contract

- [x] 1.1 Validate the proposal, design, and `edge-practical-verification` capability with strict OpenSpec validation
- [x] 1.2 Add the root `verify:edge:practical` command without adding a public package API or runtime dependency

## 2. Attempt runner and evidence

- [x] 2.1 Implement explicit-attempt validation and atomic next-`install<N>` allocation without reuse or deletion
- [x] 2.2 Implement the attempt directory layout, command runner, separate logs, sentinel redaction scan, cleanup ledger, and structured result records
- [x] 2.3 Implement candidate identity inputs, before/after tree-integrity comparison, tarball SHA-256 recording, matrix rendering, and `REPORT.md` verdict rendering
- [x] 2.4 Add runner tests for allocation races, path containment, verdict rules, missing evidence, secret detection, and report output

## 3. Progressive projects and fixtures

- [x] 3.1 Implement `00-package-smoke` with runtime preflight, repository/release gates, candidate package packing, empty-consumer install, runtime/type/bin checks, and manifest assertions
- [x] 3.2 Implement `01-control-plane-minimal` and `02-single-edge-enrollment` projects with integrated-control-plane, CLI, authorization, enrollment, management, reconnect, revoke, redaction, and legacy coverage
- [x] 3.3 Implement `03-basic-workload` and `04-local-setup` projects with the complete Edge MCP operation matrix, workload failure modes, consent, confidentiality, reconciliation, and containment coverage
- [x] 3.4 Implement `05-managed-installation` with deterministic provider fixtures, approval and lifecycle failures, retry/update/rollback/cleanup coverage, plus separately scored external canaries
- [x] 3.5 Implement `06-resilience-and-launchd` with crash/reconnect/singleton coverage and an explicit macOS native-service gate that owns and cleans only attempt resources
- [x] 3.6 Implement `07-multi-edge-routing` and `08-agent-orchestration` with two isolated profiles, placement, pinning, selection, explicit calls, fan-out policies, child cleanup, and failure coverage
- [x] 3.7 Implement `09-security-and-final-soak` with owner-only permission checks, sentinel scanning, repeated lifecycle checks, leak detection, and final aggregate gates

## 4. Coverage catalog and playbook

- [x] 4.1 Build the tracked requirement-to-scenario catalog for all applicable macOS requirements across the current Edge specifications
- [x] 4.2 Add a maintainer playbook covering focused phases, full core runs, native launchd, external canaries, evidence interpretation, cleanup boundaries, and retry rules
- [x] 4.3 Confirm the documentation-impact checklist and update public Edge docs only for any discovered user-visible behavior fix

## 5. Verification and delivery

- [x] 5.1 Run harness unit tests, focused Edge/Core/CLI suites, strict OpenSpec validation, lint, typecheck, build, and the complete repository suite
- [x] 5.2 Commit only this change to `codex/comprehensive-edge-practical-verification` with GitButler and record candidate, tree, target `dev`, and stack identities
- [x] 5.3 Run a context-free verifier in a newly allocated `../installation_tests/install<N>`, review `REPORT.md` and supporting logs, and remediate compatible failures in new immutable attempts
- [x] 5.4 Confirm all tasks, mandatory matrix rows, cleanup checks, and deterministic core gates pass; record canary status and remaining platform exclusions

## 6. Review remediation

- [x] 6.1 Prove the materialized candidate commit, tree, branch, and target `dev` ancestry before allowing `PASS`
- [x] 6.2 Run one installed-tarball, user-observable practical scenario in every phase from `01` through `09`
- [x] 6.3 Map every requirement to explicit scenario expectations and accept only matching retained evidence
- [x] 6.4 Terminate timed-out command process groups, escalate to `SIGKILL`, wait for exit, and retain timeout logs
- [x] 6.5 Add regression coverage, update the maintainer playbook, rerun all normal gates, and produce a new immutable verification attempt
