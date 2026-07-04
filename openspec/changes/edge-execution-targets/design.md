## Context

Fentaris currently registers each upstream as an `McpServer` backed by a concrete `FentarisTransport`. A `StdioTransport` starts its child process on the Fentaris runtime host, and the scoped server catalog resolves server visibility for global and group contexts. This works for cloud and self-hosted upstreams but cannot reach an end user's filesystem or other device-local resources when the proxy runs remotely.

Edge execution crosses several trust and lifecycle boundaries:

- application authors must continue declaring an MCP once, without creating one server per device;
- the control plane decides which MCP workload is desired and who may use it;
- the authenticated downstream subject and MCP session determine the eligible execution target;
- an enrolled device must consent to sensitive local resources without trusting cloud-supplied absolute paths;
- the proxy and edge agent need correlated request, cancellation, capability, readiness, and process lifecycle semantics;
- devices can disconnect, reconnect, or be shared across multiple users, groups, and sessions.

The existing catalog already resolves servers from request context and anticipates future user and session scopes. Edge placement should compose with that model rather than changing MCP names or treating every device as a new server registration.

## Goals / Non-Goals

**Goals:**

- Preserve normal `app.mcp(name, options)` declarations and add placement as an orthogonal concern.
- Provide reusable named targets and global, group, and user-scoped target bindings that follow existing fluent handle syntax.
- Support personal devices, named device aliases, and shared device pools without embedding physical device IDs in application code.
- Pin downstream sessions deterministically to eligible edge devices and reject ambiguous or unavailable routing.
- Represent edge launch configuration as a serializable recipe containing typed runtime input references.
- Let Fentaris drive setup and desired state while keeping resolved local paths and local secret values on the edge.
- Add a separately publishable `@fentaris/edge` agent that enrolls devices, maintains an outbound authenticated connection, supervises MCP processes, and forwards all supported MCP operations.
- Preserve policy, middleware, events, timeouts, errors, and audit context across the cloud-to-edge boundary.

**Non-Goals:**

- Synchronize or upload the user's filesystem to cloud storage.
- Infer arbitrary MCP command-line semantics from package names, README text, or runtime behavior.
- Let the edge CLI independently add MCP servers or override cloud MCP definitions.
- Route by hardware identifiers, IP address, network proximity, or downstream client ID.
- Execute arbitrary JavaScript functions serialized from the cloud.
- Provide transparent failover to another device after a session has been pinned.
- Introduce shared stateful MCP processes across unrelated downstream sessions in the first release.
- Build a native desktop GUI in the first release; setup interaction is exposed through an interface with a terminal implementation.

## Decisions

### Keep MCP definition, setup, target, and placement separate

The public model has four distinct concepts:

```text
MCP definition -> setup schema -> execution target -> scoped placement binding
```

An MCP remains registered through `app.mcp(...)`. Runtime references can appear in serializable transport options, and the MCP handle declares the corresponding setup schema:

```ts
app.mcp("custom", {
  transport: stdio({
    command: "custom-server",
    args: ["--workspace", runtime.input("workspace")],
    env: {
      API_TOKEN: runtime.secret("token"),
    },
  }),
});

app.mcp("custom").setup({
  workspace: edge.folder(),
  token: edge.secret(),
});
```

Targets are reusable named declarations:

```ts
app.target("personal-device", edge({
  device: edge.sessionDevice().or(edge.userDefaultDevice()),
}));

app.target("team-workers", edge({
  device: edge.pool("team-workers"),
  strategy: "least-loaded",
}));
```

Placement uses the same scoped-handle grammar already used for middleware:

```ts
app.mcp("custom").target("cloud");
app.group("developers").mcp("custom").target("personal-device");
app.user("alice").mcp("custom").target("personal-device");
```

`cloud` is an implicit built-in target that executes the configured transport on the Fentaris host. `app.user(id)` adds a subject-scoped handle; it does not create or authenticate a user.

Alternative considered: `app.mcp(name).edge(...)`. This couples setup and placement, duplicates target definitions, and does not scale to user/group overrides or shared pools.

Alternative considered: a separate `.placement().forGroup(...)` DSL. It is expressive but introduces a second scoping grammar when Fentaris already has global and group-scoped MCP handles.

### Resolve placement with explicit precedence and ambiguity rejection

Placement bindings contain `serverName`, `scope`, and `targetName`. Supported scopes are global, group, and user. Resolution uses:

1. explicit session target selection, if it is allowed by the resolved bindings;
2. user-scoped binding;
3. matching group-scoped bindings;
4. global binding;
5. implicit `cloud` when no placement is declared.

Multiple matching group bindings are valid only when they resolve to the same target. Different targets are a configuration error for statically overlapping groups and a structured runtime ambiguity error when overlap cannot be known at startup. Declaration order never decides placement.

Visibility and authorization remain separate. A target binding does not grant access to an MCP that the catalog or policy would otherwise hide or deny.

Alternative considered: numeric priorities. They can be added later if real use cases require them; deterministic specificity plus ambiguity rejection is easier to audit initially.

### Treat target names as logical resolvers, not device identities

