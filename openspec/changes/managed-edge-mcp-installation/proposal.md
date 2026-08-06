## Why

Fentaris can send a declarative launch recipe to an enrolled device, collect local consent, resolve grants, and start a governed MCP workload, but it never installs the MCP server software. The recipe assumes the executable already exists on the device `PATH`, or it delegates provisioning to an ad-hoc `npx` invocation that Fentaris does not control. That leaves three gaps: a device is only usable after a manual, undocumented installation step; the version actually executed is whatever the device happens to resolve at spawn time, so the same deployment can run different code on different machines; and an unattended package fetch happens inside the launch path with no integrity verification, no lifecycle script suppression, and no auditable outcome.

Managed installation closes the gap between "device joined" and "deployment ready". The control plane declares exactly which package and version a deployment needs, the device installs it once into a Fentaris-managed location under explicit local consent, verifies it, launches from it deterministically, and removes it when no deployment references it anymore.

## What Changes

- Add a declarative, data-only install plan to the launch recipe that pins an exact package name and exact version, optionally an expected registry integrity digest, an explicit registry URL, and the bin entry to launch.
- Bind the install plan to the existing recipe digest so a package or version change produces a new digest, requires renewed local consent, and cannot be swapped silently under an already approved deployment.
- Add `edge.npm(...)` as the authoring surface for managed installs and reject a managed-install recipe on a cloud target with an actionable configuration error, mirroring existing unresolved-runtime-input validation.
- Add a managed install store on the edge device that keeps every installed package under a Fentaris-owned directory keyed by package, version, and install digest, with a durable per-deployment install state record.
- Install with lifecycle scripts disabled, a bounded timeout, a minimal environment, an isolated package cache, no shell interpretation, and staged directories promoted only after verification succeeds.
- Verify the installed tree before first use: the resolved version must equal the requested version, the declared integrity digest must match the integrity recorded by the package manager, and the resolved bin must stay inside the managed install directory.
- Resolve the launch command from the managed install directory instead of the device `PATH` whenever an install plan is present, so execution is deterministic and independent of ambient device state.
- Evaluate the local package allowlist against the install plan before any network fetch, so an unapproved package is never downloaded.
- Report installation outcomes as non-sensitive state: a new `install-required` deployment readiness status, bounded reason categories for pending, failed, and denied installs, install fields on the setup-status message, and install counters in local agent status.
- Retain installs across reconnects and restarts, reuse an existing verified install, and prune managed installs that no desired deployment references.

## Capabilities

### New Capabilities

- `managed-edge-mcp-installation`: Declarative install plans, managed local install execution and verification, deterministic bin resolution, install-aware readiness reporting, install reuse, and pruning.

### Modified Capabilities

- `edge-runtime-setup`: Extend setup reconciliation, consent, launch-plan compilation, and cloud-target validation with managed installation.
- `edge-agent-runtime`: Extend desired-state reconciliation and status reporting with install state.

## Impact

- Affects `@fentaris/core` launch recipes, the stdio transport declaration, the `edge` authoring namespace, edge control protocol messages, readiness statuses, and the Edge Control discovery schema.
- Affects `@fentaris/edge` with a new managed install store and installer, supervisor and setup integration, executable/package policy evaluation, and local status reporting.
- Affects `@fentaris/cli` local `fentaris edge status` output with additive install counters.
- Requires documentation updates for edge device setup, edge concepts, and the edge API reference, plus minor changesets for `@fentaris/core`, `@fentaris/edge`, and `@fentaris/cli`.
- Existing recipes without an install plan keep their current digests and behavior, so devices, deployments, and protocol-v1 agents are unaffected until a deployment opts in.
