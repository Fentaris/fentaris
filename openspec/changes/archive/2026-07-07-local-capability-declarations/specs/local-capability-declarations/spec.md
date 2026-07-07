## ADDED Requirements

### Requirement: Local capability namespace declaration
The system SHALL allow applications to declare a named local MCP capability namespace before the proxy starts.

#### Scenario: Declaring a local namespace
- **WHEN** an application calls `app.local("workspace")` before startup
- **THEN** Fentaris creates a local capability namespace named `workspace` that can expose MCP capabilities through the proxy endpoint

#### Scenario: Local namespace handle reuse
- **WHEN** an application calls `app.local("workspace")` more than once before startup
- **THEN** Fentaris returns handles for the same local namespace so modules can contribute declarations to one namespace

#### Scenario: Local namespace collision
- **WHEN** a local namespace name collides with an existing upstream MCP server name
- **THEN** Fentaris rejects the configuration before serving requests

### Requirement: Local tool declarations
The system SHALL allow local namespaces to declare tools with MCP-compatible metadata and handlers.

#### Scenario: Local tool listing
- **WHEN** a local namespace declares a tool named `status`
- **THEN** `tools/list` includes the tool using the existing proxied tool naming convention for that namespace

#### Scenario: Local tool call
- **WHEN** a downstream client calls the proxied local tool name
- **THEN** Fentaris invokes the local tool handler and returns the handler's MCP-compatible tool result

#### Scenario: Local tool handler context
- **WHEN** Fentaris invokes a local tool handler
- **THEN** the handler receives a unified proxy context with operation, subject, server, tool, args, state, logger, and response helpers

### Requirement: Local resource declarations
The system SHALL allow local namespaces to declare exact resources and resource templates with MCP-compatible metadata and read handlers.

#### Scenario: Local resource listing
- **WHEN** a local namespace declares an exact resource URI
- **THEN** `resources/list` includes the resource with a Fentaris proxied resource URI

#### Scenario: Local resource read
- **WHEN** a downstream client reads the proxied URI for a declared local resource
- **THEN** Fentaris invokes the matching local resource handler and returns the handler's MCP-compatible resource contents

#### Scenario: Local resource template listing
- **WHEN** a local namespace declares a resource template URI
- **THEN** `resources/templates/list` includes the template with a Fentaris proxied resource template URI

#### Scenario: Local resource template read
- **WHEN** a downstream client reads a proxied resource URI that matches a declared local resource template
- **THEN** Fentaris invokes the matching template handler and returns the handler's MCP-compatible resource contents

### Requirement: Local prompt declarations
The system SHALL allow local namespaces to declare prompt templates with MCP-compatible metadata and handlers.

#### Scenario: Local prompt listing
- **WHEN** a local namespace declares a prompt named `review_pr`
- **THEN** `prompts/list` includes the prompt using the existing proxied prompt naming convention for that namespace

#### Scenario: Local prompt get
- **WHEN** a downstream client gets the proxied local prompt name
- **THEN** Fentaris invokes the local prompt handler and returns the handler's MCP-compatible prompt result

#### Scenario: Local prompt handler context
- **WHEN** Fentaris invokes a local prompt handler
- **THEN** the handler receives a unified proxy context with operation, subject, server, prompt, state, logger, and response helpers

### Requirement: Local completion declarations
The system SHALL allow local namespaces to declare completion handlers for declared local prompts and resource templates.

#### Scenario: Local prompt completion
- **WHEN** a downstream client requests completion for a proxied local prompt reference with a registered completion handler
- **THEN** Fentaris invokes the local completion handler and returns the handler's MCP-compatible completion result

#### Scenario: Local resource template completion
- **WHEN** a downstream client requests completion for a proxied local resource template reference with a registered completion handler
- **THEN** Fentaris invokes the local completion handler and returns the handler's MCP-compatible completion result

#### Scenario: Unsupported local completion
- **WHEN** a downstream client requests completion for a local prompt or resource template without a matching completion handler
- **THEN** Fentaris returns the same unsupported capability error shape used for upstream MCP completion misses

### Requirement: Local capability governance
The system SHALL apply existing Fentaris policy, group visibility, middleware, operation routes, events, contextual logging, and audit behavior to local capabilities.

#### Scenario: Policy filters local list results
- **WHEN** a subject lists local tools, resources, resource templates, or prompts and policy denies access to one declaration
- **THEN** Fentaris omits the denied declaration from the list response

#### Scenario: Policy denies local execution
- **WHEN** a subject invokes a local capability that policy denies
- **THEN** Fentaris rejects the request before invoking the local handler

#### Scenario: Middleware wraps local execution
- **WHEN** middleware or operation routes match a local capability request
- **THEN** Fentaris runs the matching handlers in the same deterministic order used for upstream capability requests

#### Scenario: Events for local execution
- **WHEN** a local capability request succeeds or fails
- **THEN** Fentaris emits the same typed operation events used for upstream capability requests with local namespace metadata in the context

### Requirement: Local declaration validation
The system SHALL validate local capability declarations before serving requests.

#### Scenario: Duplicate local tool
- **WHEN** two modules declare the same local tool name in the same local namespace
- **THEN** Fentaris rejects the duplicate declaration with a clear configuration diagnostic

#### Scenario: Duplicate local resource
- **WHEN** two modules declare the same local resource URI or resource template URI in the same local namespace
- **THEN** Fentaris rejects the duplicate declaration with a clear configuration diagnostic

#### Scenario: Invalid local declaration name
- **WHEN** a local namespace, tool, or prompt declaration uses an invalid name
- **THEN** Fentaris rejects the declaration with a clear configuration diagnostic

#### Scenario: Handler failure
- **WHEN** a local capability handler throws or returns an invalid MCP-compatible result
- **THEN** Fentaris returns a structured MCP error and emits the corresponding error and after events
