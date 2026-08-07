## Context

See `proposal.md` for motivation. Edge currently receives a versioned desired deployment containing a declarative launch recipe and setup schema. The local setup manager records recipe approval and grants, compiles runtime values, and the workload supervisor starts session-isolated MCP processes. Readiness is reported as `ready`, `setup-required`, or `blocked`, but there is no first-class dependency preflight, installation artifact, install attempt, or update/removal lifecycle.

Custom installation is uniquely sensitive: source retrieval and script execution combine supply-chain, network, filesystem, privilege, persistence, and secret-handling risks. The design must preserve the current rule that only cloud-defined desired deployments become callable while leaving final execution authority with the local Edge operator.

## Goals / Non-Goals

**Goals:**

- Add a provider-neutral, digest-addressed installation model that precedes setup and workload launch.
- Support common managed providers and arbitrary custom scripts from immutable Git, archive, inline, local, or enterprise sources.
- Make exact local review and consent mandatory for custom execution and separately revocable from workload and grant consent.
- Provide useful per-deployment lifecycle, recovery, inventory, CLI, and agent-visible diagnostics without leaking local data.
- Make reconciliation idempotent, crash-aware, compatible with dynamic desired-state updates, and safe across reconnects.

**Non-Goals:**

- Installing operating systems, desktop applications such as Photoshop, drivers, or privileged system packages automatically.
- Providing unrestricted remote shell access or treating locally discovered MCPs as automatically trusted catalog entries.
- Guaranteeing container-grade isolation on platforms that cannot enforce the requested controls.
- Transferring centrally decrypted user credentials into arbitrary installers or Edge workloads.
- Automatically retrying destructive custom scripts or rolling back external side effects that lack an explicit contract.

## Decisions

### Separate installation recipes from launch recipes

Add a versioned `InstallationRecipe` alongside the existing `LaunchRecipe`. Its digest covers provider kind and version, immutable source descriptor, entrypoint/interpreter and arguments, platform/runtime constraints, requested execution capabilities, verification contract, output mapping, retention, and optional cleanup identity. Desired deployments reference both digests.

The installation recipe produces a verified local artifact root plus declared outputs. The launch recipe consumes those outputs through serializable installation references such as an installed executable or path; it never receives an unverified arbitrary path from installer output.

This keeps installation mutations out of the stable MCP launch contract and permits deployments without installation recipes to retain current behavior. The alternative—embedding install commands in `StdioTransportOptions`—would mix one-time host mutation with per-session process execution and make approval identity ambiguous.

### Use provider adapters behind one lifecycle coordinator

Core defines serializable recipe and lifecycle contracts. The Edge package owns an `InstallationCoordinator` and provider adapters for managed packages, Python environments, integrity-pinned binaries/archives, containers, manual prerequisites, and custom installers. Organization-specific sources implement a source resolver or provider adapter but still return content into the common staging and verification pipeline.

Providers do not report readiness directly. They implement preflight, stage/install, verify, and managed cleanup operations, while the coordinator owns approval, locking, attempts, persistence, limits, telemetry, and state transitions. This prevents a connector for a team drive or artifact store from bypassing Edge policy.

### Model custom sources as immutable content plus a reviewed execution plan

Supported custom source descriptors are:

- Git repository plus exact commit and optional integrity-pinned submodules;
- archive URL plus cryptographic digest;
- inline script content included in the recipe digest;
- local file/folder through an Edge grant;
- opaque enterprise artifact reference resolved by an approved adapter to digest-verified content.

The plan selects an entrypoint inside the staged root, a closed interpreter identifier or approved executable, arguments, environment references, expected outputs, network mode, filesystem scopes, limits, and verification. Authenticated URLs and credentials are never placed in the recipe; local setup secrets are handed only to the source resolver.

Floating Git branches, unpinned package tags, unchecked archives, escaping symlinks, and unverifiable provider outputs fail validation. The alternative—allowing a raw remote shell command—would prevent meaningful review, reproducibility, and integrity binding.

### Bind local approval to the complete effective plan

Custom installer consent is stored by an `approvalDigest` derived from the complete recipe plus locally resolved non-secret policy decisions. The approval screen shows source identity, content/revision digest, script or entrypoint content, interpreter, arguments, network request, filesystem scopes, executable requirements, privilege statement, limits, expected outputs, verification, and cleanup behavior.

Any change invalidates approval. Installation approval, launch recipe approval, source credential grants, and runtime grants remain independent. Revoking any required authorization blocks new execution and stops dependent workloads where their continuing operation would violate local authority.

A separate approval is required before running a custom cleanup script because removal can be more destructive than deleting a Fentaris-managed directory.

### Enforce capabilities or fail closed

Custom installers run as the Edge service user in a per-attempt staging directory and write final artifacts only under a Fentaris-managed installation root. The runner applies process-tree supervision, deadline, output and disk limits, executable policy, canonical path containment, environment allowlisting, and no-elevation checks.

