## Why

Fentaris already exposes TypeScript declarations, but framework users do not yet have a clearly documented public extension surface. Before pre-alpha, the core API should make it obvious which high-level builders to use, when low-level classes are supported, and how third parties can implement custom transports, registries, policies, loggers, middleware, and downstream exposure transports.

## What Changes

- Define the official high-level and low-level API tiers for `@fentaris/core`.
- Document the recommended syntax for application authors, including when to use `fentaris`, `createProxy`, `McpProxy`, `mcp`, `server`, `group`, `user`, `policy`, and credential helpers.
- Define supported extension contracts for third-party customization:
  - upstream MCP transports;
  - downstream proxy exposure transports;
  - policies and approval handlers;
  - registries;
  - rate limiters;
  - logger drivers;
  - middleware and event handlers.
- Add external TypeScript consumer tests so the public extension contracts are checked from outside core internals.
- Add examples or fixtures showing custom extension implementations.
- Keep existing exports compatible; this change should clarify and stabilize the API, not remove current entry points.

## Capabilities

### New Capabilities
- `extension-api-contracts`: Official public API tiers, extension contracts, import guidance, and external TypeScript compatibility checks for framework users.

### Modified Capabilities

## Impact

- Affects `packages/core/src/index.ts`, package export metadata, public type exports, and documentation/examples.
- Adds type-level consumer tests or fixture compilation for public API usage.
- May add package subpath exports if they improve import clarity without breaking existing usage.
- Does not require runtime behavior changes except where needed to expose stable helper APIs.
