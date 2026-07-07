## MODIFIED Requirements

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
