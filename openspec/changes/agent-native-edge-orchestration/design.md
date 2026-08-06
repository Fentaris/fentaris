## Context

See `proposal.md` for motivation. The current Edge implementation already separates MCP definitions, setup schemas, logical targets, placement bindings, session pinning, a virtual `EdgeTransport`, a versioned WebSocket protocol, local consent, and supervised per-session MCP workloads. It also exposes reference gateway and in-memory store contracts. The missing architecture is the operational and agent-facing layer around that foundation.

Several constraints shape the design:

- ordinary MCP tools must keep their existing names and schemas;
- physical device identifiers, local paths, grants, credentials, and private inventory must not become agent-visible routing inputs;
- target placement does not grant tool or device access;
- a normal downstream session is stateful and cannot silently move after pinning;
- explicit fan-out must reuse the normal proxy policy and middleware pipeline rather than bypassing it;
- the existing protocol version and `fentaris-edge` CLI need an additive migration path;
- in-memory stores remain useful for tests and single-process development but are not a production control plane.

The existing agent-native tool discovery change provides the canonical CLI JSON envelope and progressive schema-discovery conventions. This change reuses those contracts rather than defining another machine-output style.

## Goals / Non-Goals

**Goals:**

- Make joining and persistently running an Edge device a single operator workflow on macOS, Linux, and Windows.
- Give agents a compact, policy-filtered and dynamically refreshed inventory of usable computers.
- Preserve transparent placement while adding explicit single-device and bounded multi-device orchestration.
- Reuse existing authorization, policy, setup, transport, session, cancellation, telemetry, and error paths.
- Define durable control-plane seams and versioned data contracts suitable for a managed multi-instance deployment.
- Make partial success, cancellation, indeterminate mutation outcomes, and high-impact approvals explicit.

**Non-Goals:**

- Replace ordinary typed MCP tools with a universal Edge wrapper.
- Allow arbitrary remote shell execution unless a governed MCP deployment explicitly provides it.
- Let self-reported descriptions, tags, or capabilities grant authorization or prove readiness.
- Provide transparent failover for stateful pinned sessions.
- Provision cloud VMs, autoscale pools, or implement provider-specific schedulers in this change.
- Synchronize files between devices or expose local grant values to the control plane.
- Automatically retry mutating calls without an explicit idempotency contract.

## Decisions

### Keep transparent placement as the primary execution path

Existing effective tools such as `filesystem__read_file` retain their schemas and route normally through placement and session pinning. Most agents should call these tools directly and let Fentaris use a default, named target, or pool.

The new Edge Control surface is an explicit orchestration layer for cases where the agent needs to inspect machines, select one intentionally, or invoke the same effective tool on several devices. It does not publish one copy of every tool per connected device.

Alternative considered: expose `mac-studio__filesystem__read_file` for every device. This makes tool discovery unstable, multiplies context size, leaks inventory through capability names, and couples public names to connection state.

Alternative considered: replace all effective tools with `edge_call`. This loses the upstream input schema at the point where the agent normally constructs calls and makes the common path harder.

### Expose Edge Control as a reserved local MCP namespace

Fentaris registers a reserved local capability provider named `edge` with logical tools:

```text
edge__list
edge__get
edge__select
edge__call
edge__call_many
```

It uses the existing scoped catalog, policy engine, middleware, events, tool naming, and local capability declaration machinery. The namespace is enabled explicitly in application/control-plane configuration and remains governed; enabling Edge execution alone does not automatically make inventory tools visible to every caller.

Collection tools return bounded MCP `structuredContent`. Where textual content is required for compatibility, it contains a concise rendering of the same structure rather than a different data contract.

Alternative considered: special protocol methods outside MCP. Those would require agent-specific client integration and would bypass the capability governance Fentaris already applies to tools.

### Separate inventory identity and metadata by authority

The durable device record is split conceptually into four sections:

```ts
interface EdgeInventoryRecord {
  tenantId: string;
  edgeNodeId: string;
  credentialId: string;
  subjectId?: string;
  revoked: boolean;
  inventoryVersion: number;
  user: {
    name: string;
    description?: string;
    tags: string[];
  };
  observed?: {
    platform: string;
    architecture: string;
    agentVersion: string;
    executionFeatures: string[];
    capacity?: Record<string, number>;
    reportedAt: number;
  };
  managed: {
    aliases: string[];
    pools: string[];
    grants: string[];
  };
}
```

