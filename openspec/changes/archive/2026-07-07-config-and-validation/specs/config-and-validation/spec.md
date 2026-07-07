## ADDED Requirements

### Requirement: High-level config validation

Fentaris SHALL validate high-level runtime configuration before creating proxy runtime state.

#### Scenario: High-level startup rejects invalid config
- **WHEN** an application calls `fentaris(config)` with error-severity configuration diagnostics
- **THEN** Fentaris throws `FentarisConfigError` before initializing the proxy runtime

#### Scenario: High-level startup accepts valid config
- **WHEN** an application calls `fentaris(config)` with no error-severity configuration diagnostics
- **THEN** Fentaris creates the proxy using normalized runtime configuration

#### Scenario: Existing simple config remains supported
- **WHEN** an application passes a valid config with only global `servers`
- **THEN** Fentaris preserves the existing global MCP behavior

### Requirement: Explicit config API

Fentaris SHALL provide explicit TypeScript-first configuration APIs for definition, validation, and assertion.

#### Scenario: Define config preserves inference
- **WHEN** a developer calls `defineFentarisConfig(config)`
- **THEN** the returned value preserves the input configuration shape for TypeScript inference

#### Scenario: Validate config returns diagnostics
- **WHEN** a developer calls `validateFentarisConfig(config)`
- **THEN** the result contains structured diagnostics without throwing for ordinary validation failures

#### Scenario: Assert config throws on errors
- **WHEN** a developer calls `assertValidFentarisConfig(config)` and validation contains error-severity diagnostics
- **THEN** the function throws `FentarisConfigError` carrying those diagnostics

#### Scenario: Assert config allows warnings
- **WHEN** a developer calls `assertValidFentarisConfig(config)` and validation contains only warning or info diagnostics
- **THEN** the function does not throw

### Requirement: Internal config resolution

Fentaris SHALL normalize high-level configuration shortcuts into runtime-ready structures through an internal resolver.

#### Scenario: Group server shortcut becomes scoped binding
- **WHEN** a group declares `servers: [mcp("linear", ...)]`
- **THEN** the resolver normalizes the server into a group-scoped server binding for that group

#### Scenario: Global servers remain global bindings
- **WHEN** the config declares top-level `servers`
- **THEN** the resolver normalizes those servers into global server bindings

#### Scenario: Resolved config is not the primary public API
- **WHEN** extension authors use the documented public API
- **THEN** they rely on input config and diagnostics rather than depending on internal resolved config fields

### Requirement: Structured diagnostics

Fentaris SHALL represent validation output as structured diagnostics independent from renderer output.

#### Scenario: Diagnostic includes stable metadata
- **WHEN** validation reports a configuration issue
- **THEN** the diagnostic includes severity, code, title, message, and semantic path when a path is available

#### Scenario: Diagnostic includes actionable help
- **WHEN** validation can identify a likely fix
- **THEN** the diagnostic includes a hint or suggestion describing the action

#### Scenario: Diagnostic can relate multiple config locations
- **WHEN** one issue involves multiple declarations
- **THEN** the diagnostic can include related entries for the additional declarations

#### Scenario: Diagnostics serialize for tooling
- **WHEN** diagnostics are converted to JSON-compatible output
- **THEN** severity, code, message, path, hints, related entries, and suggestions remain machine-readable

### Requirement: Diagnostic rendering

Fentaris SHALL provide renderers that format diagnostics without changing diagnostic data.

#### Scenario: Pretty renderer creates terminal output
- **WHEN** diagnostics are formatted with the pretty renderer
- **THEN** the output includes severity grouping, diagnostic codes, semantic paths, hints, and config tree frames where useful

#### Scenario: Pretty renderer respects color configuration
- **WHEN** the formatter is configured with color disabled or the environment disables color
- **THEN** the pretty output does not include ANSI color escapes

