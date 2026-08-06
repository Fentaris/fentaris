## 1. Public configuration and contracts

- [ ] 1.1 Add the public `EdgeControlPlaneConfig` contracts for disabled, local, and managed deployments, including routes, public origin, stores, approval, and assignment adapters.
- [ ] 1.2 Extend TypeScript and `fentaris.json` configuration resolution so serializable Edge control-plane options merge predictably while callbacks and adapters remain TypeScript-only.
- [ ] 1.3 Add validation diagnostics for conflicting routes, invalid public origins, insecure non-loopback transports, missing managed adapters, and sensitive values embedded in serializable configuration.
- [ ] 1.4 Define bounded protocol contracts for device authorization, token polling and refresh, enrollment, revocation, authenticated gateway hello, and control-plane errors.
- [ ] 1.5 Define internal interfaces for device authorization, token issuance, approvals, enrolled-device storage, desired-state assignments, and reconciliation triggers.

## 2. Protected local authority state

- [ ] 2.1 Define the versioned local authority schema for server identity, authorization sessions, refresh credentials, enrolled devices, revocation state, inventory, assignments, and desired-state versions.
- [ ] 2.2 Implement an atomic owner-only file-backed local store with process locking, crash-safe replacement, schema migration, and corruption diagnostics.
- [ ] 2.3 Hash bearer and refresh credentials at rest, encrypt private signing material, rotate refresh credentials on use, and redact every secret from errors and logs.
- [ ] 2.4 Implement the protected local operator channel used for approval and administrative commands without exposing those operations on the public Edge routes.
- [ ] 2.5 Add restart, concurrent-writer, migration, corruption, permission, token-rotation, and durable-revocation tests for local mode.

## 3. Authorization, enrollment, and revocation services

- [ ] 3.1 Implement device authorization creation and polling with user codes, expiration, polling intervals, slowdown responses, attempt limits, and single-use completion.
- [ ] 3.2 Implement the approval service and local approval adapter with explicit operator confirmation and an auditable subject-to-device grant.
- [ ] 3.3 Implement short-lived Edge access tokens and rotating refresh tokens bound to the approved device, subject, server, and permitted audience.
- [ ] 3.4 Implement enrollment using the existing device-key proof contract and persist the verified device key as the authority for later gateway authentication.
- [ ] 3.5 Implement operator revocation and authenticated self-revocation, including refresh invalidation, desired-state removal, and active gateway termination.
- [ ] 3.6 Add request-size limits, rate limits, replay defenses, confidential error responses, and redacted security telemetry to every authorization route.

## 4. Integrated HTTP and WebSocket exposure

- [ ] 4.1 Extend the exposure abstraction with explicit HTTP route and WebSocket upgrade registration contracts that coexist with the MCP endpoint.
- [ ] 4.2 Mount authorization, token, refresh, enrollment, revocation, and gateway endpoints beneath the configured reserved Edge base path only when the control plane is enabled.
- [ ] 4.3 Generate device and gateway URLs exclusively from the validated canonical public origin and configured paths, never from untrusted request headers.
- [ ] 4.4 Adapt accepted WebSocket connections into the existing Edge gateway transport without changing the protocol-v2 message contracts.
- [ ] 4.5 Authenticate gateway hello proofs against the enrolled public key, enforce freshness and nonce replay protection, and reject client-supplied key substitution.
- [ ] 4.6 Integrate route mounting and upgrade handling into ordered application startup, rollback, drain, and shutdown behavior.

## 5. Desired-state planning and reconciliation

- [ ] 5.1 Compile registered MCP transports, setup schemas, installation recipes, placement declarations, and policy metadata into an immutable deployment catalog at startup.
- [ ] 5.2 Derive device eligibility from authenticated subject grants, groups, policy decisions, placement constraints, enrolled-device identity, and reported inventory.
- [ ] 5.3 Implement named-device, default-device, pool, session, and declarative placement semantics without requiring application-authored gateway wiring.
- [ ] 5.4 Implement the managed assignment-resolver adapter for dynamic identity and fleet systems while preserving deterministic local behavior.
- [ ] 5.5 Produce canonical per-device desired sets with stable digests, compare-and-swap updates, per-device serialization, and version increments only for effective changes.
- [ ] 5.6 Trigger reconciliation on application start, enrollment, connection, inventory or readiness changes, grant updates, assignment updates, and revocation.
- [ ] 5.7 Withhold ambiguous, unauthorized, unsupported, or incomplete deployments and expose bounded reasons instead of dispatching unsafe desired state.

