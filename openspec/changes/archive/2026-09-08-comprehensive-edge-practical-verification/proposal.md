## Why

Edge spans enrollment, local consent, managed installation, lifecycle recovery, routing, and multi-device orchestration, but today those behaviors are proven mostly by repository tests and separate examples. Maintainers need one repeatable macOS campaign that installs the exact candidate artifacts in fresh projects, maps every applicable Edge requirement to retained evidence, and distinguishes product failures from unavailable external canaries.

## What Changes

- Add a repository-owned practical Edge verification harness with deterministic fixtures, assertions, and a single root command.
- Allocate immutable `../installation_tests/install<N>` attempts containing the exact candidate, packed artifacts, progressive consumer projects, logs, a requirement matrix, and a structured report.
- Exercise ten ordered stages from package smoke tests through integrated control-plane enrollment, MCP workloads, local setup, managed installation, macOS lifecycle, multi-edge routing, agent-native orchestration, and security soak.
- Require exact candidate identity, tree-integrity checks, owner-only state, sentinel-secret scanning, process/service cleanup, and evidence for every mandatory macOS matrix row.
- Report optional network-dependent npm, Python, and container canaries separately from the deterministic core verdict.
- Require a fresh context-free verification attempt after the implementation is committed; any product fix adds a regression and starts a new attempt.

## Capabilities

### New Capabilities

- `edge-practical-verification`: Defines the progressive macOS verification campaign, evidence contract, verdict rules, isolation boundaries, and retry behavior for Edge release candidates.

### Modified Capabilities

None. Existing Edge product requirements remain unchanged; the new capability specifies how their macOS behavior is verified in a clean candidate installation.

## Impact

- Adds internal scripts, fixtures, a maintainer playbook, and a root package script.
- Writes generated campaign artifacts only under a caller-supplied attempt directory, normally the next `../installation_tests/install<N>`.
- Exercises `@fentaris/core`, `@fentaris/cli`, and `@fentaris/edge` candidate tarballs without adding public exports or runtime dependencies.
- May reveal compatible product defects; fixes require regression coverage, applicable documentation updates, and patch Changesets for affected published packages.
