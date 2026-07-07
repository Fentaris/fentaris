## ADDED Requirements

### Requirement: Policy model and evaluation
The system SHALL expose a Policy model that defines per-server tool permissions and returns allow/deny decisions for tool calls.

#### Scenario: Evaluate a policy on a tool call
- **WHEN** a tool call is received and a Policy is configured
- **THEN** the policy evaluation returns an allow/deny decision and attaches policy metadata to the middleware context

### Requirement: Policy-driven tool discovery
The system SHALL filter listTools results based on the active Policy before returning them to the client.

#### Scenario: Filtered tool discovery
- **WHEN** a client requests listTools and the Policy forbids a tool
- **THEN** the forbidden tool is omitted from the returned tool list
