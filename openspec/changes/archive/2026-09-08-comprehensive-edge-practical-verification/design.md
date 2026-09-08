## Context

The repository already has broad unit and in-process Edge integration tests, package-release verification, two Edge examples, and an established independent fresh-install protocol. What is missing is one maintainer-owned runner that composes these assets into ordered consumer projects, retains evidence, and proves coverage against the current Edge OpenSpec requirements. Generated projects must live outside the repository, while the runner, fixtures, matrix catalog, and playbook remain reviewable source.

## Goals / Non-Goals

**Goals:**

- Make deterministic macOS Edge verification runnable from one root command.
- Preserve exact candidate and tarball identity, per-scenario logs, machine-readable results, and safe retry history.
- Keep every Edge process, state directory, port, package cache, and service uniquely scoped to an attempt.
- Reuse repository tests where they are the strongest deterministic proof while adding practical packed-consumer smoke scenarios.
- Make incomplete coverage visible instead of converting skipped tests into success.

**Non-Goals:**

- Add or change public Fentaris APIs.
- Require a physical macOS reboot or claim real Linux or Windows lifecycle coverage.
- Use real user credentials, production services, or destructive system-wide cleanup.
- Make public-network and container canaries prerequisites for the deterministic core verdict.

## Decisions

### Use a data-driven runner with explicit phase selectors

`scripts/edge-verification/run.mjs` owns allocation, directory layout, command execution, log capture, redaction scanning, matrix aggregation, cleanup, and report rendering. A catalog describes phases and scenario IDs. `--phase` permits focused iteration; the default is `all`. This avoids ten unrelated shell scripts while keeping each command and assertion visible in evidence.

Alternative considered: a single Vitest file. Rejected because it would blur candidate materialization, packed consumer installation, native service operations, and retained cross-process evidence into the repository test runner.

### Separate planning coverage from executable coverage

The tracked matrix catalog enumerates every applicable Edge requirement and attaches it to one or more scenario IDs. Scenarios may use repository tests, a packed consumer project, or a practical local process. The report fails if a mandatory row lacks a successful executed scenario. This permits incremental scenario implementation without falsely reporting completeness.

Each requirement entry also names an observable expectation and exact command-evidence IDs. A row requires its focused deterministic suite, candidate-tarball installation, and phase-specific installed-package scenario; phase-level success alone is insufficient.

Alternative considered: code-coverage thresholds. Rejected because line coverage does not prove lifecycle, process isolation, CLI envelopes, security boundaries, or installation behavior.

### Generate reproducible projects from candidate tarballs

The runner packs `@fentaris/core`, `@fentaris/cli`, and `@fentaris/edge`, records SHA-256 values, and writes numbered projects under the attempt. Consumer manifests use absolute `file:` references to those tarballs and never use workspace links or repository `node_modules`.

Before the candidate is installed, the runner proves its declared commit and tree in a caller-supplied identity repository, verifies branch resolution and target ancestry, and compares the materialized file set, executable modes, and Git blob IDs with the committed tree. It does not run phases when that proof fails.

### Treat repository tests as mandatory evidence for deep deterministic branches

Existing focused tests already exercise many negative conditions with controllable clocks and adapters. Each practical phase runs the narrowest relevant package tests and then performs at least one packed, user-observable scenario. The final stage reruns the aggregate repository and release gates. This prevents fragile reimplementation of protocol fault injection while still proving packaged behavior.

Commands run in isolated process groups. On timeout the runner sends `SIGTERM`, escalates to `SIGKILL`, waits for group termination, and writes the partial stdout and stderr logs before recording failure.

### Gate native launchd behind an explicit flag

`--native-service` enables real per-user launchd install/start/restart/stop/uninstall and is mandatory for the final macOS campaign. Dry runs and normal CI can omit it and receive a non-PASS matrix result rather than modifying the user session unexpectedly. The service label, plist path, state root, and cleanup ledger include the attempt identity.

### Keep canaries opt-in and separately scored

`--canary` enables public npm/Python/Git/archive and Docker/Podman checks. The core uses local deterministic adapters and fixtures. Canary absence produces an explicit status and residual risk, never an implicit skip or a product failure.

### Reuse the independent verifier only after commit

Normal development can run focused phases in temporary directories. After all intended files are committed, the established context-free verifier receives only raw candidate identity and an empty `install<N>`. It materializes the committed tree, runs the full applicable campaign, validates report evidence, and cannot fix the source.

## Risks / Trade-offs

- **[Risk] The full campaign is slow.** → Support phase selection, reuse focused package tests during development, and reserve aggregate gates for package-smoke and final-soak.
- **[Risk] launchd cleanup could target unrelated services.** → Generate attempt-specific labels and paths, maintain an ownership ledger, and refuse cleanup when identity does not match.
- **[Risk] local fixtures diverge from public registries.** → Keep immutable opt-in canaries and report their status separately.
- **[Risk] macOS sandboxing can block sibling-directory or service operations.** → Fail as `BLOCKED`, request narrow approval, and never redirect state into an unrelated directory.
- **[Risk] a huge matrix becomes stale.** → Validate scenario IDs, requirement identifiers, evidence paths, and mandatory row completion in automated tests.
- **[Risk] product bugs expand the change.** → Accept compatible fixes with regressions; stop on breaking decisions and open a separate OpenSpec.

## Migration Plan

1. Add the OpenSpec, runner contract, catalog, fixtures, and playbook without changing product behavior.
2. Add focused harness tests and the root `verify:edge:practical` script.
3. Run deterministic phases locally, correct harness defects, and commit the candidate.
4. Run a new context-free `install<N>` verification and retain its report.
5. If a product defect is found, add a regression and compatible fix with patch Changeset, commit, and rerun in `install<N+1>`.

Rollback consists of removing the internal root script and `scripts/edge-verification` assets. Generated attempts remain outside the repository as immutable evidence and are not automatically deleted.
