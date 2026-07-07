## Why

Fentaris can proxy `stdio` MCP servers only on the host where the Fentaris runtime is running, so a cloud-hosted proxy cannot execute MCP servers against an end user's filesystem or other device-local resources. Fentaris needs governed edge execution that preserves normal MCP declarations while letting the control plane select, configure, and route work to enrolled user or shared devices.

## What Changes

- Add reusable execution targets that describe cloud or edge placement independently from MCP declarations, policies, groups, and users.
- Extend global, group-scoped, and user-scoped MCP handles with deterministic target binding while preserving the existing `app.mcp(...)` declaration syntax.
- Resolve execution targets from the authenticated subject and downstream MCP session, pin each session to an eligible edge device, and reject ambiguous or unavailable routing.
- Add typed runtime inputs such as folders and secrets so an MCP declaration can describe values that must be completed during edge onboarding.
- Keep sensitive local grants, including resolved filesystem paths, on the edge while exposing only opaque setup and readiness state to the control plane.
- Add an `@fentaris/edge` agent with browser-based login, device enrollment, an authenticated outbound control/data channel, desired-state reconciliation, and supervised local `stdio` MCP execution.
- Route MCP capability discovery and operations through stable virtual edge transports so device connection changes do not rename MCP capabilities or require per-device server declarations.
- Keep MCP selection and launch configuration under Fentaris control; the local agent only enrolls the device, obtains required local consent, reports readiness, and enforces local safety boundaries.

## Capabilities

### New Capabilities

- `execution-target-placement`: Reusable cloud and edge targets, global/group/user-scoped MCP target bindings, deterministic precedence, device eligibility, and session-pinned routing.
- `edge-runtime-setup`: Typed runtime inputs, cloud-driven setup schemas, local folder and secret grants, launch-plan resolution, readiness, and reconfiguration behavior.
- `edge-agent-runtime`: Edge device enrollment, secure outbound connectivity, desired-state reconciliation, supervised MCP process lifecycle, and proxied MCP operations.

### Modified Capabilities

## Impact

- Extends `@fentaris/core` MCP, group, and new user-scoped fluent handles with target and setup APIs.
- Adds execution-target configuration, validation, session binding, edge transport, and runtime events to core proxy domains.
- Adds a publishable `@fentaris/edge` package and CLI entry point for device enrollment and agent lifecycle.
- Requires a control-plane contract for device registry, target aliases and pools, workload desired state, setup status, and authenticated bidirectional routing.
- Requires security controls for device credentials, command allowlisting, local grants, path containment, secret handling, process isolation, cancellation, timeout, and audit metadata.
- Adds documentation, examples, integration tests, and a minor changeset for the new public APIs and package.
