## ADDED Requirements

### Requirement: Unified event registration
The system SHALL support unified event registration through `proxy.on(eventName, handler)` and `proxy.on(eventName, filter, handler)`.

#### Scenario: Proxy registers session event
- **WHEN** an application registers `proxy.on("session:start", handler)`
- **THEN** Fentaris invokes the handler when a downstream MCP session starts

#### Scenario: Proxy registers filtered tool event
- **WHEN** an application registers `proxy.on("tool:success", { server: "github" }, handler)`
- **THEN** Fentaris invokes the handler only for successful tool calls on the GitHub server

### Requirement: Server-scoped event registration
The system SHALL expose server handle event registration as filtered sugar over the proxy event bus.

#### Scenario: Server handle registers tool event
- **WHEN** `github.on("tool:error", handler)` is registered
- **THEN** Fentaris invokes the handler for GitHub tool errors and not for other servers

#### Scenario: Server handle event receives unified context
- **WHEN** a server-scoped event handler runs
- **THEN** the event payload includes the unified `ctx` with the selected server already set

### Requirement: Tool call events
The system SHALL emit explicit tool call events around the tool call lifecycle.

#### Scenario: Tool start event
- **WHEN** Fentaris begins processing an allowed tool call
- **THEN** Fentaris emits `tool:start` with context and timing metadata

#### Scenario: Tool success event
- **WHEN** an upstream tool call completes successfully
- **THEN** Fentaris emits `tool:success` with context, result, and duration metadata

#### Scenario: Tool error event
- **WHEN** a tool call fails before a successful result is returned
- **THEN** Fentaris emits `tool:error` with context, normalized error, and duration metadata

#### Scenario: Tool after event
- **WHEN** a tool call completes with either success or failure
- **THEN** Fentaris emits `tool:after` with context and completion metadata

### Requirement: Tool list events
The system SHALL emit events for tool listing operations.

#### Scenario: Tools list after event can transform tools
- **WHEN** `proxy.on("tools:list:after", handler)` returns a tool array or list result
- **THEN** Fentaris uses the returned tools as the list response

#### Scenario: Tools list event includes subject context
- **WHEN** tools are listed by an authenticated request
- **THEN** the event payload includes the unified context with subject and policy metadata where available

### Requirement: Session events
The system SHALL emit session lifecycle events independently of downstream transport type where the transport has session semantics.

#### Scenario: HTTP session starts
- **WHEN** an HTTP downstream MCP session starts
- **THEN** Fentaris emits `session:start` with transport and subject context

#### Scenario: Session ends
- **WHEN** a downstream MCP session ends or is cleaned up
- **THEN** Fentaris emits `session:end` with transport, subject, and duration metadata where available

### Requirement: Event handler control limits
The system SHALL distinguish observation events from middleware control flow.

#### Scenario: Tool success event does not re-run upstream
- **WHEN** a `tool:success` event handler runs
- **THEN** it observes the completed result and does not cause the upstream call to execute again

#### Scenario: Runtime control uses middleware
- **WHEN** an application needs to deny, mutate, validate, or approve a tool call before execution
- **THEN** it uses middleware or tool routes rather than post-execution observation events
