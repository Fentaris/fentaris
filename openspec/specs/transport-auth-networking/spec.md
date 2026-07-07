# transport-auth-networking Specification

## Purpose
TBD - created by archiving change harden-transport-auth-and-networking. Update Purpose after archive.
## Requirements
### Requirement: Authenticated HTTP session continuation

HTTP Streamable exposure SHALL authenticate or validate a bound session identity on every request that includes an MCP session identifier.

#### Scenario: Continuation without credentials

- **WHEN** a request includes a valid `mcp-session-id` but provides no valid authentication or session binding proof
- **THEN** the exposure transport rejects the request with an authentication error

#### Scenario: Continuation with different identity

- **WHEN** a request resumes a session created by another authenticated identity
- **THEN** the exposure transport rejects the request

### Requirement: Authenticated SSE message posting

SSE exposure SHALL apply identity requirements to both the initial `/sse` connection and subsequent `/messages` POST requests.

#### Scenario: SSE message without auth

- **WHEN** a client posts to `/messages` with a valid session ID but no valid authentication
- **THEN** the exposure transport rejects the message request

### Requirement: Stdio identity enforcement

Stdio exposure SHALL fail startup when `identityRequired` is enabled and no authenticated identity can be resolved.

#### Scenario: Identity required for stdio

- **WHEN** stdio exposure starts with `identityRequired` and no authenticated user context
- **THEN** startup fails with an explicit authentication configuration error

### Requirement: Upstream header allowlisting

HTTP upstream transports SHALL forward only protocol-approved or explicitly configured HTTP headers, not arbitrary environment variables.

#### Scenario: Secret env value present

- **WHEN** upstream HTTP transport is created with env containing `GITHUB_TOKEN`
- **THEN** `GITHUB_TOKEN` is not sent as an HTTP header unless explicitly configured as an allowed header mapping

### Requirement: Localhost exposure default

HTTP and SSE exposure transports SHALL listen on `127.0.0.1` by default when no host is configured.

#### Scenario: Server starts without host

- **WHEN** an HTTP or SSE exposure transport starts with only a port
- **THEN** the server listens on `127.0.0.1`

### Requirement: Upstream URL guardrails

HTTP upstream transports SHALL reject blocked internal, loopback, link-local, and cloud metadata URLs unless explicitly allowed by configuration.

#### Scenario: Metadata URL configured

- **WHEN** an upstream HTTP URL resolves to a cloud metadata address
- **THEN** transport creation fails with an SSRF guardrail error

