## 1. Public Target and Runtime Input Contracts

- [x] 1.1 Add public cloud/edge execution-target, device-selector, target-selection-strategy, and target declaration types in `@fentaris/core`.
- [x] 1.2 Add `runtime.input(...)`, `runtime.secret(...)`, and serializable runtime-value token types with validation and safe inspection helpers.
- [x] 1.3 Extend `StdioTransportOptions` to accept runtime-value tokens in supported argument and environment positions while preserving plain-string compatibility.
- [x] 1.4 Add public setup field builders for folder, file, secret, string, boolean, number, and select inputs.
- [x] 1.5 Add MCP setup schema types and a normalized, versioned launch-recipe representation.
- [x] 1.6 Export target, selector, runtime input, setup, recipe, and error contracts from the supported core entrypoints.
- [x] 1.7 Add focused type and unit tests for target builders, selector composition, runtime tokens, setup builders, and launch-recipe serialization.

## 2. Fluent Target, User, and Setup APIs

- [x] 2.1 Add `app.target(name, target)` registration and target retrieval with duplicate, invalid-name, and unknown-target diagnostics.
- [x] 2.2 Extend global MCP handles with `.setup(schema)` and `.target(name)` while preserving existing middleware, event, health, and declaration behavior.
- [x] 2.3 Extend group-scoped MCP handles with `.target(name)` and record group placement bindings independently from server visibility and policy.
- [x] 2.4 Add `app.user(id)` and user-scoped MCP handles that record placement bindings without creating or authenticating a subject.
- [x] 2.5 Normalize fluent and constructor-style target, setup, and placement declarations into one internal configuration model.
- [x] 2.6 Add validation for unresolved user handles, missing targets, duplicate bindings, incompatible setup fields, undeclared runtime references, unused required fields, and unsafe secret defaults.
- [x] 2.7 Add fluent API and configuration-validation tests covering global, group, user, target, setup, and backward-compatible no-target declarations.

## 3. Placement Resolution

- [x] 3.1 Add execution placement binding and scope models for global, group, and user contexts.
- [x] 3.2 Implement placement resolution with allowed explicit-session, user, group, global, and implicit-cloud precedence.
- [x] 3.3 Detect statically overlapping group bindings with different targets and emit actionable startup diagnostics.
- [x] 3.4 Reject dynamically ambiguous group placements at runtime and deduplicate matching bindings that converge on one target.
- [x] 3.5 Ensure placement resolution runs only after server catalog visibility and policy authorization and never grants capability access.
- [x] 3.6 Implement logical device selectors for session device, user default device, named alias, and shared pool strategy through a control-plane resolver interface.
- [x] 3.7 Add tests for precedence, explicit target authorization, catalog/policy isolation, cross-group ambiguity, aliases, pools, and no-eligible-device errors.

## 4. Session Target Bindings

- [x] 4.1 Define session-target binding, connection-generation, expiry, and store contracts.
- [x] 4.2 Implement the reference in-memory session-target binding store with atomic create/read/delete and expiry cleanup.
- [x] 4.3 Propagate downstream session identity into proxy operation context for HTTP, SSE, and supported stdio exposure paths.
- [x] 4.4 Lazily resolve and pin `{ session, subject, target }` to one eligible edge node before the first edge-dependent operation.
- [x] 4.5 Reuse a pinned device across all MCP declarations using the same logical target in one downstream session.
- [x] 4.6 Remove bindings and notify dependent workloads on session end, expiry, or runtime shutdown.
- [x] 4.7 Reject silent device takeover or failover and return normalized placement, unauthorized-target, and `EDGE_UNAVAILABLE` errors.
- [x] 4.8 Add unit and integration tests for pinning, reuse, expiry, reconnect generations, session cleanup, disconnect behavior, and a shared-store adapter fixture.

## 5. Target-Aware MCP Dispatch

