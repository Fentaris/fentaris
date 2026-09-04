# Edge practical verification

This maintainer harness verifies one exact Fentaris candidate through ordered macOS Edge projects and retains the evidence outside the repository.

## Quick start

Use a new absolute attempt path. The runner refuses any attempt that already contains its marker.

```bash
pnpm verify:edge:practical -- \
  --attempt /absolute/path/to/installation_tests/install6 \
  --candidate /absolute/path/to/install6/candidate \
  --identity-repo /absolute/path/to/fentaris-source \
  --branch codex/comprehensive-edge-practical-verification \
  --source-head <commit-sha> \
  --tree <tree-sha> \
  --target-dev <dev-sha> \
  --native-service
```

Omit `--attempt` only when the process is allowed to atomically allocate the next `../installation_tests/install<N>`. Never reuse or delete an earlier attempt.

`--identity-repo` must contain the declared commit and target objects. Before running any phase, the harness verifies the full commit and tree IDs, confirms that the named branch resolves to the source head, proves that the target `dev` commit is an ancestor, and compares every materialized candidate file, mode, and Git blob ID with the committed tree. A missing or mismatched proof produces `BLOCKED` without testing or claiming the candidate. A clean clone may omit this flag because its own `.git` directory is used.

## Focused phases

Use `--phase <id>` while developing the harness. A focused run intentionally reports `BLOCKED` because it cannot satisfy the complete matrix.

```bash
pnpm verify:edge:practical -- --attempt /absolute/new/installN --phase 04-local-setup
```

The phase order is:

1. `00-package-smoke`
2. `01-control-plane-minimal`
3. `02-single-edge-enrollment`
4. `03-basic-workload`
5. `04-local-setup`
6. `05-managed-installation`
7. `06-resilience-and-launchd`
8. `07-multi-edge-routing`
9. `08-agent-orchestration`
10. `09-security-and-final-soak`

Each directory under `projects/` is an isolated consumer. Phase 00 packs and installs the candidate tarballs; phases 01–09 each install the same three candidate tarballs and run a phase-specific, user-observable scenario from those installed packages. Deep deterministic failure branches additionally use the focused repository tests named in `catalog.mjs`.

The complete requirement inventory is tracked in `requirements.mjs`. Every row declares one scenario, an observable expectation, and exact evidence command IDs. A row passes only when its phase, focused suite, candidate-tarball installation, and installed-package practical scenario all succeed.

## Native launchd

`--native-service` is required for a full macOS `PASS`. It creates an attempt-specific label and plist under the phase project, exercises install/start/restart/stop/uninstall, and removes only that owned job. It does not reboot the Mac or install the normal `dev.fentaris.edge` service.

If launchd cannot be operated in the current user session, the result is `BLOCKED`. Inspect the retained stderr log before retrying in a new attempt.

## External canaries

Pass `--canary` to check public npm and Python resolution plus Docker or Podman availability. Canary status is independent:

- `COMPLETE`: npm, Python, and a container runtime check passed.
- `PARTIAL`: at least one check passed and another prerequisite was unavailable.
- `BLOCKED`: no configured external check could run.
- `NOT_REQUESTED`: `--canary` was omitted.

Canary status never converts a deterministic product failure into success.

## Evidence and verdicts

Every attempt retains:

- `identity.json` and candidate-tree snapshots;
- candidate tarballs and `artifacts/SHA256.json`;
- separate stdout and stderr logs;
- `matrix.json` and `MATRIX.md`;
- `result.json` and `REPORT.md`.

`PASS` requires all ten phases, complete identity, native launchd on macOS, every mandatory matrix row, unchanged candidate source files, and no sentinel leak. `FAIL` identifies product, harness, integrity, or secrecy failures. `BLOCKED` identifies incomplete phase selection, missing native verification, missing identity, or unavailable infrastructure.

After a fix, commit the new candidate and allocate `install<N+1>`. Do not rewrite the prior report.

## Cleanup boundaries

The runner may create files only in its candidate build tree and assigned attempt. Package caches and temporary files are redirected into the attempt. Timed-out commands run in dedicated process groups: the runner sends `SIGTERM`, escalates to `SIGKILL`, waits for exit, and retains partial stdout/stderr before continuing. Native cleanup uses only the generated attempt label and plist. The runner never deletes an attempt, edits protected authority state directly, pushes a branch, opens a pull request, or uses real credentials.