## 6. Gateway, inventory, and capability bridge

- [ ] 6.1 Connect gateway presence, setup state, readiness, installation state, and manifest reports to the configured inventory and desired-state stores.
- [ ] 6.2 Validate desired generation, recipe digest, setup version, and device identity before accepting readiness or installation transitions.
- [ ] 6.3 Publish Edge-hosted MCP capabilities with device provenance and invalidate capability caches when manifests, readiness, assignments, or connections change.
- [ ] 6.4 Gate tool dispatch on current authorization, active assignment, connected presence, matching generation, readiness, and manifest support.
- [ ] 6.5 Implement offline, reconnect, stale-session, duplicate-connection, reassignment, and revocation cleanup semantics.
- [ ] 6.6 Add integration tests proving that gateway reports automatically update inventory, capability discovery, and dispatch eligibility.

## 7. Application lifecycle and health

- [ ] 7.1 Add ordered control-plane startup phases for authority state, authorization services, planner, reconciler, gateway, routes, and application exposure.
- [ ] 7.2 Add reverse-order rollback and idempotent shutdown that stop new joins, drain active work, close sockets, release locks, and preserve durable state.
- [ ] 7.3 Extend health reporting with redacted Edge authority, gateway, reconciliation, adapter, and durable-store status and bounded aggregate counts.
- [ ] 7.4 Make unsafe local configuration and unavailable optional services visible as warnings while treating required managed-adapter failures as unhealthy startup failures.
- [ ] 7.5 Add telemetry and profiler coverage for authorization, enrollment, connection, reconciliation, desired-state publication, dispatch gating, and revocation.

## 8. CLI and developer experience

- [ ] 8.1 Add `fentaris edge approve <user-code>` with interactive confirmation and stable machine-readable output.
- [ ] 8.2 Route local approval and administrative CLI operations through the protected operator channel and refuse direct mutation of authority files.
- [ ] 8.3 Extend project initialization and configuration helpers with the minimal local control-plane configuration while keeping it disabled by default.
- [ ] 8.4 Extend `fentaris check` and doctor diagnostics to verify route conflicts, canonical origin security, local-state permissions, managed adapters, and gateway reachability.
- [ ] 8.5 Add stable CLI error codes and JSON output for expired codes, denied joins, revoked devices, unavailable local authority, and invalid configuration.

## 9. End-to-end verification and security

- [ ] 9.1 Add focused unit tests for configuration, authorization state machines, proofs, token rotation, assignments, desired-state canonicalization, and dispatch gates.
- [ ] 9.2 Add loopback HTTP and WebSocket end-to-end tests using a real Edge agent through authorize, approve, join, connect, reconcile, run, refresh, and revoke.
- [ ] 9.3 Add a two-user and two-device authorization test proving that a restricted user sees only an assigned Edge while an administrator receives all eligible Edge deployments.
- [ ] 9.4 Add a hot-plug test proving that a newly approved Edge becomes usable while the Fentaris application remains running and without catalog mutation.
- [ ] 9.5 Add restart tests proving durable enrollment and revocation, reconnect continuity, desired-state recovery, and invalidation of rotated credentials.
- [ ] 9.6 Add adversarial tests for hostile host and forwarded headers, proof replay, key substitution, token replay, oversized requests, polling abuse, stale generations, and unauthorized dispatch.
- [ ] 9.7 Add managed-adapter conformance tests and reject unsafe multi-instance local mode before accepting enrollment or dispatch traffic.
- [ ] 9.8 Run affected package tests, repository type checks, builds, linting, OpenSpec strict validation, and the release readiness checks required by the Fentaris workflow.

## 10. Documentation, examples, and release preparation

- [ ] 10.1 Document the public configuration, route model, trust boundaries, local and managed deployment modes, approval flow, persistence, recovery, and revocation behavior.
- [ ] 10.2 Replace manual Edge gateway demo wiring with a short supported example based on `edge.controlPlane` and `app.start()`.
- [ ] 10.3 Add a two-user hot-plug Edge demo showing automatic MCP desired state, capability discovery, selection, and policy-controlled dispatch.
- [ ] 10.4 Update troubleshooting and security guidance for origins, TLS, file permissions, operator access, stale devices, adapter failures, and credential rotation.
- [ ] 10.5 Update generated API reference and CLI help snapshots for every new public type, configuration field, command, diagnostic, and stable output contract.
- [ ] 10.6 Add minor Changesets for the affected public packages and prepare migration, compatibility, rollout, and rollback notes for the release.
