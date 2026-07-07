## ADDED Requirements

### Requirement: Deterministic credential precedence
The system SHALL resolve credentials using deterministic precedence: user credentials, then group credentials, then default credentials.

#### Scenario: User credential overrides group credential
- **WHEN** a user credential and group credential exist for the same credential reference
- **THEN** Fentaris uses the user credential for that authenticated subject

#### Scenario: Group credential overrides default credential
- **WHEN** a group credential and default credential exist for the same credential reference and no user credential exists
- **THEN** Fentaris uses the group credential for subjects in that group

#### Scenario: Default credential fallback
- **WHEN** no user or group credential exists and a default credential exists for the reference
- **THEN** Fentaris uses the default credential

### Requirement: Multiple group credential resolution
The system SHALL resolve credentials deterministically when a subject belongs to multiple groups.

#### Scenario: Multiple groups provide credential
- **WHEN** more than one effective group provides the requested credential reference
- **THEN** Fentaris uses a deterministic configured group order or reports an ambiguity error according to the configured conflict mode

#### Scenario: No credential found
- **WHEN** no user, group, or default credential exists for a required upstream auth binding
- **THEN** Fentaris returns a safe MCP error and does not send the upstream request

### Requirement: Upstream auth binding application
The system SHALL apply upstream auth bindings automatically for configured MCP servers.

#### Scenario: Bearer binding
- **WHEN** an upstream binding for a server uses bearer auth and references a credential
- **THEN** Fentaris resolves the credential for the authenticated subject and injects `Authorization: Bearer <credential>` into compatible upstream transport requests

#### Scenario: Header binding
- **WHEN** an upstream binding for a server uses header auth with a header name and credential reference
- **THEN** Fentaris resolves the credential for the authenticated subject and injects the configured header into compatible upstream transport requests

#### Scenario: Env binding
- **WHEN** an upstream binding for a stdio server uses env auth with an env var name and credential reference
- **THEN** Fentaris resolves the credential for the authenticated subject and injects the configured env value into the env-aware stdio transport path

### Requirement: No application secret access
The system SHALL allow upstream auth to work without application code reading raw credential values.

#### Scenario: Server declaration without manual auth
- **WHEN** a developer declares an MCP server and configures an upstream auth binding for that server
- **THEN** Fentaris resolves and injects upstream auth automatically during listTools and callTool without requiring `user.secrets` access

#### Scenario: Secret redaction in errors
- **WHEN** upstream auth resolution fails or logs diagnostic metadata
- **THEN** Fentaris redacts credential values and reports only credential references and source metadata
