## ADDED Requirements

### Requirement: Shared HTTP-family upstream auth options
The system SHALL provide shared auth configuration for HTTP-family upstream transports, including native Streamable HTTP/HTTPS and SSE.

#### Scenario: Static headers
- **WHEN** an upstream HTTP-family transport is configured with static headers
- **THEN** Fentaris includes those headers on outbound upstream transport requests where the protocol permits headers

#### Scenario: Bearer token
- **WHEN** an upstream HTTP-family transport is configured with a bearer token
- **THEN** Fentaris sends the token using the `Authorization: Bearer <token>` header

#### Scenario: API key header
- **WHEN** an upstream HTTP-family transport is configured with an API key header name and value
- **THEN** Fentaris sends the configured API key header on outbound upstream transport requests

### Requirement: Per-user auth resolution
The system SHALL allow HTTP-family upstream auth headers or tokens to be resolved from the current user context before calling an upstream server.

#### Scenario: Resolve token from registry-backed user context
- **WHEN** the proxy resolves user secrets or tokens from the registry and an upstream transport uses an auth resolver
- **THEN** the resolver can derive outbound auth headers from the resolved user context for that specific upstream call

#### Scenario: Resolver denies credentials
- **WHEN** an upstream auth resolver cannot produce required credentials for the current user
- **THEN** Fentaris returns a mapped MCP error without sending the upstream request

### Requirement: OAuth token compatibility
The system SHALL support OAuth access tokens as bearer tokens for HTTP-family upstream transports without implementing OAuth acquisition or refresh flows.

#### Scenario: Caller supplies OAuth access token
- **WHEN** a caller supplies an OAuth access token directly or through an auth resolver
- **THEN** Fentaris sends it as a bearer token to the upstream MCP server

#### Scenario: OAuth flow is required
- **WHEN** an upstream server requires Fentaris to perform OAuth discovery, consent, token acquisition, or refresh
- **THEN** Fentaris does not perform that flow in this capability and requires caller-provided credentials or resolver logic

### Requirement: Downstream identity remains proxy-edge auth
The system SHALL keep downstream client authentication and upstream server authentication as separate concerns.

#### Scenario: HTTP downstream identity
- **WHEN** a downstream HTTP or SSE client authenticates to Fentaris using configured identity strategies
- **THEN** Fentaris resolves user context at the proxy edge before applying policy and choosing upstream auth

#### Scenario: Stdio downstream identity
- **WHEN** Fentaris is exposed over stdio
- **THEN** Fentaris uses explicitly configured stdio exposure user context or resolver behavior rather than HTTP request headers
