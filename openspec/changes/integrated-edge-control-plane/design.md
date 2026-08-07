## Context

See `proposal.md` for motivation and `specs/` for normative behavior. The merged agent-native Edge work provides protocol v2, device and presence stores, the reference WebSocket gateway, placement and session selection, capability caching, local setup, the Edge agent, and operator-facing command contracts. It intentionally leaves production adapters replaceable, but the repository currently exposes the pieces rather than an application runtime that composes them.

The concrete gap is bidirectional. `@fentaris/edge` already calls device authorization, token, refresh, enrollment, revocation, and gateway URLs, while `app.start()` currently owns only the downstream MCP exposure. On the server side no supported composition mounts those HTTP operations, upgrades the Edge WebSocket, persists the server enrollment authority, or derives desired deployments from the application's MCP declarations. Examples therefore require callers to instantiate stores and bridge manifests manually, and a real join still needs application-specific routes.

This design is constrained by the security and routing decisions already made in `agent-native-edge-orchestration` and `managed-edge-mcp-installation`: inventory cannot grant access, self-reported metadata is not authority, local consent remains final, session pins cannot silently move, the Edge initiates outbound connectivity, managed deployments require durable/distributed adapters, and Edge devices never define application MCPs independently.

## Goals / Non-Goals

**Goals:**

- Make an explicitly enabled Fentaris application a complete Edge control plane through its normal lifecycle.
- Keep the common local configuration small without hiding whether state is single-process or managed.
- Reuse the merged gateway, stores, protocol, inventory, selection, setup, installation, policy, and telemetry contracts rather than create parallel abstractions.
- Compile and assign application-owned Edge deployments automatically and safely when devices join or reconnect.
- Complete the existing Edge client/server enrollment contract with proof-of-possession, bounded tokens, revocation, and protected state.
- Preserve custom adapter injection for managed multi-instance deployments.

**Non-Goals:**

- Add another Edge protocol, universal remote shell, MCP discovery that becomes trusted configuration, or installation behavior already covered by the managed-installation change.
- Make in-memory/reference adapters production-ready.
- Terminate public TLS inside every Fentaris application; trusted reverse proxies and managed ingress remain supported deployment boundaries.
- Add transparent failover or automatic retry of mutating MCP calls.
- Support live mutation of the application MCP catalog after startup in the first integration. Device hot-plug uses the immutable current application snapshot; declaration changes take effect through a controlled restart and new desired versions.

## Decisions

### Integrate the control plane into `McpProxyOptions.edge`, not a demo helper

The public application model gains an additive `edge.controlPlane` configuration. The intended minimal shape is:

```ts
const app = fentaris({
  edge: {
    controlPlane: {
      enabled: true,
      mode: "local",
    },
  },
});

await app.start();
```

Serializable non-secret fields may also be provided through `fentaris.json` under `edge.controlPlane`; TypeScript config wins only where the documented merge rules permit it. Adapter implementations and authorization callbacks remain TypeScript-only. The normalized configuration includes mode, base path, canonical public origin, protected state location, token and request limits, approval adapter, assignment adapter, and managed infrastructure adapters.

`mode: "local"` installs protected single-process defaults. `mode: "managed"` requires every adapter needed for durable multi-instance semantics and never falls back to local references. Omitting `controlPlane` preserves today's low-level `edge` options and cloud-only behavior.

Alternative considered: publish `createDemoEdge()` or `edgeControlPlane()` as a helper that returns a large options object. It shortens one example but preserves the wrong ownership boundary: application authors would still assemble a security-sensitive subsystem and lifecycle cleanup would remain optional.

Alternative considered: `edge: true`. It is shorter but cannot communicate the local-versus-managed security boundary and risks exposing enrollment routes accidentally.

### Mount Edge routes on one owned exposure with a reserved base path

The integrated runtime registers a reserved base path, defaulting to `/_fentaris/edge`, before the exposure begins listening. The Edge join base URL is the configured public origin plus this path. Existing clients append:

```text
/device/authorize
/device/token
/token/refresh
/edge/enroll
/edge/revoke
```

The gateway uses `/_fentaris/edge/ws`. The downstream MCP endpoint remains independent, usually `/mcp`. The exposure layer gains an internal upgrade registration seam so HTTP and WebSocket ownership are validated and started atomically. A custom exposure incapable of authenticated WebSocket upgrades receives a startup diagnostic rather than a partially working control plane.

The canonical `publicOrigin` is configured, not inferred from request `Host`, `Forwarded`, or `X-Forwarded-*` values. Local mode may derive an HTTP origin only when the configured listener is loopback. Every non-loopback origin must be HTTPS and yields a WSS gateway URL. A trusted ingress may forward traffic, but it does not redefine the public identity of the service per request.

Alternative considered: a second hard-coded control-plane port. It complicates firewalls, TLS, generated commands, health, and lifecycle, and it still requires application authors to expose another server.

Alternative considered: root-level device routes. Keeping the existing client suffixes under a configurable base URL preserves client compatibility without reserving generic application paths globally.

