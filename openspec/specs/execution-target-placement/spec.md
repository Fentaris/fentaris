# execution-target-placement Specification

## Purpose
TBD - created by archiving change edge-execution-targets. Update Purpose after archive.
## Requirements
### Requirement: Named execution targets

Fentaris SHALL support reusable named execution targets whose kind and selector are independent from MCP server declarations, policies, groups, and users.

#### Scenario: Edge target is declared
- **WHEN** an application declares `app.target("personal-device", edge(...))`
- **THEN** Fentaris registers a logical edge target without registering an additional MCP server

#### Scenario: Existing application declares no targets
- **WHEN** an application registers an MCP server without any target declaration or binding
- **THEN** Fentaris executes the server through the implicit `cloud` target with existing behavior

### Requirement: Scoped MCP target bindings

Fentaris SHALL allow global, group-scoped, and user-scoped MCP handles to bind a registered MCP server to a named execution target.

#### Scenario: Global target binding
- **WHEN** `app.mcp("custom").target("cloud")` is declared
- **THEN** `custom` uses the cloud target for subjects without a more specific binding

#### Scenario: Group target binding
- **WHEN** `app.group("developers").mcp("custom").target("personal-device")` is declared
- **THEN** eligible members of `developers` resolve `custom` through `personal-device`

#### Scenario: User target binding
- **WHEN** `app.user("alice").mcp("custom").target("alice-device")` is declared
- **THEN** Alice resolves `custom` through `alice-device` without creating a second MCP declaration

#### Scenario: User handle does not create identity
- **WHEN** an application declares `app.user("alice")` but no identity provider or subject declaration can resolve Alice
- **THEN** configuration validation reports that the scoped handle references an unresolved subject

### Requirement: Deterministic placement precedence

Fentaris SHALL resolve an allowed explicit session selection before user, group, global, and implicit cloud bindings in that order.

#### Scenario: User binding overrides group binding
- **WHEN** Alice has a user binding for an MCP and also belongs to a group with a different binding for that MCP
- **THEN** Fentaris selects Alice's user-scoped target

#### Scenario: Group binding overrides global binding
- **WHEN** a subject belongs to one group with an MCP target binding and the MCP also has a global target binding
- **THEN** Fentaris selects the group-scoped target

#### Scenario: Allowed session target is selected
- **WHEN** a downstream session requests a target that is among the subject's resolved eligible bindings
- **THEN** Fentaris selects and pins that requested target for the session

#### Scenario: Unauthorized session target is rejected
- **WHEN** a downstream session requests a target that is not among the subject's resolved eligible bindings
- **THEN** Fentaris rejects the selection without revealing inaccessible target or device details

### Requirement: Ambiguous placement rejection

Fentaris SHALL reject placement ambiguity instead of selecting a target from declaration order.

#### Scenario: Known group overlap is ambiguous
- **WHEN** statically overlapping groups bind the same MCP to different targets for the same subject and no user binding resolves the conflict
- **THEN** startup validation reports an actionable placement ambiguity

#### Scenario: Runtime group overlap is ambiguous
- **WHEN** dynamically resolved group membership produces different equally specific targets that could not be validated at startup
- **THEN** the operation fails with a structured placement ambiguity error

#### Scenario: Matching groups converge
- **WHEN** multiple matching groups bind the same MCP to the same target
- **THEN** Fentaris deduplicates the bindings and resolves that target

### Requirement: Placement does not grant capability access

Execution-target bindings SHALL NOT make an MCP server or capability visible or callable when catalog scope or policy denies it.

#### Scenario: Group can place but cannot call
- **WHEN** a subject matches a group target binding but effective policy denies the requested MCP capability
- **THEN** Fentaris denies the operation before dispatching it to the target

#### Scenario: Hidden server remains hidden
- **WHEN** a subject has a target binding for an MCP server outside the subject's visible server catalog
- **THEN** the server and its capabilities remain absent from discovery and routing

### Requirement: Contextual edge device resolution

An edge target SHALL resolve only devices eligible for the authenticated subject, tenant, target selector, deployment, and current connection state.

#### Scenario: Subject default device is resolved
- **WHEN** an edge target uses `userDefaultDevice()` and the subject has one eligible online default device
- **THEN** Fentaris resolves that enrolled device without exposing its physical identifier to application code

#### Scenario: Shared pool device is resolved
- **WHEN** an edge target selects a shared pool and multiple granted devices are healthy
- **THEN** Fentaris applies the target's declared selection strategy only to eligible devices

#### Scenario: Client and edge identities differ
- **WHEN** a cloud-hosted downstream client invokes an MCP assigned to the subject's remote edge
- **THEN** Fentaris routes by the authenticated subject, target binding, and session binding rather than requiring the downstream client identity to match the edge identity

#### Scenario: No eligible device
- **WHEN** a target selector finds no eligible device
- **THEN** Fentaris returns a structured `EDGE_UNAVAILABLE` error with no private device inventory

### Requirement: Session-pinned edge routing

Fentaris SHALL pin each logical edge target to one enrolled device for the lifetime of a downstream MCP session.

#### Scenario: First edge operation creates binding
- **WHEN** the first operation in a downstream session resolves an edge target
- **THEN** Fentaris stores the session, subject, target, edge node, and connection generation binding

#### Scenario: Later operation reuses binding
- **WHEN** the same downstream session invokes another MCP assigned to the same logical edge target
- **THEN** Fentaris routes the operation to the previously pinned edge node

#### Scenario: Pinned device disconnects
- **WHEN** a pinned edge device becomes unavailable during the session
- **THEN** Fentaris returns `EDGE_UNAVAILABLE` and does not silently fail over to another device

#### Scenario: Session ends
- **WHEN** the downstream MCP session ends or its binding expires
- **THEN** Fentaris removes the target binding and releases associated edge workloads

### Requirement: Durable session binding contract

Fentaris SHALL expose a session-target binding store contract suitable for both in-memory and distributed implementations.

#### Scenario: Single-process runtime
- **WHEN** no external binding store is configured
- **THEN** Fentaris uses the reference in-memory binding store

#### Scenario: Distributed runtime
- **WHEN** a durable binding store is configured across multiple Fentaris instances
- **THEN** every instance resolves the same pinned edge for a given session and target

### Requirement: Stable virtual edge routing

Edge connection changes SHALL NOT create per-device public MCP names or require per-device server declarations.

#### Scenario: Device reconnects
- **WHEN** the pinned enrolled device reconnects with a validated new connection generation
- **THEN** the existing MCP server name and proxied capability names remain unchanged

#### Scenario: Two users use different devices
- **WHEN** two subjects resolve the same MCP declaration through different personal devices
- **THEN** both clients observe the same public MCP namespace while operations route to their respective pinned devices