An edge target contains a serializable selector:

- `sessionDevice()` selects an eligible device requested during downstream session establishment;
- `userDefaultDevice()` selects the subject's configured default device;
- `namedDevice(alias)` resolves a control-plane alias;
- `pool(name)` resolves an eligible shared device using an explicit strategy.

The control plane owns device aliases, pool membership, subject grants, health, capacity, and default-device preferences. Each installation receives a random `edgeNodeId` backed by a device keypair; Fentaris does not use mutable hostnames or privacy-sensitive hardware IDs as identity.

A client ID identifies the downstream application and is never used as the device routing key. A cloud-hosted client can select an eligible remote device through the same authenticated subject and session metadata as a local client.

### Pin target resolution for the downstream session

The runtime stores a binding keyed by downstream MCP session and logical target:

```text
{ sessionId, subjectId, targetName } -> { edgeNodeId, connectionGeneration }
```

All MCP servers using the same logical target in that session resolve to the same device. The binding is created lazily before the first target-dependent capability operation, then remains stable until session end. Reconnection by the same enrolled node can resume only when the control plane validates the device credential and advances the connection generation.

If the pinned device becomes unavailable, calls fail with a structured `EDGE_UNAVAILABLE` error. Fentaris does not silently move stateful work to another machine. A new downstream session can resolve a different eligible device.

Session bindings have an idle/fixed expiry and are removed during downstream session cleanup. The binding store is an interface so distributed deployments can use shared persistence rather than process memory.

### Use a target-aware virtual transport instead of per-device MCP servers

The configured `McpServer` remains stable in the server catalog. Target resolution selects one of two execution paths:

- the cloud target invokes the configured transport locally;
- an edge target invokes an `EdgeTransport` that sends a normalized MCP operation envelope to the pinned device.

The transport receives the unified proxy context, including subject and downstream session ID, through the existing proxy-context-aware transport seam. That seam is made explicit in public/internal contracts rather than relying on transport-specific casting.

The edge envelope supports tools, resources, resource templates, prompts, completion, ping, cancellation, progress-compatible metadata, and normalized errors. Request IDs are unique and idempotently correlated. Edge results return through the normal proxy pipeline, so policy, middleware, events, logging, timeouts, and audit behavior remain unchanged.

Alternative considered: dynamically add one `McpServer` per connected device. That creates name collisions, changes discovery as devices connect, and bypasses the scoped server model.

### Make stdio launch options serializable recipes

`stdio(...)` accepts runtime value tokens in argument and environment positions while retaining plain-string compatibility. A transport with unresolved values cannot start on a cloud target and fails configuration validation unless every reference has a cloud-side value.

For edge execution, Fentaris serializes a versioned launch recipe containing:

- executable and argument templates;
- environment templates;
- client metadata and stderr policy;
- setup schema identifiers;
- package/recipe digest;
- workload and isolation policy.

The recipe contains data only. The edge agent resolves supported tokens and starts the local process; it never evaluates cloud-supplied JavaScript.

Known MCP integrations can later provide reusable recipe helpers, but the first release requires application authors to declare how runtime inputs map into command arguments or environment variables. Automatic inference from arbitrary packages is explicitly rejected because it cannot be made deterministic or safe.

### Separate cloud-managed setup intent from local grants

Setup fields use a typed schema. The first release supports folder, file, secret, string, boolean, number, and select inputs, with required/optional state, labels, descriptions, defaults where safe, and access metadata for filesystem grants.

The control plane sends unresolved setup requirements as part of desired state. The edge setup provider collects local values. Folder and file values are canonicalized and stored as local grants; local secrets use the operating-system credential store when available. The control plane receives only an opaque grant reference, schema/version digest, and readiness status unless a field is explicitly declared cloud-visible.

At launch time the agent resolves grant references locally, verifies containment and requested access, and substitutes values into the recipe. Path traversal and symlink escape checks occur on every filesystem-sensitive resolution, not only during onboarding.

Changing an MCP recipe or setup schema invalidates only affected grants. Revoking a grant stops dependent workloads and reports the deployment as blocked. Adding a new cloud assignment triggers setup without requiring the user to log in again.

Alternative considered: collect absolute paths in the cloud dashboard. This leaks local topology and lets the cloud request paths the user never approved.

### Keep the edge CLI minimal and cloud-directed

The initial commands are limited to enrollment and agent lifecycle:

```text
fentaris-edge login
fentaris-edge status
fentaris-edge disconnect
fentaris-edge revoke
```

`login` uses browser/device authorization, creates or loads a device keypair, registers the device, starts desired-state synchronization, and invokes the local setup provider for pending grants. It does not accept commands for adding MCP servers.

The setup provider is pluggable. The first implementation uses terminal prompts with path validation and explicit command/resource consent. A future desktop or local-web provider can add native file pickers without changing the control-plane protocol.

### Use an authenticated outbound edge channel and desired-state protocol

The agent opens an outbound TLS connection to an edge gateway, allowing operation behind NAT without inbound ports. Enrollment produces a device-bound credential; reconnects use short-lived tokens proven by the device key. The server binds every connection to tenant, subject/device grants, protocol version, and a monotonically increasing connection generation.

