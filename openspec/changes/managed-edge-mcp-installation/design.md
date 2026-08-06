## Context

Today an edge deployment carries a `LaunchRecipe` (command, argument/environment templates, setup field references, digest) and a `SetupSchema`. The edge agent ingests the requirement, collects consent and grants, compiles a resolved launch plan, checks an executable/package allowlist, and spawns the process through the stdio workload factory. Nothing installs the MCP server: `command` is resolved by the operating system from the ambient `PATH`, and a recipe such as `npx --yes @scope/server` pushes provisioning into an unmanaged package-manager invocation at spawn time.

The design goal is to make "which code runs on this device" an explicit, verified, consented property of the deployment, without weakening the existing rule that the control plane may never send executable code to a device.

## Goals / Non-Goals

Goals:

- Deterministic execution: a deployment runs the exact package version the control plane declared.
- Data-only declaration: the install plan is serializable data, validated on the device before use.
- Consent parity: installing software is at least as protected as granting a folder or secret.
- Bounded, observable failure: install failures are recorded as non-sensitive readiness state with an actionable category instead of surfacing as opaque spawn errors.
- Backward compatibility: recipes without an install plan keep their digest and behavior.

Non-Goals:

- Installing runtimes or system packages (Node.js itself, Python, system libraries).
- Version ranges, dist-tags, or automatic upgrades. The control plane pins exact versions; changing a version is a desired-state change.
- Non-npm package sources. The plan kind is a discriminated union so other sources can be added later, but only `npm` is implemented.
- Sandboxing the installed workload beyond the existing isolation, grant, and allowlist controls.

## Decisions

### Install plans travel inside the launch recipe

The install plan is a field on `LaunchRecipe` rather than a sibling of it in `EdgeDesiredDeployment`. This gives three properties for free: the plan is covered by `computeRecipeDigest`, so a package or version change produces a new digest that requires renewed local consent; the existing `assertDeclarative` recursion rejects functions or symbols anywhere in the plan; and protocol-v1 agents that receive an install plan they do not understand still validate the recipe shape.

Because `canonicalRecipePayload` serializes with `JSON.stringify`, an absent `install` field is omitted from the canonical payload, so every existing recipe keeps its current digest.

Alternative considered: a separate `install` field on the desired deployment. Rejected because consent, digests, and staleness checks are all keyed by recipe digest today, and a second unversioned channel would need to duplicate all of them.

### Presence of an install plan changes command resolution

When `recipe.install` is present, `recipe.command` MUST be a bare bin name with no path separator and no traversal segment. The device resolves it to `<managed install dir>/node_modules/.bin/<bin>` and verifies that the real path stays inside the managed install directory. When `install` is absent, `command` keeps its current meaning and is resolved by the operating system.

This keeps a single field with one meaning per mode instead of adding a second command field, and it removes the possibility of a managed-install recipe pointing at an arbitrary absolute path on the device.

### Exact versions only

`packageVersion` must be an exact semantic version. Ranges, `latest`, and dist-tags are rejected at authoring time and again on the device. A range would make the recipe digest a poor proxy for "the code that runs", would let a device drift from its peers, and would silently invalidate the consent the user gave.

### Install execution is a separate seam from workload execution

Installation runs through an `EdgeInstallCommandRunner` seam, not the workload process supervisor. The runner receives an explicit executable, argument vector, working directory, and a minimal environment; there is no shell. The default implementation invokes the package manager with lifecycle scripts disabled (`--ignore-scripts`), auditing and funding output suppressed, a bounded timeout, and a Fentaris-owned cache directory, so a compromised or hostile package cannot execute code during installation.

Tests inject a fake runner that materializes a tree, which keeps installer unit tests hermetic and network-free.

### Staged install with promotion after verification

Installation writes into `<installs root>/.staging/<random>` and is promoted with a directory rename to `<installs root>/<sanitized package>@<version>-<digest prefix>` only after verification succeeds. A failed or partially written install is removed and never becomes visible to launch resolution. A successful install directory is content-addressed by the install digest, so an existing verified install is reused instead of refetched, and two deployments that declare the same package and version share one install.

### Verification steps

Before an install is promoted, the device checks that the installed package's own manifest reports the requested version; that the bin declared by the plan exists and its real path is contained by the install directory; and, when the plan declares an integrity digest, that it equals the integrity the package manager recorded for that package in the generated lockfile. A mismatch is a terminal verification failure for that install digest, not a retryable transient error.

### Policy is evaluated before the network fetch

`EdgeWorkloadPolicy` gains an optional `allowInstall` check evaluated against the install plan before installation starts, so an unapproved package is never downloaded. `ExecutableAllowlistPolicy` answers it from its existing package allowlist, and evaluates managed-install launch plans by package name instead of by resolved command path, because the resolved command for a managed install is a Fentaris-owned path rather than an operator-declared executable. Deny-by-default is preserved: an empty allowlist installs nothing.

### Installation happens during reconciliation, not on first call

The device installs while reconciling desired state, after consent and grants are satisfied. A deployment whose install is pending, failed, or denied is not callable and reports `install-required`. Installing lazily inside the first tool call would put an unbounded network fetch inside a request deadline and would make the first caller absorb a multi-second latency spike.

Install attempts are bounded per install digest with exponential backoff so a permanently failing package does not become a reconnect-driven fetch loop.

### One new readiness status, categories carry the detail

`EdgeDeploymentReadinessStatus` gains `install-required`. Pending, failed, denied, and verification-failure detail is carried in the existing bounded `reasonCategory` field (`install-pending`, `install-failed`, `install-denied`, `install-verification-failed`) rather than in additional statuses. Dispatch already refuses anything that is not `ready`, so the new status blocks calls without changes to the dispatch gate.

The setup-status message gains an optional `install` object with a bounded status, the package identifier, the resolved version, and a reason category. It is optional, so protocol-v1 flows and existing consumers are unaffected. Local paths, cache locations, staging directories, and package-manager output never leave the device.

## Risks / Trade-offs

- Installation depends on an available package manager and network egress on the device. Mitigation: bounded timeout, explicit `install-failed` readiness with an actionable category, and no retry storm.
- A pinned version means security updates require a desired-state change. Mitigation: the digest change makes the update explicit and auditable, and consent is re-requested.
- Managed installs consume disk. Mitigation: installs are shared by digest and pruned when no desired deployment references them.
- Integrity verification relies on the package manager's recorded integrity rather than an independent tarball hash. Mitigation: the check still detects registry substitution and cache poisoning between install and launch, and the plan field is optional so stricter verification can be layered later without a protocol change.

## Migration

Existing deployments are unchanged: no install plan means the current `PATH` behavior. Opting in is per deployment — declare `install: edge.npm({ package, version })` on the stdio transport, publish desired state, and the device installs on the next reconciliation after the user approves the new recipe digest. Rolling back means republishing the previous recipe; the previously installed directory is pruned once nothing references it.
