## Why

Fentaris can already route governed MCP workloads to enrolled edge devices, but operating those devices still requires application-side resolver infrastructure and the AI agent cannot discover, select, or coordinate the machines it is allowed to use. Edge should become a simple, agent-native execution fabric: a user joins a computer once, describes what it is suitable for, and authorized agents can transparently use one machine or explicitly orchestrate several without losing Fentaris policy, consent, isolation, or audit guarantees.

## What Changes

- Productize edge enrollment around a one-command join flow, durable device inventory, persistent background service, automatic reconnect, and machine-readable lifecycle/status commands.
- Extend enrolled-device metadata with user-controlled names and descriptions plus structured tags, platform facts, capabilities, pool membership, health, load, and readiness while separating claimed, observed, and control-plane-managed data.
- Add an agent-native Edge Control MCP surface for bounded inventory discovery, device inspection, session selection, single-edge tool invocation, and multi-edge invocation.
- Preserve normal MCP tool names and transparent target placement as the default path; explicit `edge_call` is an orchestration escape hatch rather than a replacement for ordinary typed MCP tools.
- Support declarative selection by requirements and preferences, with the control plane returning the selected device and a safe explanation of the decision.
- Add parallel multi-edge execution with bounded concurrency, per-edge child execution contexts, aggregate cancellation, stable per-edge result envelopes, partial-failure handling, deadlines, and explicit failure policies.
- Keep authorization, policy, local setup consent, executable allowlists, session isolation, and audit enforcement on every selected edge; inventory and orchestration never grant capabilities by themselves.
- Define production control-plane contracts for durable inventory, active presence, aliases, pools, selection, desired state, session bindings, and distributed channel routing.
- Add `fentaris edge ...` operator commands with canonical JSON envelopes for join, service management, device discovery, metadata updates, status, disconnect, and revoke, while retaining compatible `fentaris-edge` entry points during migration.

## Capabilities

### New Capabilities

- `edge-device-operations`: One-command device join, persistent agent service lifecycle, durable inventory metadata, presence/readiness reporting, device management commands, and production control-plane storage contracts.
- `agent-native-edge-orchestration`: Policy-filtered Edge Control MCP discovery, explicit/declarative selection, single-edge invocation, parallel multi-edge invocation, aggregate results, cancellation, and audit behavior.

### Modified Capabilities

- `edge-agent-runtime`: Extend enrollment and connectivity requirements with descriptive metadata, persistent supervised operation, automatic reconnect, presence/capability reporting, and compatibility behavior for the existing edge CLI.
- `execution-target-placement`: Extend placement with inventory-aware declarative selectors, agent-requested session selection, explainable resolution, and isolated child bindings for multi-edge execution.
- `edge-runtime-setup`: Expose policy-filtered deployment readiness and setup requirements to orchestration while preserving local-only grants and requiring consent independently on every selected device.

## Impact

- Affects `@fentaris/core` edge registry, placement, session binding, proxy dispatch, protocol, policy, telemetry, and control-plane adapter contracts.
- Affects `@fentaris/edge` enrollment, agent lifecycle, platform adapters, local service installation, reconnect behavior, status reporting, setup, and CLI compatibility.
- Affects `@fentaris/cli` with a new `fentaris edge` command domain and stable agent-facing JSON output.
- Adds a virtual Edge Control MCP server or equivalent local capability provider without renaming or duplicating existing upstream MCP tools per device.
- Requires durable managed adapters and distributed channel routing for multi-instance deployments; in-memory adapters remain reference/development implementations.
- Requires documentation, migration guidance, end-to-end multi-device tests, security tests, and minor changesets for compatible public features in the published core, CLI, and edge packages.
