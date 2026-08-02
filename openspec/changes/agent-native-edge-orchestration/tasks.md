## 1. Inventory and Control-Plane Contracts

- [x] 1.1 Add versioned core types for attributed edge inventory metadata, public device references, presence, capacity, load, heartbeat freshness, and per-deployment readiness.
- [x] 1.2 Extend device registry contracts with tenant-scoped name uniqueness, optimistic inventory-version updates, alias retention, listing, filtering, and pagination without exposing credential material.
- [x] 1.3 Add replaceable presence, readiness, session-selection, and child-binding store contracts plus deterministic in-memory reference implementations.
- [x] 1.4 Add conformance tests covering inventory attribution, normalized name collisions, tenant isolation, stale versions, heartbeat expiry, revocation, and in-memory production-readiness warnings.
- [x] 1.5 Add control-plane enrollment and management service contracts for join, metadata update, list/get, disconnect, revoke, and service-safe machine responses.

## 2. Protocol Version 2 and Gateway Compatibility

- [x] 2.1 Define protocol-v2 messages and validators for observed platform facts, agent version, execution features, capacity/load, freshness, and orchestration child correlation.
- [x] 2.2 Implement highest-mutual-version negotiation while preserving version-1 transparent Edge execution and rejecting unsupported or malformed v2 fields.
- [x] 2.3 Extend the gateway to persist authenticated presence/fact reports, expire stale connections, and bind every update to tenant, device, credential, and connection generation.
- [x] 2.4 Extend the edge runtime to report bounded observed facts and dynamic capacity/readiness without treating hostname, description, or tags as identity or authorization.
- [x] 2.5 Add protocol and gateway tests for v1/v2 interoperability, stale generations, forged metadata, oversized reports, freshness expiry, and reconnect reconciliation.

## 3. Policy-Filtered Inventory and Selection

- [x] 3.1 Implement the inventory query service that composes identity, grants, policy, durable metadata, presence, readiness, capability manifests, and freshness into public device views.
- [x] 3.2 Implement authorization-safe filtering and cursor pagination for name, tag, observed feature, platform, pool, status, and deployment readiness.
- [x] 3.3 Implement declarative selection with hard requirements, ranked preferences, bounded candidate evaluation, deterministic tie-breaking, and redacted explanations.
- [x] 3.4 Revalidate eligibility and inventory freshness at dispatch so stale discovery results cannot bypass current policy, readiness, revocation, or capacity state.
- [x] 3.5 Add tests proving inaccessible devices cannot be enumerated through results, totals, cursors, errors, timing-sensitive branches, or selection explanations.

## 4. Persistent Edge Agent Operation

- [x] 4.1 Refactor the edge agent into a long-running supervised runtime with singleton protection, explicit lifecycle states, graceful shutdown, and durable local status.
- [x] 4.2 Implement bounded exponential reconnect with jitter, transient/terminal error classification, backoff reset after stable connection, and desired-state reconciliation before accepting calls.
- [x] 4.3 Add an owner-protected local control channel using Unix sockets and Windows named pipes for status, reconnect, graceful stop, and setup-interaction handoff only.
- [x] 4.4 Add platform service-adapter contracts and launchd, systemd-user, and Windows per-user implementations with install, start, stop, restart, and uninstall operations.
- [x] 4.5 Add foreground fallback behavior for unsupported platforms or insufficient permissions without losing enrollment identity.
- [x] 4.6 Add lifecycle tests with fake service managers and integration tests for singleton enforcement, boot-style restart, reconnect, local channel authorization, and graceful workload cleanup.

## 5. Join and Operator CLI

- [x] 5.1 Add `fentaris edge join <control-plane-url>` with name, description, repeatable tags, service/no-service selection, device authorization, canonical human output, and canonical `--json` output.
- [x] 5.2 Make `npx @fentaris/edge join <control-plane-url>` invoke the same join/service workflow so a supported computer needs no separate global package installation.
- [x] 5.3 Add `fentaris edge run` and `fentaris edge service install|start|stop|restart|uninstall` with explicit local targets, stable exit codes, and actionable failures.
- [x] 5.4 Add policy-aware `fentaris edge list|get|status|update` discovery and metadata commands with compact output, pagination, include/exclude filters, `--as`, and canonical JSON envelopes.
- [x] 5.5 Add guarded `fentaris edge disconnect` and `revoke` mutations with explicit target semantics, confirmation or `--yes`, stable error codes, and safe next actions.
- [x] 5.6 Map legacy `fentaris-edge login|status|disconnect|revoke` behavior onto the new services, preserving documented JSON compatibility and emitting migration warnings.
- [x] 5.7 Add CLI parsing, help, human output, JSON success/failure, pagination, repeated join, confirmation, service fallback, and legacy-compatibility tests.

## 6. Session Selection and Child Bindings

- [x] 6.1 Implement a durable session-selection service keyed by session, subject, and logical target with eligibility validation and session expiry.
- [x] 6.2 Feed an unpinned authorized selection into existing placement and pinning while rejecting selection changes after a target is pinned.
- [x] 6.3 Extend placement resolution with typed declarative requirements/preferences and redacted resolution metadata without changing existing precedence for callers that provide none.
- [x] 6.4 Implement isolated child binding allocation, correlation, expiry, cancellation, and cleanup without mutating parent transparent-session bindings.
- [x] 6.5 Add placement/session tests for pre-pin selection, stale selection, unauthorized selection, immutable pins, parent cleanup, sibling isolation, and reconnect behavior.

## 7. Edge Control MCP Discovery Tools

