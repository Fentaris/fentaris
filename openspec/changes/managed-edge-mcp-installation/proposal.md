## Why

Edge deployments can currently receive governed launch recipes and local setup requirements, but they assume the required MCP executable is already available on the target computer. Fentaris needs a governed installation lifecycle so newly connected Edge devices can become ready automatically when safe, while supporting custom MCP sources only after explicit local approval.

## What Changes

- Add declarative MCP installation recipes with versioned identity, preflight detection, supported-platform constraints, verification, and removal behavior.
- Add managed installation providers for package-based, binary, container, and manual prerequisites behind a common adapter contract.
- Add a custom installation provider for pinned Git revisions, integrity-pinned archives, and approved local or enterprise sources.
- Require the Edge operator to review and explicitly approve every new or changed custom installer, including its source, digest, script, requested network access, filesystem scope, and executable requirements.
- Execute custom installers inside a Fentaris-managed working directory with bounded time, output, disk, network, privilege, and process behavior; never grant automatic elevation.
- Extend desired-state reconciliation with per-deployment installation, configuration, startup, readiness, failure, retry, update, and removal states.
- Keep device presence separate from deployment readiness so one Edge can host a mixture of ready, installing, blocked, degraded, and failed MCP deployments.
- Expose only redacted, policy-filtered lifecycle summaries and safe operator next actions to the control plane, CLI, health checks, and Edge Control tools.
- Preserve local authority: denial, revocation, source or digest changes, and permission changes block installation or execution until renewed local consent.

## Capabilities

### New Capabilities

- `edge-managed-installation`: Declarative managed and custom installation recipes, local approval, sandboxed execution boundaries, verification, retry, update, removal, and per-deployment installation lifecycle.

### Modified Capabilities

- `edge-runtime-setup`: Extend Edge setup reconciliation to coordinate dependency preflight and installation before local grants are compiled into a launch plan.
- `edge-agent-runtime`: Extend desired-state reconciliation, status reporting, local revocation, and observability with installation and deployment lifecycle states.

## Impact

- Affects `@fentaris/core` Edge recipe, desired-state, readiness, validation, inventory, health, and public configuration APIs.
- Affects `@fentaris/edge` local setup, protected storage, installer adapters, execution isolation, lifecycle reconciliation, telemetry, and CLI status/setup interactions.
- Adds protocol fields and negotiated compatibility behavior for installation recipes and lifecycle reports; older agents remain usable for deployments without managed installation.
- Requires focused security tests for source integrity, approval invalidation, path containment, privilege denial, redaction, time/resource limits, replay, cancellation, and cleanup.
- Requires Edge documentation for provider selection, custom installer review, lifecycle diagnostics, and operator recovery.
