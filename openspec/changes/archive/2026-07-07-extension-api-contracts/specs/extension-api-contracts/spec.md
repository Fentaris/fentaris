## ADDED Requirements

### Requirement: Public API tiers

`@fentaris/core` SHALL document and expose a public API map that distinguishes high-level application builders, advanced low-level APIs, and extension contracts.

#### Scenario: User chooses the default syntax

- **WHEN** a framework user reads the public API guidance
- **THEN** the guidance identifies `fentaris()` and declaration helpers as the recommended high-level syntax for new applications

#### Scenario: User needs advanced control

- **WHEN** a framework user needs explicit proxy construction or transport exposure control
- **THEN** the guidance identifies `createProxy()`, `McpProxy`, `McpServer`, and concrete transport classes as supported advanced APIs

### Requirement: Official extension contracts

`@fentaris/core` SHALL expose stable TypeScript contracts for supported third-party extension points.

#### Scenario: User implements a custom upstream transport

- **WHEN** a third-party package implements `FentarisTransport`
- **THEN** the implementation can be used with a Fentaris MCP server without importing private core modules

#### Scenario: User implements a custom exposure transport

- **WHEN** a third-party package implements `ProxyExposureTransport`
- **THEN** the implementation can expose a proxy runtime without importing private core modules

#### Scenario: User implements governance or infrastructure extensions

- **WHEN** a third-party package implements a custom `Policy`, `Registry`, `RateLimiter`, `LoggerDriver`, middleware, or event handler
- **THEN** the implementation can be typed using public exports from `@fentaris/core`

### Requirement: External TypeScript consumer checks

`@fentaris/core` SHALL include type-level checks that compile representative external consumer usage of the public extension API.

#### Scenario: Public extension examples compile

- **WHEN** the type-level consumer checks run
- **THEN** examples for custom transports, exposure transports, policies, registries, logger drivers, and middleware compile through public imports

#### Scenario: Private imports are avoided

- **WHEN** an extension fixture imports Fentaris types
- **THEN** it imports from documented public entrypoints rather than deep private implementation paths

### Requirement: Backward-compatible entrypoint

`@fentaris/core` SHALL preserve existing top-level public imports while clarifying the recommended usage tiers.

#### Scenario: Existing imports continue to resolve

- **WHEN** existing consumer code imports current public symbols from `@fentaris/core`
- **THEN** those imports continue to resolve after the extension API contract change

#### Scenario: Optional subpaths are added

- **WHEN** package subpath exports are introduced for clarity
- **THEN** they are additive and do not replace the top-level `@fentaris/core` entrypoint