- [x] 7.1 Register the reserved opt-in `edge` local capability provider through the normal scoped catalog and policy pipeline.
- [x] 7.2 Define stable schemas and structured result types for `edge__list`, `edge__get`, `edge__select`, `edge__call`, and `edge__call_many`.
- [x] 7.3 Implement `edge__list` with bounded filters, compact defaults, cursor pagination, freshness, warnings, and safe next actions.
- [x] 7.4 Implement `edge__get` with attributed metadata and policy-filtered deployment/tool readiness summaries.
- [x] 7.5 Implement `edge__select` using the session-selection service and return actionable errors for pinned, stale, unavailable, and unauthorized choices.
- [x] 7.6 Add discovery tests proving stable public schemas, explicit enablement, policy visibility, bounded output, non-enumerating errors, and no per-device upstream tool duplication.

## 8. Explicit Single-Edge Invocation

- [x] 8.1 Implement effective-tool lookup and current input-schema validation for explicit Edge calls, including exact next actions for schema inspection failures.
- [x] 8.2 Implement server-side public-device resolution and a trusted child proxy context that inherits identity, policy, deadlines, cancellation, trace metadata, and approval context.
- [x] 8.3 Re-enter the normal proxy call pipeline for `edge__call` so catalog visibility, policy, middleware, setup, transport limits, events, and result mapping remain enforced.
- [x] 8.4 Reject Edge Control recursion and prevent untrusted MCP output from overriding routing, device, status, or correlation fields.
- [x] 8.5 Release child bindings and local workloads on success, error, timeout, cancellation, parent-session end, and proxy shutdown.
- [x] 8.6 Add end-to-end tests for successful explicit calls, schema errors, hidden tools, denied devices, setup-required devices, timeout, malformed output, recursion, and parent-pin preservation.

## 9. Multi-Edge Fan-Out Coordinator

- [x] 9.1 Define orchestration configuration and effective-policy limits for maximum devices, concurrency, deadlines, selector complexity, child bytes, and aggregate bytes.
- [x] 9.2 Implement immutable bounded resolution from either an explicit device list or one declarative selector set, rejecting ambiguous or widening inputs.
- [x] 9.3 Implement deterministic scheduling with explicit-order preservation, selector-result sorting, bounded concurrency, shared deadline, and linked parent cancellation.
- [x] 9.4 Implement `collect` semantics with exactly one terminal entry per resolved device and consistent aggregate counts.
- [x] 9.5 Implement `fail-fast` semantics that stops scheduling, cancels cancellable work, and distinguishes failed, cancelled, and not-started entries.
- [x] 9.6 Represent lost mutating calls without an idempotency contract as explicit indeterminate outcomes and prohibit automatic retry or failover.
- [x] 9.7 Enforce per-child and aggregate output limits while preserving sibling results when one child returns oversized, malformed, or non-serializable output.
- [x] 9.8 Add concurrency-controlled end-to-end tests across several simulated devices for all-success, partial failure, fail-fast, setup denial, disconnect, cancellation, deadline, capacity, and aggregate truncation.

## 10. Security, Approval, and Observability

- [x] 10.1 Add aggregate policy evaluation and high-impact approval context containing tool, bounded argument summary, resolved device scope, failure policy, concurrency, and deadline.
- [x] 10.2 Ensure every child independently re-evaluates effective tool policy and local recipe/grant/executable consent after aggregate approval.
- [x] 10.3 Add parent/child orchestration telemetry with redacted selection factors, inventory version/freshness, correlation IDs, timing, status, and cleanup outcome.
- [x] 10.4 Extend redaction and serialization guards for descriptions, observed facts, inventory views, aggregate errors, child outputs, and local service diagnostics.
- [x] 10.5 Add adversarial tests for cross-tenant selectors, forged public names, metadata injection, stale inventory races, approval scope changes, output field spoofing, recursive calls, and cancellation races.
- [x] 10.6 Add health checks for inventory stores, presence expiry, selection service, child binding cleanup, distributed channel routing, protocol-version distribution, and stale readiness.

## 11. Distributed Adapter Verification

- [x] 11.1 Add reusable conformance suites for durable inventory, presence, readiness, selection, binding, and channel-broker adapters.
- [x] 11.2 Add a multi-instance integration harness where proxy selection, gateway connection, desired state, and result handling run in separate process/service instances over injected durable test adapters.
- [x] 11.3 Verify atomic or coordinated round-robin/sticky pool selection behavior and document consistency requirements for managed adapters.
- [x] 11.4 Verify restart recovery for inventory, presence expiry, desired state, selections, child cleanup, and in-flight result correlation.
- [x] 11.5 Surface actionable diagnostics when only reference in-memory adapters are configured for a deployment claiming production readiness.

## 12. Documentation, Release, and Final Verification

- [ ] 12.1 Update concepts and Edge setup guides with zero-global-install join, persistent service operation, metadata attribution, transparent selection, explicit calls, and multi-edge examples.
- [ ] 12.2 Update CLI, Edge API, environment-variable, configuration, troubleshooting, security, observability, and production-adapter reference documentation.
- [ ] 12.3 Document the protocol-v1 compatibility matrix, `fentaris-edge` migration window, rollout order, rollback procedure, and limitations around mutation retry and stateful failover.
- [ ] 12.4 Add example applications demonstrating personal-device transparent routing, declarative selection, shared pools, explicit single-edge calls, and bounded parallel fan-out.
- [ ] 12.5 Run focused core, CLI, and edge tests; then run repository build, typecheck, lint, documentation generation, and strict OpenSpec validation.
- [ ] 12.6 Add minor Changesets for compatible public additions to `@fentaris/core`, `@fentaris/cli`, and `@fentaris/edge`, with release notes emphasizing opt-in Edge Control behavior and legacy CLI compatibility.