#### Scenario: Plain renderer creates stable text
- **WHEN** diagnostics are formatted with the plain renderer
- **THEN** the output is readable without ANSI escapes or Unicode-only characters

#### Scenario: Compact renderer summarizes diagnostics
- **WHEN** diagnostics are formatted with the compact renderer
- **THEN** the output focuses on one-line issue summaries with codes and paths

#### Scenario: JSON renderer preserves data
- **WHEN** diagnostics are formatted for JSON-oriented output
- **THEN** the output preserves the structured diagnostics without lossy string parsing

### Requirement: Scoped MCP config validation

Fentaris SHALL validate scoped MCP server declarations before runtime catalog resolution.

#### Scenario: Duplicate global server names
- **WHEN** multiple global servers have the same name
- **THEN** validation reports an error diagnostic for the duplicate server name

#### Scenario: Duplicate group server names
- **WHEN** a group declares multiple servers with the same name
- **THEN** validation reports an error diagnostic scoped to that group

#### Scenario: Ambiguous overlapping group servers
- **WHEN** overlapping groups declare different server instances with the same name
- **THEN** validation reports an error diagnostic describing the ambiguous group scoped binding

#### Scenario: Global and group server ambiguity
- **WHEN** a server name is declared globally and in a group with different server instances
- **THEN** validation reports an error diagnostic describing the ambiguous visibility

### Requirement: Policy visibility validation

Fentaris SHALL validate that policies reference servers visible to their scope.

#### Scenario: Group policy references invisible server
- **WHEN** a group policy references a server that is neither global nor scoped to that group
- **THEN** validation reports an error diagnostic with a hint to declare the server globally or in the group

#### Scenario: Group policy references visible scoped server
- **WHEN** a group policy references a server declared in that same group
- **THEN** validation does not report a visibility error for that reference

#### Scenario: Wildcard permission warning
- **WHEN** a policy grants broad wildcard access
- **THEN** validation can report a warning diagnostic without preventing startup

### Requirement: Identity and credential validation

Fentaris SHALL validate identity and credential relationships that are required for runtime startup.

#### Scenario: Required identity without strategy
- **WHEN** identity is required but no identity strategy or compatible auth configuration is available
- **THEN** validation reports an error diagnostic

#### Scenario: Missing credential reference
- **WHEN** a server, group, user, or transport references a credential that cannot be resolved from available credential sources
- **THEN** validation reports an error diagnostic without exposing secret values

#### Scenario: Sensitive values are redacted
- **WHEN** diagnostics mention credentials or auth configuration
- **THEN** rendered output does not include raw secret values

### Requirement: Transport and extension contract validation

Fentaris SHALL validate the minimum runtime shape of custom transports and extension-provided objects without rejecting valid implementations.

#### Scenario: Server without transport
- **WHEN** a server declaration lacks a usable transport
- **THEN** validation reports an error diagnostic for that server

#### Scenario: Custom transport has required operations
- **WHEN** a custom transport satisfies the public transport contract
- **THEN** validation accepts the transport without requiring a built-in transport class

#### Scenario: Custom transport missing required operation
- **WHEN** a custom transport is missing a required operation for MCP access
- **THEN** validation reports an error diagnostic describing the missing contract member

### Requirement: Scoped proxy handle validation

Fentaris SHALL validate scoped proxy handles that reference configured groups and servers.

#### Scenario: Unknown group handle
- **WHEN** code registers `proxy.group("unknown")` and no configured group has that id
- **THEN** Fentaris reports or throws a config diagnostic for the unknown group reference

#### Scenario: Unknown server handle
- **WHEN** code registers a server-scoped handle for a server that is not configured and is not being registered by that call
- **THEN** Fentaris reports or throws a config diagnostic for the unknown server reference

#### Scenario: Group server handle is not visible
- **WHEN** code registers `proxy.group("engineering").server("linear")` but `linear` is not visible to `engineering`
- **THEN** Fentaris reports or throws a config diagnostic for the invalid scoped handle
