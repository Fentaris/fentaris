## ADDED Requirements

### Requirement: Native Streamable HTTP upstream transport
The system SHALL provide a native MCP Streamable HTTP upstream transport that connects Fentaris to MCP servers over `http://` and `https://` URLs using MCP protocol semantics.

#### Scenario: List tools through native HTTP upstream
- **WHEN** Fentaris lists tools for a server configured with the native Streamable HTTP upstream transport
- **THEN** the transport initializes or reuses an MCP HTTP session and returns the upstream server's MCP `listTools` result

#### Scenario: Call tool through native HTTPS upstream
- **WHEN** Fentaris calls a tool for a server configured with an `https://` Streamable HTTP upstream URL
- **THEN** the transport forwards the MCP `callTool` request over HTTPS and returns the upstream MCP tool result

#### Scenario: Close native HTTP upstream
- **WHEN** Fentaris closes a server configured with the native Streamable HTTP upstream transport
- **THEN** the transport closes active MCP sessions and releases protocol resources

### Requirement: Native SSE upstream transport
The system SHALL provide a native MCP SSE upstream transport that connects Fentaris to SSE-capable MCP servers and manages the event-stream lifecycle.

#### Scenario: List tools through SSE upstream
- **WHEN** Fentaris lists tools for a server configured with the SSE upstream transport
- **THEN** the transport opens or reuses the SSE MCP connection and returns the upstream server's MCP `listTools` result

#### Scenario: Call tool through SSE upstream
- **WHEN** Fentaris calls a tool for a server configured with the SSE upstream transport
- **THEN** the transport sends the MCP tool request through the SSE transport flow and returns the correlated MCP tool result

#### Scenario: Close SSE upstream
- **WHEN** Fentaris closes a server configured with the SSE upstream transport
- **THEN** the transport closes any active event streams and pending client resources

### Requirement: Stdio upstream env and isolation behavior
The system SHALL continue to support stdio upstream MCP servers with per-user environment injection and optional per-user isolation.

#### Scenario: Per-user stdio environment
- **WHEN** a stdio upstream server is configured with `McpServer.env(user)` and Fentaris receives calls from distinct users
- **THEN** Fentaris creates or reuses env-aware stdio transports keyed by user identity with the resolved environment values

#### Scenario: Per-user stdio isolation
- **WHEN** a stdio upstream server is configured with an isolation runtime
- **THEN** Fentaris queues calls according to the isolation runtime using the resolved user identity

### Requirement: Native and simple HTTP transport distinction
The system SHALL clearly distinguish native MCP Streamable HTTP upstream transport behavior from any simple REST-like HTTP adapter behavior.

#### Scenario: Native HTTP transport is selected
- **WHEN** a user configures the native MCP Streamable HTTP upstream transport
- **THEN** Fentaris uses MCP initialization, session handling, and MCP request semantics rather than fixed `/listTools` and `/callTool` REST endpoints

#### Scenario: Simple HTTP adapter remains available
- **WHEN** the simple HTTP adapter remains exported for compatibility
- **THEN** documentation and type names distinguish it from the native MCP Streamable HTTP upstream transport