Connection presence, heartbeat, load, and per-deployment readiness are stored separately because they are high-churn state with different expiry and consistency requirements. Inventory views join the durable record with a presence/readiness snapshot.

Names are tenant-scoped stable public selectors and must be unique under normalized comparison. Renaming changes the public selector but not `edgeNodeId`. Existing aliases can be retained for a bounded migration period. Agent-visible results use names; internal routes continue to use opaque IDs resolved server-side.

User tags and descriptions aid semantic selection but never satisfy authorization, observed-feature, deployment-readiness, or local-consent checks. Selection explanations preserve this attribution.

Alternative considered: one untyped metadata object. It is easy to extend but makes it impossible to distinguish claims, measurements, and administrator grants safely.

### Resolve inventory queries through a policy-filtered service

A central `EdgeInventoryService`-style domain boundary composes:

1. authenticated tenant and subject;
2. device grants and Edge Control policy;
3. durable inventory metadata;
4. active connection and heartbeat freshness;
5. capacity/load snapshot;
6. visible deployment readiness and capability manifests.

Both `fentaris edge list/get` and `edge__list/get` use this service. Filtering and cursor pagination happen after authorization scoping, so totals, cursors, and errors cannot enumerate inaccessible devices. Default results are compact. Verbose descriptions, readiness summaries, or observed facts require explicit include fields.

The service returns a public `deviceRef` derived from the stable tenant-scoped name plus inventory version. It never returns credentials, device keys, grant references, absolute paths, or private hardware identifiers.

### Use hard constraints followed by ranked preferences

Declarative selection accepts a bounded structure:

```json
{
  "target": "team-workers",
  "requires": {
    "tags": ["development"],
    "features": ["filesystem", "xcode"],
    "platform": ["darwin"],
    "deployment": "filesystem"
  },
  "prefer": ["lowest-load", "user-default"],
  "strategy": "least-loaded"
}
```

Resolution first applies tenant, subject grants, policy, online presence, readiness, capacity, and every `requires` field. Preferences only rank the eligible remainder. A deterministic strategy breaks ties. The returned explanation lists satisfied requirement categories and applied preferences, not hidden candidates or private rejection reasons.

Selector evaluation has explicit limits on tag count, feature count, candidates examined, and result count. The resolver consumes one consistent-enough inventory snapshot and records its version/freshness in telemetry.

Alternative considered: accept a free-form natural-language description. This would be convenient but nondeterministic and difficult to authorize or audit. Agents can translate natural intent into the typed selector.

### Preserve pinning for `edge__select`

`edge__select` records an authorized requested device or logical target in a session-selection store keyed by `{sessionId, subjectId, targetName}`. The first ordinary edge-dependent operation passes that selection into the existing placement and pinning path.

If the target is already pinned, selection fails. If the requested device becomes unavailable before the first call, the call fails rather than silently substituting a different device. The agent can start a new downstream session or explicitly choose again before pinning.

This store is durable/replaceable in distributed deployments and expires with the downstream session. It does not modify application placement bindings or make an otherwise ineligible target selectable.

Alternative considered: let `edge__select` move an active pin. Stateful MCP processes make that unsafe and surprising.

### Re-enter the normal proxy for explicit calls

`edge__call` accepts:

```json
{
  "edge": { "name": "mac-studio" },
  "tool": "filesystem__read_file",
  "arguments": { "path": "README.md" },
  "timeoutMs": 30000
}
```

The orchestrator resolves the public device selector server-side, looks up the requested tool in the caller's effective catalog, validates arguments against its current input schema, and creates a child `ProxyContext` containing the same authenticated identity plus a server-generated child session/request ID and explicit eligible device selection. It then re-enters the normal call pipeline so policy, approvals, middleware, setup, transport limits, events, and result mapping run as usual.

The orchestrator refuses recursion into `edge__call` or `edge__call_many`, and it cannot invoke a tool hidden from the parent caller. The child context is always released at terminal completion.

