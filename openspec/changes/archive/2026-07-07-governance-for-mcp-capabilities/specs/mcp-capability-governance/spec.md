## ADDED Requirements

### Requirement: Operation-based permissions
The system SHALL support policy permissions for proxied MCP operations across tools, resources, prompts, and completion.

#### Scenario: Tool permission compatibility
- **WHEN** an existing policy allows a tool call through the current tool permission model
- **THEN** the same tool call remains allowed after generalized capability governance is introduced

#### Scenario: Resource read permission
- **WHEN** a policy denies `resource:read` for a target resource
- **THEN** Fentaris rejects the downstream `resources/read` request before forwarding it upstream

#### Scenario: Prompt get permission
- **WHEN** a policy denies `prompt:get` for a target prompt
- **THEN** Fentaris rejects the downstream `prompts/get` request before forwarding it upstream

#### Scenario: Completion permission
- **WHEN** a policy denies `completion:complete` for a referenced prompt or resource template
- **THEN** Fentaris rejects the downstream `completion/complete` request before forwarding it upstream

### Requirement: Governed list filtering
The system SHALL filter list responses according to the subject's effective capability permissions.

#### Scenario: Resource list filtering
- **WHEN** a subject lists resources and policy denies access to one upstream resource
- **THEN** that resource is omitted from the downstream `resources/list` response

#### Scenario: Resource template list filtering
- **WHEN** a subject lists resource templates and policy denies access to one template
- **THEN** that template is omitted from the downstream `resources/templates/list` response

#### Scenario: Prompt list filtering
- **WHEN** a subject lists prompts and policy denies access to one prompt
- **THEN** that prompt is omitted from the downstream `prompts/list` response

### Requirement: Capability context
The system SHALL expose normalized resource, prompt, and completion metadata on `ProxyContext` for matching non-tool operations.

#### Scenario: Resource context
- **WHEN** middleware handles a `resource:read` operation
- **THEN** `ctx.operation` is `resource:read` and `ctx.resource` identifies the proxied and upstream resource

#### Scenario: Prompt context
- **WHEN** middleware handles a `prompt:get` operation
- **THEN** `ctx.operation` is `prompt:get` and `ctx.prompt` identifies the proxied and upstream prompt

#### Scenario: Completion context
- **WHEN** middleware handles a `completion:complete` operation
- **THEN** `ctx.operation` is `completion:complete` and `ctx.completion` identifies the referenced prompt or resource template

### Requirement: Capability middleware
The system SHALL allow middleware to observe, deny, fail, or inject behavior around non-tool MCP operations.

#### Scenario: Middleware denies resource read
- **WHEN** middleware denies a `resource:read` operation
- **THEN** Fentaris returns the middleware's structured MCP error and does not call the upstream server

#### Scenario: Middleware observes prompt get
- **WHEN** middleware calls `next()` during `prompt:get`
- **THEN** Fentaris continues through the remaining middleware and forwards the request if policy allows it

### Requirement: Capability events
The system SHALL emit typed events for non-tool MCP operations with operation context, result or error, and duration metadata.

#### Scenario: Resource success event
- **WHEN** a `resources/read` request succeeds
- **THEN** Fentaris emits a resource success event containing `ctx`, result, and duration

#### Scenario: Prompt error event
- **WHEN** a `prompts/get` request fails
- **THEN** Fentaris emits a prompt error event containing `ctx`, error, and duration

#### Scenario: Completion after event
- **WHEN** a `completion/complete` request finishes
- **THEN** Fentaris emits an after event regardless of success or failure

### Requirement: Capability audit logging
The system SHALL include operation, subject, server, target, policy outcome, and credential source metadata in logs for governed MCP operations.

#### Scenario: Denied resource log
- **WHEN** policy denies a resource read
- **THEN** Fentaris logs the denial with operation, subject id, server name, resource URI, and policy reason

#### Scenario: Successful prompt log
- **WHEN** a prompt get succeeds
- **THEN** Fentaris logs the success with operation, subject id, server name, prompt name, and duration
