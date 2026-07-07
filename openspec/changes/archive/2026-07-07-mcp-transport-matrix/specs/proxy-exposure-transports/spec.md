## ADDED Requirements

### Requirement: Configurable proxy exposure transport
The system SHALL allow callers to choose how Fentaris exposes the MCP proxy to downstream clients while preserving HTTP as the default exposure mode.

#### Scenario: Default HTTP exposure
- **WHEN** a caller starts the proxy using the existing `McpProxy.start()` API
- **THEN** Fentaris exposes the proxy over HTTP Streamable MCP using the existing default port and path behavior

#### Scenario: Explicit exposure transport
- **WHEN** a caller starts the proxy with an explicit proxy exposure transport
- **THEN** Fentaris exposes the same aggregated MCP server through the selected downstream transport

### Requirement: HTTP proxy exposure
The system SHALL expose the Fentaris proxy over HTTP Streamable MCP with session handling, identity resolution, and cleanup behavior equivalent to the current HTTP startup path.

#### Scenario: HTTP request with identity headers
- **WHEN** a downstream HTTP client initializes a Fentaris MCP session with configured identity headers
- **THEN** Fentaris resolves user context at the proxy edge and applies that context to list and call requests for the session

#### Scenario: HTTP session closes
- **WHEN** an HTTP MCP session closes
- **THEN** Fentaris removes the session state and closes the session-specific MCP SDK server resources

### Requirement: Stdio proxy exposure
The system SHALL support exposing the Fentaris proxy over stdio for MCP clients that launch Fentaris as a local MCP server process.

#### Scenario: Stdio client lists tools
- **WHEN** a downstream stdio MCP client sends a `listTools` request to Fentaris
- **THEN** Fentaris returns the aggregated and policy-filtered tool list from configured upstream servers

#### Scenario: Stdio client calls tool
- **WHEN** a downstream stdio MCP client calls a proxied tool name
- **THEN** Fentaris routes the call through middleware, hooks, policy, registry, and the selected upstream server before returning the MCP result

#### Scenario: Stdio exposure closes
- **WHEN** the downstream stdio connection closes or Fentaris shuts down
- **THEN** Fentaris closes stdio exposure resources and configured upstream server transports

### Requirement: SSE proxy exposure
The system SHALL support exposing the Fentaris proxy over SSE for MCP clients that require event-stream-based MCP connectivity.

#### Scenario: SSE client lists tools
- **WHEN** a downstream SSE MCP client sends a `listTools` request to Fentaris
- **THEN** Fentaris returns the aggregated and policy-filtered tool list through the SSE transport flow

#### Scenario: SSE client calls tool
- **WHEN** a downstream SSE MCP client calls a proxied tool name
- **THEN** Fentaris routes the call through the same proxy pipeline used by HTTP and stdio exposure

#### Scenario: SSE exposure closes
- **WHEN** an SSE client disconnects or Fentaris shuts down
- **THEN** Fentaris closes event streams, session state, and session-specific MCP SDK server resources

### Requirement: Shared proxy pipeline across exposure transports
The system SHALL use the same listTools and callTool proxy pipeline regardless of whether Fentaris is exposed over HTTP, stdio, or SSE.

#### Scenario: Middleware applies across exposure transports
- **WHEN** a tool call enters Fentaris through any supported exposure transport
- **THEN** Fentaris applies registered hooks, middleware, policy decisions, registry resolution, logging, and error mapping consistently
