## ADDED Requirements

### Requirement: Dynamic server feature capabilities
The proxy SHALL declare downstream MCP server capabilities for tools, resources, prompts, and completions according to the features supported by configured upstream servers.

#### Scenario: Resources capability exposed
- **WHEN** at least one configured upstream supports resource listing or reading
- **THEN** the downstream MCP server advertises the `resources` capability

#### Scenario: Prompts capability exposed
- **WHEN** at least one configured upstream supports prompt listing or prompt retrieval
- **THEN** the downstream MCP server advertises the `prompts` capability

#### Scenario: Completion capability exposed
- **WHEN** at least one configured upstream supports argument completion
- **THEN** the downstream MCP server advertises the `completions` capability

#### Scenario: Unsupported capability hidden
- **WHEN** no configured upstream supports a server feature
- **THEN** the downstream MCP server does not advertise that feature capability

### Requirement: Resource aggregation
The proxy SHALL aggregate `resources/list` results from all upstream servers that support resources and expose routable proxied resource URIs.

#### Scenario: Multiple upstream resources listed
- **WHEN** two upstream servers return resources with the same original URI
- **THEN** the downstream `resources/list` result includes two distinct proxied resource entries

#### Scenario: Unsupported upstream skipped
- **WHEN** an upstream server does not support resource listing
- **THEN** the proxy omits that upstream from `resources/list` without failing the entire request

#### Scenario: Resource metadata preserved
- **WHEN** an upstream resource includes name, title, description, MIME type, size, annotations, or icons
- **THEN** the proxied resource preserves that metadata except for routing fields intentionally rewritten by Fentaris

### Requirement: Resource reading
The proxy SHALL route `resources/read` requests for proxied resource URIs to the original upstream server and original resource URI.

#### Scenario: Proxied resource read
- **WHEN** a downstream client reads a proxied resource URI
- **THEN** Fentaris calls `resources/read` on the owning upstream with the original URI

#### Scenario: Unknown resource URI
- **WHEN** a downstream client reads a URI that Fentaris cannot route
- **THEN** Fentaris returns an MCP error instead of calling an arbitrary upstream

#### Scenario: Resource contents preserved
- **WHEN** an upstream returns text or blob resource contents
- **THEN** Fentaris returns equivalent contents to the downstream client with proxied content URIs where routing requires it

### Requirement: Resource template aggregation
The proxy SHALL aggregate `resources/templates/list` results and expose routable proxied URI templates.

#### Scenario: Template list
- **WHEN** an upstream returns resource templates
- **THEN** the downstream client receives corresponding proxied resource templates

#### Scenario: Template routing metadata
- **WHEN** a proxied resource template is exposed
- **THEN** Fentaris can recover the owning upstream server and original URI template from the downstream reference

### Requirement: Prompt aggregation
The proxy SHALL aggregate `prompts/list` results from all upstream servers that support prompts and expose unique proxied prompt names.

#### Scenario: Multiple upstream prompts listed
- **WHEN** two upstream servers return a prompt with the same name
- **THEN** the downstream `prompts/list` result includes distinct proxied prompt names

#### Scenario: Prompt metadata preserved
- **WHEN** an upstream prompt includes title, description, arguments, annotations, or icons
- **THEN** the proxied prompt preserves that metadata except for the rewritten name

### Requirement: Prompt retrieval
The proxy SHALL route `prompts/get` requests for proxied prompt names to the original upstream server and original prompt name.

#### Scenario: Proxied prompt get
- **WHEN** a downstream client gets a proxied prompt with arguments
- **THEN** Fentaris calls `prompts/get` on the owning upstream with the original prompt name and same arguments

#### Scenario: Unknown prompt name
- **WHEN** a downstream client gets a prompt name that Fentaris cannot route
- **THEN** Fentaris returns an MCP invalid params error

#### Scenario: Embedded resources in prompt messages
- **WHEN** an upstream prompt response contains embedded resource content
- **THEN** Fentaris preserves the embedded content payload for the downstream client

### Requirement: Completion proxying
The proxy SHALL route `completion/complete` requests for proxied prompt and resource references to the owning upstream server.

#### Scenario: Prompt completion
- **WHEN** a downstream client requests completion for a proxied prompt reference
- **THEN** Fentaris forwards completion to the owning upstream with the original prompt reference

#### Scenario: Resource template completion
- **WHEN** a downstream client requests completion for a proxied resource template reference
- **THEN** Fentaris forwards completion to the owning upstream with the original resource template reference

#### Scenario: Completion result preserved
- **WHEN** an upstream returns completion values, total, and hasMore
- **THEN** Fentaris returns the same completion result to the downstream client

### Requirement: Backward-compatible tool proxying
The proxy SHALL preserve existing `tools/list` and `tools/call` behavior while adding new server feature support.

#### Scenario: Existing tool names
- **WHEN** a downstream client lists tools after this change
- **THEN** existing proxied tool names remain in `<server>__<tool>` format

#### Scenario: Tool-only transport
- **WHEN** a custom transport implements only the existing tool methods
- **THEN** Fentaris continues to proxy that transport's tools without requiring resource, prompt, or completion methods