Tool output remains untrusted MCP output. It is placed only in the result payload; routing, selected-device, status, and correlation fields are created by Fentaris and cannot be overwritten by an edge result.

Alternative considered: call `EdgeTransport` directly. That would bypass effective-tool resolution and central policy behavior.

### Implement fan-out as a bounded coordinator over child calls

`edge__call_many` accepts either an explicit device list or one declarative selector set, never both. It additionally accepts:

```json
{
  "mode": "parallel",
  "maxConcurrency": 4,
  "failurePolicy": "collect",
  "timeoutMs": 120000
}
```

The coordinator:

1. authorizes the effective tool and orchestration request;
2. resolves a bounded immutable device snapshot;
3. evaluates high-impact approval with the exact resolved scope;
4. allocates one child request/session binding per device;
5. schedules child calls through a concurrency limiter;
6. links the parent abort signal and shared deadline to every child;
7. collects a terminal entry for every resolved device;
8. releases all child bindings and returns aggregate counts.

Explicit input order is preserved in results. Declaratively selected devices are ordered by normalized public name for deterministic output. Status values are `succeeded`, `failed`, `cancelled`, and `not-started`.

`collect` lets independent children finish. `fail-fast` stops scheduling, cancels cancellable in-flight work, and preserves results already received. Cancellation is best effort across the network; a disconnected mutating child without an idempotency contract becomes `failed` with an indeterminate-outcome error detail.

The global configuration and effective policy cap resolved device count, per-request concurrency, deadlines, aggregate output bytes, and per-device output bytes. User inputs can only reduce those limits.

Alternative considered: reuse one downstream session binding and change its device before every call. That violates pinning and creates cross-device process-state ambiguity.

### Do not add automatic retry in the first orchestration release

The coordinator never automatically retries a dispatched mutating operation. Read-only/idempotent retries are also deferred until Fentaris has a stable tool effect/idempotency metadata contract that policy can inspect. Transport-level delivery correlation continues to reject late or mismatched results, but correlation is not treated as proof that an upstream mutation did not occur.

This favors explicit indeterminate outcomes over accidental duplicate side effects.

### Extend the protocol additively with negotiated version 2

Protocol version 2 adds bounded observed-device facts, capacity/load heartbeat fields, inventory/presence freshness metadata, child orchestration correlation, and any new lifecycle events. Existing MCP request route semantics remain intact.

The gateway negotiates the highest mutually supported version. Version 1 agents continue transparent Edge execution but are excluded from selectors requiring version-2 facts and cannot claim support for agent-native readiness they do not report. The control plane must not infer missing v2 facts from hostnames or user tags.

Alternative considered: overload version 1 optional fields indefinitely. A negotiated version makes validation and rollout behavior explicit while preserving compatibility.

### Add a local supervisor control channel for service-aware CLI commands

Persistent operation requires the CLI process to communicate with the running agent rather than inspecting only its own memory. The edge package adds a protected local control channel:

- Unix domain socket on macOS/Linux;
- named pipe on Windows;
- owner-only permissions and a random local control credential;
- commands limited to status, reconnect, graceful stop, and setup interaction handoff;
- no arbitrary command execution.

Platform service adapters install native definitions:

- launchd user agent on macOS;
- systemd user service on Linux, with documented foreground fallback;
- per-user Windows service/task adapter, with documented fallback where service installation is unavailable.

`fentaris edge join` defaults to service installation when supported. `--no-service` keeps foreground operation. `fentaris edge run` is the explicit foreground/service executable entry. Service mutations require explicit targets or the local installation and support canonical JSON results.

Alternative considered: keep `login` as a forever-running foreground command. It is simple internally but makes status, disconnect, restart, boot persistence, and ordinary user expectations unreliable.

### Standardize operator CLI and compatibility mapping

The new command domain is:

```text
npx @fentaris/edge join <control-plane-url>   # zero-global-install bootstrap
fentaris edge join <control-plane-url>
fentaris edge run
fentaris edge service install|start|stop|restart|uninstall
fentaris edge list|get|update
fentaris edge status
fentaris edge disconnect
fentaris edge revoke
```

