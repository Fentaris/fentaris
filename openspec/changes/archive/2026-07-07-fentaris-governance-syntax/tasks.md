## 1. Core scaffolding

- [x] 1.1 Add new core types/interfaces for Policy, ToolPermission, Registry, RateLimiter, IdentityStrategy, Isolation, and ErrorMapper
- [x] 1.2 Extend middleware context to expose policy evaluation results and identity metadata
- [x] 1.3 Export new types and classes from packages/core/src/index.ts

## 2. Policy engine

- [x] 2.1 Implement Policy evaluation logic with allow/deny and metadata
- [x] 2.2 Add ToolPermission filters for listTools and callTool decisions
- [x] 2.3 Integrate policy evaluation into McpProxy middleware flow and listTools pipeline

## 3. Registry and secrets

- [x] 3.1 Implement Registry interface and MemoryRegistry
- [x] 3.2 Implement RedisRegistry with connection and get/set semantics
- [x] 3.3 Wire Registry into identity/policy resolution and env injection

## 4. Rate limiting and quotas

- [x] 4.1 Implement RateLimitStore interface and in-memory store
- [x] 4.2 Implement RateLimiter with sliding window and daily quota support
- [x] 4.3 Add middleware helpers to enforce limits and return policy errors

## 5. Identity and auth

- [x] 5.1 Add identity resolver configuration on McpProxy (strategy-based)
- [x] 5.2 Implement header/token strategies with unauthorized error handling
- [x] 5.3 Ensure UserContext is populated consistently across hooks and middleware

## 6. Transports and isolation runtime

- [x] 6.1 Implement HttpTransport adapter and add tests
- [x] 6.2 Add Isolation interface and default in-process queue implementation
- [x] 6.3 Integrate isolation runtime with McpServer execution path

## 7. Logging and observability

- [x] 7.1 Add Logger auto-log pipeline for request/response/timing with user context
- [x] 7.2 Implement Redis logger driver and update docs
- [x] 7.3 Add lifecycle hooks for session start/end and tool failures

## 8. Error mapping and docs

- [x] 8.1 Implement standardized error mapping and middleware error injection API
- [x] 8.2 Update docs/guides to reflect new governance syntax
- [x] 8.3 Add tests for policy, rate limiting, identity, and error mapping
