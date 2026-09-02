# Edge practical verification

This maintainer harness verifies one exact Fentaris candidate through ordered macOS Edge projects and retains the evidence outside the repository.

## Quick start

Use a new absolute attempt path. The runner refuses any attempt that already contains its marker.

```bash
pnpm verify:edge:practical -- \
  --attempt /absolute/path/to/installation_tests/install6 \
  --candidate /absolute/path/to/install6/candidate \
  --branch codex/comprehensive-edge-practical-verification \
  --source-head <commit-sha> \
  --tree <tree-sha> \
  --target-dev <dev-sha> \
  --native-service
```

Omit `--attempt` only when the process is allowed to atomically allocate the next `../installation_tests/install<N>`. Never reuse or delete an earlier attempt.

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

Each directory under `projects/` describes the phase. Deep failure branches use the focused repository tests named in `catalog.mjs`; package smoke additionally packs and installs candidate tarballs in an empty consumer. The complete requirement inventory is tracked in `requirements.mjs`, so a clean commit archive can build the matrix without ignored local OpenSpec state.

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

The runner may create files only in its candidate build tree and assigned attempt. Package caches and temporary files are redirected into the attempt. Native cleanup uses only the generated attempt label and plist. The runner never deletes an attempt, edits protected authority state directly, pushes a branch, opens a pull request, or uses real credentials.