Network and filesystem isolation are capability-negotiated platform adapters. If local policy requires a control and the platform cannot enforce it, execution is blocked with `isolation-unavailable`; Fentaris never labels a best-effort restriction as enforced. Scripts that require elevation become manual prerequisites rather than receiving `sudo`, administrator tokens, or interactive privilege prompts.

### Keep installation, setup, activation, and readiness distinct

Persist a local installation record keyed by installation recipe digest and an attempt record keyed by a random attempt ID. Deployments reference an installation record, setup state, launch recipe, activation, and capability manifest.

Detailed lifecycle states are:

```text
assigned -> checking -> approval-required -> installing -> installed
installed -> configuring -> starting -> ready -> degraded
checking/configuring/starting/installing -> failed
approval-required -> blocked
any terminal or active state -> removing -> removed
```

Public readiness remains normalized for compatibility, while version-aware clients receive detailed lifecycle and redacted reason metadata. Device presence remains independent, so an online Edge can host deployments in different states. Selection accepts only online, fresh, capacity-eligible devices whose requested deployment is `ready`.

### Activate verified versions atomically

Installation occurs in a fresh digest-addressed directory. Verification checks declared artifacts, executable containment, version/integrity evidence, and provider-specific invariants. Only after verification does the coordinator atomically update the active pointer used by new MCP sessions. Existing session workloads retain their pinned artifact until session cleanup; no new session receives a partially installed version.

The previous managed artifact may be retained according to bounded retention policy for rollback. Fentaris can switch the active pointer back only when the previous artifact remains verified and the installation had no declared external side effects. Otherwise it reports manual recovery rather than pretending rollback is safe.

### Reconcile idempotently and persist crash outcomes

One mutation lock applies per installation root. Replaying the same desired version or recipe digest observes the existing active or terminal attempt rather than spawning another. Explicit retry creates a new attempt and preserves the earlier terminal audit record.

On Edge restart, the coordinator proves or forces termination of any orphaned process tree, marks the attempt `interrupted`, validates staged and active roots, and reconciles current desired state. Reconnect alone never triggers reinstallation. Removal reference-counts shared digest-addressed artifacts and deletes only Fentaris-managed content automatically.

### Extend the Edge protocol additively

Introduce a negotiated protocol revision carrying installation recipes, detailed lifecycle status, attempt correlation, redacted reason codes, and approval-required metadata. Older agents continue executing deployments without installation recipes. A deployment requiring managed installation on an older agent reports `agent-upgrade-required` and is not selected.

Control-plane stores persist desired installation identity and bounded lifecycle summaries; sensitive attempt details remain local. Edge Control inventory filters installation visibility through the same device and deployment authorizers used for readiness.

## Risks / Trade-offs

- [Risk] Approved custom scripts can still be malicious or compromise user-accessible data. → Display the exact effective plan, require immutable identity and explicit consent, enforce local policy and containment, and recommend managed providers for routine use.
- [Risk] Script side effects may not be reversible. → Require declared side-effect and cleanup behavior, never promise automatic rollback, and require separate approval for custom cleanup.
- [Risk] Cross-platform isolation differs substantially. → Use capability-negotiated adapters and fail closed when required controls are unavailable.
- [Risk] Package-manager lifecycle scripts can execute code even under a managed provider. → Treat provider execution as code, pin version/integrity, apply the same resource and executable policy, and surface provider-specific risk in consent.
- [Risk] Large artifacts and logs can exhaust disk or control-plane bandwidth. → Enforce local quotas and bounded redacted summaries; never upload raw installer logs by default.
- [Risk] Source credentials could leak through URLs, process arguments, or child environments. → Resolve credentials locally, use non-argv provider channels, construct an allowlisted environment, and redact known values before persistence.
- [Risk] Multiple deployments can race to mutate a shared installation. → Use digest-addressed roots, per-root mutation locks, reference counts, and atomic activation.
- [Risk] Detailed lifecycle expands protocol and state-store complexity. → Preserve normalized compatibility readiness and gate detailed fields through negotiated protocol support.

## Migration Plan

1. Add core recipe, validation, lifecycle, reason-code, adapter, protocol, and compatibility contracts without changing existing deployments.
2. Add local persistent installation and attempt stores plus lifecycle coordinator and status reporting behind an opt-in installation recipe.
3. Implement managed/manual providers and the custom source staging, approval, bounded runner, verification, and cleanup path.
4. Integrate installation reconciliation before existing setup and workload startup, then add inventory, health, Edge Control, CLI, and telemetry surfaces.
5. Roll out the control plane before new Edge agents. Existing agents continue handling launch-only deployments; managed-install deployments remain upgrade-required until compatible agents connect.
6. To roll back, stop assigning installation recipes and preserve verified local artifacts. Existing launch-only desired state and protocol behavior continue unchanged.
