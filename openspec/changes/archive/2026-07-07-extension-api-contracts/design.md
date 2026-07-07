## Context

`@fentaris/core` currently exports many useful classes, builders, helpers, and types from the top-level entrypoint. The package also emits TypeScript declarations, but the intended public API tiers are not explicit enough for third-party framework users. A consumer can discover `fentaris`, `createProxy`, `McpProxy`, `mcp`, and `server`, but the package does not clearly state which syntax is recommended for most applications, which APIs are low-level but supported, and which types are stable extension contracts.

This change defines the public extension surface before pre-alpha so examples, docs, and third-party packages can build on supported contracts instead of implementation details.

## Goals / Non-Goals

**Goals:**

- Establish the recommended high-level syntax for application authors.
- Establish the supported low-level API for advanced framework users.
- Export and document stable extension contracts for custom transports, exposure transports, policies, registries, rate limiters, logger drivers, middleware, and events.
- Add type-level consumer tests that compile public extension examples from outside package internals.
- Preserve existing top-level imports while improving guidance and organization.

**Non-Goals:**

- Redesign proxy runtime behavior.
- Add group-scoped MCP server resolution.
- Implement plugin loading or runtime plugin activation.
- Remove existing public exports.
- Guarantee semver-stable API beyond the declared pre-alpha contract; the goal is a clear supported surface, not a permanent 1.0 freeze.

## Decisions

### Public API tiers

The public API will be documented in three tiers:

- High-level app builders: `fentaris()` and declaration helpers such as `mcp()`, `server()`, `group()`, `user()`, `policy()`, and credential helpers.
- Advanced low-level APIs: `createProxy()`, `McpProxy`, `McpServer`, direct transport classes, and explicit exposure transport wiring.
- Extension contracts: public TypeScript types and interfaces that third parties implement.

Alternative considered: only document the top-level export list. That would not solve the DX problem because it does not tell users which path is preferred.

### `fentaris()` as the default syntax

Examples and docs will prefer `fentaris()` for new applications because it communicates intent and leaves room for future normalization around config, groups, plugins, and scoped servers. `createProxy()` and `McpProxy` remain supported for advanced usage and tests.

Alternative considered: make `McpProxy` the primary public syntax. This is more explicit, but it pushes users toward construction details earlier than necessary.

### Extension contracts are public even when implementations are optional

Types such as `FentarisTransport`, `ProxyExposureTransport`, `Policy`, `Registry`, `RateLimiter`, `LoggerDriver`, middleware types, and event handler types will be treated as supported extension contracts. The API documentation will include minimal examples for implementing each contract.

Alternative considered: expose only concrete built-in classes. That would make the framework less extensible and would force users to copy internal patterns.

### External type tests

The package will add type-level consumer tests that import from `@fentaris/core` as an external user would. These tests should compile examples for custom transports, custom exposure transports, custom policies, custom registries, custom logger drivers, and middleware.

Alternative considered: rely on package unit tests. Unit tests catch runtime regressions, but they do not prove that external TypeScript users can consume the API without private imports.

### Subpath exports are optional and must be additive

If package subpath exports are added, they must be additive and keep `@fentaris/core` as the primary import path. Potential subpaths include `@fentaris/core/transports`, `@fentaris/core/extensions`, and `@fentaris/core/testing`.

Alternative considered: immediately split all imports into subpaths. That would create unnecessary churn before pre-alpha.

## Risks / Trade-offs

- [Risk] Declaring too many contracts as public can slow future refactors. Mitigation: classify APIs as high-level, advanced, or extension contract, and explicitly keep internals out of docs.
- [Risk] Type tests can become noisy if the package layout changes. Mitigation: keep tests small and focused on consumer-facing examples.
- [Risk] Subpath exports can confuse users if introduced too early. Mitigation: add them only if they clarify imports without replacing the top-level path.
- [Risk] Documentation can drift from exports. Mitigation: include examples in compilable fixtures where possible.