The versioned protocol has separate control and operation message families:

- enrollment result, hello, heartbeat, capability, and health;
- desired deployments, setup requirements, grant/readiness status, and acknowledgements;
- MCP request, result, error, cancellation, and lifecycle events.

Messages include protocol version, device ID, deployment ID, downstream session ID, request ID, deadlines, and trace metadata. The gateway rejects mismatched tenant/device/deployment/session fields and never trusts routing identifiers supplied only by the agent.

The core exposes gateway and store interfaces plus a reference WebSocket implementation. Deployment state and session bindings are behind adapters so a managed cloud can use durable databases and pub/sub.

### Isolate local MCP processes per downstream session

The first release starts one MCP process per `{deployment, downstreamSessionId}` and terminates it on session end or idle timeout. This prevents state and initialization data from leaking across unrelated sessions and maps naturally to a single local MCP client connection.

The agent enforces startup timeout, operation deadline, output limits, graceful termination, forced-kill fallback, and maximum concurrent workloads. Command execution requires an acknowledged, versioned desired deployment. A local deny/revoke always overrides cloud desired state.

Shared process modes are deferred until an MCP can explicitly declare safe multiplexing semantics.

### Cache capability manifests without changing public names

After starting a deployment, the edge reports its MCP capability manifest keyed by deployment and recipe digest. Fentaris caches the latest valid manifest. Device connection changes never change server prefixes or proxied capability names.

When no manifest has ever been observed, discovery returns no capabilities for that edge deployment and emits setup/readiness diagnostics. When a cached manifest exists but the pinned device is offline, discovery can remain stable while calls fail with `EDGE_UNAVAILABLE`. Manifest changes invalidate the cache and use existing list-change notification seams when supported; notification support itself is not introduced by this change.

### Expose edge lifecycle through existing observability primitives

Core emits structured events for target resolution, session binding, device connection changes, desired-state reconciliation, setup blocked/ready transitions, workload start/stop/failure, edge request duration, timeout, cancellation, and normalized errors. Sensitive setup values, local paths, secrets, raw credentials, and full command environments are redacted.

Health checks report target resolver state, gateway state, device/pool availability, deployment readiness, and cached capability age without exposing private local configuration.

## Risks / Trade-offs

- [Risk] Cloud-directed command execution creates a remote-code-execution boundary on enrolled devices. → Require device-bound authentication, explicit first-run workload consent, versioned signed desired state, local revocation, command/setup audit, and configurable executable/package allowlists.
- [Risk] A device can disconnect during a stateful operation. → Pin sessions, propagate deadlines/cancellation, return `EDGE_UNAVAILABLE`, clean up orphaned work, and never fail over silently.
- [Risk] Group memberships can produce conflicting targets. → Validate known overlaps and reject unresolved ambiguity at runtime rather than using declaration order.
- [Risk] Capability discovery can be stale while an edge is offline. → Key manifests by recipe digest, expose cache age/readiness, and fail calls explicitly when the pinned device is unavailable.
- [Risk] One process per session consumes more resources. → Enforce quotas and idle cleanup; defer shared processes until isolation semantics are explicit.
- [Risk] Cross-platform path, process, and credential-store behavior differs. → Hide platform operations behind edge adapters and test Linux, macOS, and Windows normalization and termination behavior.
- [Risk] Runtime input tokens broaden existing `stdio` types. → Preserve plain strings, reject unresolved tokens on cloud targets, and provide actionable validation paths.
- [Risk] A single runtime process cannot provide durable routing for a managed multi-instance cloud. → Define stores and channel brokers as interfaces and keep the reference in-memory implementation explicitly non-distributed.

## Migration Plan

1. Add target, placement, runtime-input, edge gateway, and store contracts behind additive APIs in `@fentaris/core`.
2. Preserve implicit cloud placement for every existing MCP declaration, so current applications behave unchanged.
3. Add validation and in-memory reference implementations before enabling any external edge connection.
4. Add `@fentaris/edge` with enrollment, desired-state synchronization, setup storage, and supervised process execution.
5. Add end-to-end tests with a reference gateway and a fixture filesystem MCP before documenting the feature as available.
6. Add managed-cloud durable adapters and deploy the gateway behind an opt-in feature flag.
7. Roll back by disabling edge targets and gateway enrollment; MCPs with explicit edge-only placement become unavailable while ordinary cloud targets remain unchanged.

## Open Questions

- Should the first reference edge channel use WebSocket frames directly or a transport-neutral broker adapter with WebSocket supplied only by the managed cloud?
- Which device authorization provider and token format will be canonical for self-hosted Fentaris versus Fentaris Cloud?
- Should explicit session-device selection be carried in OAuth authorization details, endpoint/environment metadata, or a pre-session control-plane selection?
- Which executable/package allowlist policy should be enabled by default for personal devices and shared organizational pools?
- Is `app.user(id)` the preferred public name for subject-scoped handles, or should the API use `app.subject(id)` to match internal terminology?