- [x] 5.1 Make proxy-context-aware transport execution an explicit contract available to every MCP capability operation.
- [x] 5.2 Add a target-aware dispatcher that invokes the configured transport for cloud placement and the edge transport for edge placement without replacing the catalog server.
- [x] 5.3 Compile and validate cloud launch recipes, rejecting unresolved edge-only inputs before process startup or dispatch.
- [x] 5.4 Define normalized edge MCP request/result/error/cancellation envelopes for tools, resources, templates, prompts, completion, and ping.
- [x] 5.5 Implement `EdgeTransport` request correlation, deadlines, cancellation, late-result rejection, and structured error mapping.
- [x] 5.6 Preserve existing policy, middleware, operation routing, response transformation, profiler, and audit behavior around edge-dispatched operations.
- [x] 5.7 Add transport tests for every MCP operation, cancellation, timeout, malformed response, unavailable edge, and unchanged public name mapping.

## 6. Edge Control-Plane and Gateway Contracts

- [x] 6.1 Define versioned edge protocol messages for hello, heartbeat, desired state, setup/readiness, capability manifests, MCP operations, cancellation, and lifecycle events.
- [x] 6.2 Define replaceable device registry, desired deployment, setup status, capability manifest, edge connection, and channel broker contracts.
- [x] 6.3 Implement reference in-memory stores with documented single-instance limitations.
- [x] 6.4 Implement the reference outbound WebSocket gateway with protocol negotiation, request correlation, heartbeat, backpressure, and connection cleanup.
- [x] 6.5 Authenticate gateway connections with device-bound credentials and bind them to tenant, edge node, protocol version, and monotonically increasing connection generation.
- [x] 6.6 Authorize every inbound and outbound message against server-side device, deployment, subject, target, and session state.
- [x] 6.7 Implement idempotent desired-state publication and acknowledgement with stale-version rejection.
- [x] 6.8 Add gateway security and lifecycle tests for forged routing fields, replay, old generations, duplicate messages, malformed frames, disconnects, and broker/store adapters.

## 7. Edge Package and Enrollment

- [x] 7.1 Scaffold the publishable `@fentaris/edge` workspace package, executable entry point, TypeScript configuration, build, test, and package metadata.
- [x] 7.2 Implement platform adapters for protected device key storage, local configuration, process supervision, paths, and credential storage.
- [x] 7.3 Implement browser/device authorization login, random keypair creation, device proof, enrollment, token refresh, and secure reconnect.
- [x] 7.4 Implement `fentaris-edge login`, `status`, `disconnect`, and `revoke` commands without an MCP add/configuration command.
- [x] 7.5 Ensure status and errors redact private paths, secrets, credentials, tokens, and full command environments.
- [x] 7.6 Add enrollment and CLI tests for first login, repeat login, copied non-secret configuration, hostname changes, revoked credentials, and disconnected status.

## 8. Edge Setup and Local Grants

- [x] 8.1 Implement desired setup requirement ingestion keyed by deployment, recipe digest, and setup schema version.
- [x] 8.2 Define the pluggable local setup provider contract and implement the initial terminal provider with explicit workload and resource consent.
- [x] 8.3 Implement local folder and file grants with canonicalization, access metadata, opaque IDs, and persistent storage.
- [x] 8.4 Implement edge-local secret grants using the operating-system credential store when available and a documented protected fallback.
- [x] 8.5 Implement string, boolean, number, and select field collection and validation without leaking locally scoped values.
- [x] 8.6 Compile declarative launch plans locally, substitute resolved grants, and reject unsupported code payloads or stale desired-state versions.
- [x] 8.7 Enforce traversal, symlink containment, and read/write grant checks whenever filesystem-sensitive values are resolved.
- [x] 8.8 Reconcile setup schema changes so only affected grants become pending and dependent workloads stop until consent is restored.
- [x] 8.9 Add setup and security tests for missing fields, incompatible types, denied/revoked grants, path escape, secret redaction, stale setup responses, and post-login assignments.

## 9. Edge Workload Supervisor