### Add a server-side device authorization and token domain

Core gains a server-side authorization domain behind replaceable stores and approval adapters. A request record contains a random high-entropy device code, separately generated human user code, tenant and client binding, requested metadata, creation/expiry, polling state, approval identity, and one-time consumption state. Stored lookups use hashed secret material where equality is sufficient.

Local mode exposes approval only through a protected local operator channel used by a new command such as:

```text
fentaris edge approve <user-code>
```

The command talks to the running application's owner-protected local control endpoint; it does not edit state files concurrently and the public verification page does not auto-approve. Managed mode supplies an approval adapter backed by its authenticated console or identity system. A browser verification endpoint may render instructions or delegate to that adapter, but approval always records an authenticated actor and exact pending request.

Successful polling issues a short-lived access token and rotating refresh token. Refresh rotation atomically consumes the previous token. Enrollment consumes its device authorization grant. Revocation invalidates every refresh/device credential for the device and terminates the current generation. Raw access, refresh, device, and signing secrets are never stored where a hash or encrypted value suffices.

Alternative considered: auto-approve the first poll in development. It makes a demo easy but turns any reachable endpoint into unattended device enrollment and teaches the wrong product behavior.

Alternative considered: reuse downstream user API keys as device credentials. User identity and long-lived device proof have different rotation, revocation, and possession requirements and must remain separate.

### Formalize the existing proof-carrying handshake

Enrollment verifies a signature by the submitted public key over the server-issued device challenge and nonce before recording the public key. The gateway then looks up that enrolled key and verifies a fresh signature over `{edgeNodeId, nonce, protocol context}` plus the current random device credential. It never treats a public key repeated by the client during connection as authoritative.

The Edge agent already transmits credential and proof material during connection; the protocol parser and types will make the authenticated hello envelope explicit and bounded. The gateway still negotiates protocol v2 through the existing supported-version mechanism and produces a monotonically increasing connection generation. No opaque node ID, hostname, IP address, tag, forwarded header, or observed fact replaces credential and signature verification.

Alternative considered: authenticate only at the WebSocket HTTP upgrade. The current portable agent connector carries its proof in the protocol hello, and retaining message-level negotiation allows transports and managed brokers to share the same authenticated semantics.

### Persist a protected local control-plane store, not ephemeral enrollment

Local mode uses a single-process store rooted under the configured Fentaris auth directory, for example `.fentaris/edge-control-plane`. It persists server identity, hashed authorization/token/device credentials, enrolled public keys, inventory metadata, revocation, aliases, desired versions, acknowledgements, and approval consumption. Writes use owner-only permissions, atomic replacement, schema versions, and a process lock. Encryption keys and signing material reuse the Fentaris protected secret boundary instead of appearing in application config.

Presence, active sockets, and in-flight calls remain ephemeral but their generation counters and safe terminal outcomes are reconciled after restart. Local mode is durable enough for a single application restart but advertises `multiInstance: false`. Managed mode continues to require the distributed consistency properties documented by the merged Edge change.

Alternative considered: keep all reference stores in memory. Losing enrollment, revocation, and desired versions on every restart makes the integrated flow unsuitable even for a reliable demonstration and can re-enable consumed authorization state incorrectly.

### Introduce one application-owned deployment planner and reconciler

At startup, an `EdgeDeploymentPlanner`-style internal domain takes an immutable snapshot of:

- globally registered MCP servers and their stable names;
- transports capable of producing Edge launch recipes;
- setup schemas and optional installation recipes;
- target declarations and placement bindings;
- configured users, groups, catalog visibility, and effective policy;
- device inventory authority, ownership/grants, defaults, aliases, and pools;
- an optional managed assignment resolver for subjects not statically enumerable by the app.

It rejects or withholds declarations that cannot compile to an Edge recipe. For every enrolled device it derives only deployments for which both subject capability access and device/deployment authorization are proven. Named selectors match server-side aliases, pools match managed membership, user defaults match registered defaults, and session/declarative selection may pre-position a deployment only across the subject's authorized devices. Ambiguity never broadens assignment.

The planner returns a canonical ordered desired deployment set and digest. The reconciler compares it with the last persisted per-device snapshot, increments the desired version only when effective content changes, persists before publication, and publishes through the existing gateway/desired-state contract. Enrollment, inventory/grant changes, connection establishment, revocation, and application startup enqueue idempotent per-device reconciliation. One per-device lock and compare-and-set store prevent an older computation from overwriting a newer version.

The gateway invokes reconciliation after authentication and before declaring a connection dispatch-ready. If desired state already exists it may send the current persisted version immediately; a concurrent newer plan follows with a strictly higher version. Readiness and manifests become dispatch-eligible only when connection generation, desired version, recipe digest, setup state, and current manifest agree.

Alternative considered: send every application MCP to every device and rely on call-time policy. That unnecessarily executes setup and code on machines that are not authorized and leaks deployment existence through local prompts.

Alternative considered: let the agent ask which MCPs it wants. This reverses application ownership and makes device claims an authorization input.

