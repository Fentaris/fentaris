## ADDED Requirements

### Requirement: Public core API exports
The core package SHALL export the Fase 0 classes and types needed to create a proxy, define upstream MCP servers, configure stdio transports, log from context, and write middleware.

#### Scenario: Consumer imports core primitives
- **WHEN** an application imports `McpProxy`, `McpServer`, `StdioTransport`, and `Logger` from `@fentaris/core`
- **THEN** the package exposes those symbols from its public entrypoint

### Requirement: Stdio upstream transport
The system SHALL connect to an upstream MCP server through a configurable stdio transport using command, args, env, and stderr options.

#### Scenario: Stdio transport connects on demand
- **WHEN** the proxy needs to list or call a tool for a stdio upstream
- **THEN** the transport starts the configured command and connects an MCP client before forwarding the operation

### Requirement: Tool aggregation
The proxy SHALL aggregate tools from all configured upstream servers and expose namespaced tool names in the form `<server>__<tool>`.

#### Scenario: Multiple upstream tools are listed
- **WHEN** an MCP client requests the proxy tool list
- **THEN** the response contains tools from each upstream with names prefixed by the upstream server name

### Requirement: Tool call routing
The proxy SHALL route a namespaced tool call to the matching upstream server and original tool name.

#### Scenario: Namespaced tool is called
- **WHEN** an MCP client calls `github__create_issue`
- **THEN** the proxy forwards the call to the `github` upstream with tool name `create_issue`

### Requirement: Middleware pipeline
The proxy SHALL execute registered middleware for every tool call before forwarding to the upstream.

#### Scenario: Middleware observes tool call
- **WHEN** a tool call is received and middleware calls `next()`
- **THEN** the proxy continues to the next middleware or upstream call

#### Scenario: Middleware denies tool call
- **WHEN** middleware returns `ctx.res.deny("blocked")`
- **THEN** the proxy returns an MCP tool error response and does not call the upstream server

### Requirement: Context-aware logging
The proxy SHALL provide middleware with a context object containing request metadata, a logger, and a response controller.

#### Scenario: Middleware logs with context
- **WHEN** middleware writes `ctx.log.info("message", metadata)`
- **THEN** the logger receives the message with proxy context fields merged into the metadata

### Requirement: HTTP gateway startup
The proxy SHALL start a streamable HTTP MCP endpoint on a configurable port and path.

#### Scenario: Proxy starts HTTP server
- **WHEN** `proxy.start({ port, path })` is called
- **THEN** the proxy listens for MCP HTTP requests at the configured path