Discovery commands support `--json`, `--compact`, `--limit`, `--cursor`, `--include`, `--exclude`, and `--as` where relevant. Mutations support `--json`; destructive or broad mutations require explicit target and confirmation. All JSON results use `{ ok, data|error, pagination, warnings, nextActions }` with stable `SCREAMING_SNAKE_CASE` errors.

During migration:

- `fentaris-edge login` maps to join using the configured environment URL;
- `status`, `disconnect`, and `revoke` use the new local/control-plane services;
- human output includes a concise deprecation notice;
- JSON compatibility output remains stable for the documented period and adds warnings rather than unrequested prose.

### Make managed durability explicit

Core adds or extends replaceable contracts for:

- durable inventory and versioned metadata updates;
- presence and heartbeat expiry;
- deployment readiness and capability summaries;
- session selections and child bindings;
- atomic pool strategy coordination where required;
- distributed edge channel request/result delivery.

The managed implementation is expected to use durable storage plus pub/sub, but core contracts do not require a particular database or broker. Reference in-memory implementations remain deterministic for tests and development and surface a production-readiness warning through health diagnostics.

### Apply policy and approval at both aggregate and child boundaries

Inventory visibility, selection, requested tool visibility, and orchestration limits are authorized before device resolution details are returned. An aggregate high-impact approval includes tool ID, arguments summary, resolved device count, public device names or pool, failure policy, and deadline.

Each child still passes through normal tool policy and local edge consent. A later child denial cannot be overridden by aggregate approval. Telemetry links one parent orchestration ID with child request IDs, target, device, deployment, timing, terminal state, and redacted selection factors.

## Risks / Trade-offs

- [Risk] A universal explicit call tool has a generic `arguments` object and is harder for an agent to construct correctly. → Keep normal typed tools primary, validate against the effective schema, and return a concrete next action for `fentaris tools schema` on failure.
- [Risk] Descriptions and tags may be inaccurate or malicious. → Attribute metadata sources and never use user-managed fields as grants, observed features, or readiness proof.
- [Risk] Dynamic inventory changes between listing and calling. → Treat list results as snapshots, resolve and authorize again at dispatch, and return explicit stale/unavailable errors.
- [Risk] Fan-out can amplify destructive actions and cost. → Require bounded limits, exact-scope approval for high-impact calls, per-child policy, no widening, and no automatic mutation retry.
- [Risk] Aggregate results can exceed model context or transport limits. → Cap child and aggregate bytes, return bounded errors, and support compact summaries with per-child correlation for follow-up inspection.
- [Risk] Persistent services increase cross-platform complexity. → Isolate native behavior behind platform adapters, provide foreground fallback, and test lifecycle contracts separately from OS integration tests.
- [Risk] Version-1 agents lack trusted descriptive facts. → Preserve transparent operation, mark facts unknown, and exclude them only when a selector explicitly requires unavailable v2 data.
- [Risk] Durable adapters can observe temporarily inconsistent inventory and presence. → Use inventory versions, heartbeat freshness, server-side revalidation at dispatch, and deterministic terminal errors instead of assuming strong global transactions.
- [Risk] Re-entering the proxy could create recursive control calls. → Explicitly reject Edge Control tools as orchestration targets and track parent/child depth in trusted context.

## Migration Plan

1. Add versioned inventory/presence models, adapter contracts, reference in-memory implementations, and health diagnostics without changing existing target behavior.
2. Add protocol-v2 negotiation and agent fact/presence reporting while retaining version-1 transparent execution.
3. Add local service adapters, local control channel, `fentaris edge` commands, and legacy `fentaris-edge` compatibility mapping.
4. Add the policy-filtered inventory query service and durable session-selection contract.
5. Add the reserved Edge Control MCP namespace behind explicit configuration and policy.
6. Add isolated single-edge child execution, then bounded multi-edge coordination and aggregate approval/audit.
7. Add production durable adapters in the managed control plane, deployment migrations, multi-instance tests, and operational dashboards/alerts.
8. Enable the new surface incrementally per tenant/application. Existing applications continue using transparent placement throughout rollout.

Rollback disables the Edge Control namespace and new selectors while leaving existing v1/v2 agents and transparent Edge routing operational. CLI service installation can be removed without revoking device identity. Schema migrations retain old identity and placement fields until the compatibility window ends.