### Bridge protocol stores into inventory and capability state once

The integrated composition owns the bridge from authenticated gateway messages to desired acknowledgement, setup, readiness, presence, and capability stores. Capability manifests are validated against the current per-device desired recipe before updating the logical deployment cache used by MCP discovery. Readiness reports similarly remain per device; a manifest from one device does not establish that another device is ready.

This bridge lives in core integration code, not in each application. Existing low-level stores and gateway classes stay public for custom/managed compositions, but the integrated path is the documented default for ordinary applications.

Alternative considered: reuse one tenant/deployment manifest globally without device provenance. It can make an unready device appear callable based on another device's report.

### Make lifecycle ownership atomic and observable

`app.start()` performs the following ordered phases within the existing lifecycle timeout:

1. normalize and validate Edge configuration;
2. open protected state and acquire the local process lock or validate managed adapters;
3. initialize authorization/token/enrollment services and the deployment snapshot;
4. register HTTP and WebSocket routes without listening;
5. initialize gateway, inventory bridges, and reconciliation workers;
6. start the shared exposure;
7. verify route/gateway health and transition ready.

Failure rolls back completed phases in reverse order. `app.stop()` first rejects new authorization/enrollment, stops scheduling reconciliation, drains bounded active work, closes current gateway generations, persists terminal state, closes stores/control endpoints, and finally releases the exposure. The existing runtime state remains the top-level truth.

Health adds an `edge-control-plane` category with safe results for mode, exposure, protected state, adapter diagnostics, authorization service, gateway, protocol distribution, connection freshness, reconciliation lag, desired acknowledgements, readiness, and manifest freshness. Counts are computed only within the caller's authorized scope where health is externally visible.

Alternative considered: start an untracked server from `fentaris(...)` construction. Constructors must remain side-effect free, and unowned listeners cannot participate correctly in readiness or shutdown.

### Preserve compatibility and stage rollout

The existing low-level `edge` runtime options, `EdgeWebSocketGateway`, stores, protocol v1 compatibility, `fentaris-edge` compatibility commands, and Edge Control MCP tools remain available. Integrated control-plane configuration is additive and disabled by default. The client continues accepting an arbitrary control-plane base URL, so existing managed services remain compatible.

The handshake type completion accepts the fields already emitted by the current agent and rejects missing fields only when the integrated authenticated gateway is used. Protocol v1 transparent execution remains available for previously enrolled managed paths; integrated enrollment issues assignments requiring newer behavior only when the negotiated agent version supports them.

## Risks / Trade-offs

- [Risk] Adding enrollment routes to the application server expands its attack surface. → Keep enablement explicit, use a reserved path, enforce body/rate limits, require human approval, isolate device credentials from user auth, and add focused security tests.
- [Risk] Local durable state may be mistaken for production infrastructure. → Report adapter diagnostics in startup and health, fail managed mode with local adapters, and document single-process limits prominently.
- [Risk] Desired-state derivation across groups, targets, and dynamic identities can over-assign workloads. → Require both capability and device authorization, use a canonical planner with fail-closed ambiguity, and test negative cross-user/cross-device cases.
- [Risk] Reverse-proxy headers can create attacker-controlled verification or gateway URLs. → Require a canonical configured public origin and never infer it from untrusted request headers.
- [Risk] Route and WebSocket integration may couple core to one HTTP server. → Extend the internal exposure adapter contract for route and upgrade registration while keeping gateway and domain services transport-neutral.
- [Risk] Token and local-store implementation duplicates a general authorization server. → Keep scopes deliberately narrow to Edge device authorization, use replaceable managed adapters, and avoid OAuth claims beyond the existing device-code-shaped contract.
- [Risk] Application startup may become slower or fail because Edge is degraded. → Only enabled Edge is a required component; apply bounded startup checks and distinguish required control-plane availability from individual offline devices.
- [Risk] The managed installation change may add fields to desired deployments concurrently. → Treat the desired deployment payload as a versioned composition input and consume its installation recipe contracts rather than forking them.

## Migration Plan

1. Add normalized configuration, diagnostics, server-side authorization/token contracts, and protected local store schemas behind disabled integrated control-plane configuration.
2. Add exposure route/upgrade registration and compose the existing gateway with proof validation, revocation, and lifecycle rollback.
3. Add deployment planning and per-device reconciliation against the existing setup, placement, policy, capability, and optional installation contracts.
4. Add the protected local approval channel, `fentaris edge approve`, generated-project support, health checks, and runtime diagnostics.
5. Run protocol, security, restart, two-user/two-device, hot-plug, revocation, and managed-adapter conformance suites before documenting the integrated path as the default self-hosted workflow.
6. Release compatible minor versions of core, CLI, and Edge. Existing applications remain unchanged until they explicitly enable `edge.controlPlane`.

Rollback disables `edge.controlPlane` and returns the application to the existing externally supplied control-plane path. Persisted local enrollment state is retained but unopened so rollback does not silently revoke devices or destroy audit evidence. Re-enabling a compatible version reconciles state and advances connection generations before routing.