- [x] 9.1 Implement desired-deployment reconciliation that starts, updates, blocks, and removes only cloud-defined MCP workloads.
- [x] 9.2 Implement one supervised MCP process/client per `{ deployment, downstream session }` with idempotent creation.
- [x] 9.3 Enforce approved recipe digest, executable/package policy hooks, setup readiness, startup deadline, idle lease, operation deadline, output limits, and concurrency quotas.
- [x] 9.4 Implement graceful process shutdown followed by forced termination and orphan cleanup on session end, desired-state removal, disconnect, or expiry.
- [x] 9.5 Connect supervised local MCP clients to edge protocol request, response, error, cancellation, and ping handling.
- [x] 9.6 Make local deny, workload revocation, and grant revocation override replayed desired state until renewed consent.
- [x] 9.7 Add supervisor tests for session isolation, duplicate desired state, concurrent sessions, startup failure, quotas, cancellation, forced termination, revocation, and orphan cleanup.

## 10. Capability Discovery and Readiness

- [x] 10.1 Capture local MCP capability manifests after successful initialization and report them with deployment and recipe digests.
- [x] 10.2 Validate and cache capability manifests through the control-plane store without creating per-device MCP names.
- [x] 10.3 Return no edge capabilities and actionable readiness diagnostics before the first successful manifest.
- [x] 10.4 Preserve cached discovery names while a previously ready edge is offline and fail attempted operations with `EDGE_UNAVAILABLE`.
- [x] 10.5 Invalidate manifests when recipe or relevant capability state changes and integrate with existing list-change notification seams where available.
- [x] 10.6 Add discovery tests for initial setup, ready devices, offline cached devices, recipe changes, two subjects on different devices, and capability name stability.

## 11. Observability, Health, and Security Hardening

- [x] 11.1 Add normalized edge error codes for placement ambiguity, unauthorized target, setup required, edge unavailable, capacity, protocol, workload, and grant failures.
- [x] 11.2 Emit structured events for target resolution, session binding, connection generations, desired-state reconciliation, setup transitions, workload lifecycle, request duration, timeout, cancellation, and failure.
- [x] 11.3 Add health contexts and built-in checks for edge gateway, target resolution, device/pool availability, deployment readiness, and capability cache age.
- [x] 11.4 Add centralized redaction for device credentials, local paths, secrets, environment values, authorization fields, and edge protocol payloads.
- [x] 11.5 Add configurable executable/package allowlists and require explicit local consent for new recipe digests.
- [x] 11.6 Add adversarial tests for cross-tenant routing, cross-user routing, session fixation, stale connection takeover, recipe tampering, secret/path leakage, and unauthorized process launch.

## 12. End-to-End Verification

- [x] 12.1 Add a fixture MCP requiring a runtime folder input and exposing tool, resource, prompt, and completion capabilities.
- [x] 12.2 Add an end-to-end test from authenticated downstream MCP client through Fentaris, edge gateway, agent, local fixture MCP, and back.
- [x] 12.3 Verify a cloud-hosted client can operate on the explicitly granted filesystem of a remote edge device.
- [x] 12.4 Verify different users resolve the same MCP namespace to different personal devices without cross-device data access.
- [x] 12.5 Verify group and user placement precedence, shared pools, ambiguous group rejection, edge disconnect, reconnect, cancellation, and session cleanup end to end.
- [x] 12.6 Run focused core and edge tests, repository typecheck, lint, full recursive test suite, and production build.

## 13. Documentation and Release

- [x] 13.1 Document the definition/setup/target/placement model and explain why target bindings do not grant MCP access.
- [x] 13.2 Add reference documentation for `app.target`, `edge(...)`, runtime inputs, setup fields, `.target(...)`, `app.user(...)`, stores, gateway adapters, and edge errors/events.
- [x] 13.3 Add an onboarding guide covering edge installation, login, device selection, local consent, status, revocation, and troubleshooting.
- [x] 13.4 Add examples for a personal filesystem edge, group-scoped personal devices, a shared worker pool, and cloud fallback.
- [x] 13.5 Document managed multi-instance adapter requirements, protocol/version compatibility, security boundaries, and single-process reference limitations.
- [x] 13.6 Regenerate typed API reference and verify documentation links, snippets, commands, and configuration names.
- [x] 13.7 Add a minor Changeset for the additive `@fentaris/core` APIs and new `@fentaris/edge` package.
