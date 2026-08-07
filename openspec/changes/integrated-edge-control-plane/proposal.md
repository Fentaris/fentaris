## Why

Fentaris now has Edge protocol v2, enrollment clients, inventory, placement, gateway, and orchestration contracts, but a normal `fentaris(...)` application still cannot accept `fentaris edge join`, authenticate the device WebSocket, or reconcile its declared MCP workloads without manually assembling control-plane stores, HTTP routes, and gateway adapters. The missing integration makes the product appear complete at the protocol layer while forcing application authors to recreate security-sensitive infrastructure before a real computer can join.

## What Changes

- Add an integrated Edge control-plane runtime that mounts device authorization, token refresh, enrollment, revocation, and authenticated WebSocket gateway endpoints alongside the normal Fentaris exposure.
- Make `app.start()` and `app.stop()` own the complete single-process Edge control-plane lifecycle when it is enabled, including readiness, graceful shutdown, health, and redacted diagnostics.
- Reconcile application-owned MCP declarations, Edge setup schemas, launch recipes, placements, and current device eligibility into versioned desired state automatically; a newly enrolled or reconnected device receives the current assignments without application-side glue.
- Provide a minimal explicit application configuration for local/single-process use while preserving injection of durable inventory, authorization, token, desired-state, channel, and session adapters for managed multi-instance deployments.
- Add a secure device-code approval path and operator commands so enrollment is never silently auto-approved; keep device credentials, signing material, refresh tokens, opaque node IDs, and local grants out of application code and agent-visible inventory.
- Persist local single-process control-plane identity and enrollment state under the configured Fentaris auth directory with owner-only protection, while clearly diagnosing that local adapters are not multi-instance production infrastructure.
- Extend static and runtime diagnostics to verify public URL, TLS/WSS requirements, endpoint conflicts, credential protection, adapter durability, protocol compatibility, and desired-state reconciliation.
- Preserve all Edge v2 protocol, placement, orchestration, setup, and managed-installation contracts; this change composes them into the application runtime rather than defining another Edge protocol or workload installer.

## Capabilities

### New Capabilities

- `integrated-edge-control-plane`: Application-owned Edge authorization endpoints, enrollment, authenticated gateway exposure, automatic desired-state reconciliation, protected local state, managed adapter injection, and lifecycle integration.

### Modified Capabilities

- `edge-agent-runtime`: Require the existing join, refresh, connect, revoke, and reconnect clients to interoperate end-to-end with an integrated Fentaris application control plane without custom server glue.
- `config-and-validation`: Add supported configuration and fail-closed validation for Edge control-plane paths, public origin, development versus managed adapters, TLS/WSS exposure, and protected local state.
- `runtime-lifecycle-and-health`: Include the enabled Edge control plane, gateway, adapter diagnostics, enrollment service, and desired-state reconciler in application readiness, shutdown, and health behavior.

## Impact

- Affects `@fentaris/core` exposure startup, Edge gateway composition, enrollment/token services, desired-state reconciliation, protected local adapters, health checks, lifecycle, and public application configuration.
- Affects `@fentaris/edge` only where client/server contract completion, refresh, revocation, reconnect, and protocol compatibility require fixes; it does not move MCP ownership onto the device.
- Affects `@fentaris/cli` with local enrollment approval and diagnostics commands plus generated-project guidance.
- Affects `fentaris.json`, generated project templates, Edge/reference documentation, security guidance, and end-to-end tests across a real HTTP/WebSocket boundary.
- Adds compatible public functionality and requires minor Changesets for affected published packages during implementation.
