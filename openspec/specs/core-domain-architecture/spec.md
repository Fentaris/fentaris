## Purpose

Define the structural layout of the `@fentaris/core` package so that the runtime is organized by domain rather than a flat source tree, while preserving public API compatibility and enabling incremental, verifiable migration.
## Requirements
### Requirement: Domain-oriented core layout

`@fentaris/core` SHALL organize runtime source code into domain-owned folders instead of a mostly flat source tree.

#### Scenario: New maintainers inspect core source

- **WHEN** a maintainer opens `packages/core/src`
- **THEN** the source tree exposes clear domain folders for proxy, server, transports, governance, auth, plugins, registry, rate limiting, logging, isolation, naming, errors, and shared types

#### Scenario: New capability placement

- **WHEN** a future capability is added to core
- **THEN** its primary implementation belongs to a domain folder that owns that concern rather than being added to a large generic module by default

### Requirement: Public API compatibility
`@fentaris/core` SHALL preserve existing top-level public exports through the package entrypoint during the architecture migration and SHALL expose new public app-level governance APIs through the same package entrypoint.

#### Scenario: Existing consumer imports core symbols
- **WHEN** existing consumer code imports public symbols from `@fentaris/core`
- **THEN** those imports continue to resolve without requiring new subpath imports

#### Scenario: Implementation files move
- **WHEN** an implementation moves from a flat source file into a domain folder
- **THEN** `packages/core/src/index.ts` continues to export the same public symbol names

#### Scenario: Consumer uses app-level governance API
- **WHEN** consumer code imports `fentaris`, `user`, and related governance symbols from `@fentaris/core`
- **THEN** the consumer can declare policies and groups through `app.policy(...)` and `app.group(...)` without requiring new subpath imports

### Requirement: Dedicated test tree

`@fentaris/core` SHALL keep package tests in a dedicated test tree that mirrors the domain layout.

#### Scenario: Runtime source is listed

- **WHEN** a maintainer lists runtime files under `packages/core/src`
- **THEN** unit and integration test files are not mixed with runtime implementation files

#### Scenario: Tests are run

- **WHEN** the package test command runs
- **THEN** tests from the dedicated test tree are discovered and executed

### Requirement: Focused type modules

`@fentaris/core` SHALL split broad shared type declarations into focused type modules while retaining a compatibility export path for existing type imports.

#### Scenario: Type declarations are maintained

- **WHEN** a maintainer edits proxy, middleware, policy, transport, MCP, or shared type contracts
- **THEN** the relevant declarations live in a focused type module for that concern

#### Scenario: Existing type import paths are used

- **WHEN** existing internal or external code imports types through the compatibility type barrel
- **THEN** the imported type names continue to resolve

### Requirement: Focused proxy internals

`McpProxy` SHALL remain the public proxy orchestration class while its internal responsibilities are split into focused proxy modules.

#### Scenario: Proxy routing logic changes

- **WHEN** proxy route pattern compilation or matching changes
- **THEN** the implementation is isolated to proxy routing modules rather than being embedded in the main proxy class body

#### Scenario: Proxy operation forwarding changes

- **WHEN** MCP operation forwarding or result rewriting changes
- **THEN** the implementation is isolated to proxy operation modules while `McpProxy` remains the public coordinator

#### Scenario: Proxy context construction changes

- **WHEN** proxy context construction changes
- **THEN** the implementation is isolated to proxy context modules and remains reusable by middleware, routes, events, and lifecycle logic

### Requirement: Transport direction separation

`@fentaris/core` SHALL separate upstream MCP client transports from downstream proxy exposure transports.

#### Scenario: Upstream transport is added

- **WHEN** a transport connects Fentaris to an upstream MCP server
- **THEN** its implementation belongs under the upstream client transport domain

#### Scenario: Downstream exposure transport is added

- **WHEN** a transport exposes Fentaris as an MCP server to downstream clients
- **THEN** its implementation belongs under the proxy exposure transport domain

### Requirement: Plugin-ready boundary

`@fentaris/core` SHALL reserve a plugin domain boundary so future plugin support can be implemented without coupling plugin loading to proxy internals.

#### Scenario: Plugin architecture is inspected

- **WHEN** a maintainer looks for where plugin manifest, registry, loader, lifecycle, or capability contracts will live
- **THEN** the core source tree contains a dedicated plugin domain boundary for those concerns

#### Scenario: Plugin runtime behavior is requested

- **WHEN** executable plugin loading, installation, discovery, or sandboxing behavior is needed
- **THEN** that behavior is implemented by a separate feature change rather than being implied by this structural migration

### Requirement: Incremental verifiable migration

The architecture migration SHALL be implemented in phases that can be verified independently.

#### Scenario: A migration phase completes

- **WHEN** a major phase of file movement or extraction completes
- **THEN** `@fentaris/core` tests and build are run before starting the next high-risk phase

#### Scenario: A phase introduces regressions

- **WHEN** tests or build fail after a migration phase
- **THEN** the phase can be isolated and corrected without requiring unrelated architectural moves to be reverted

