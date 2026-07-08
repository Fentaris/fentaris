## Why

The proxy policy layer currently has security gaps where an unconfigured proxy allows all tool access, deny decisions can be bypassed by extension hooks, and policy metadata can be exposed without enforcement. This change makes policy enforcement the non-bypassable authority for tool discovery and execution.

## What Changes

- **BREAKING**: Deny tool and capability access by default when no matching allow policy exists.
- Make `Policy.allowAll()` or equivalent development policy an explicit opt-in instead of the implicit fallback.
- Treat policy deny decisions as terminal before tool call hooks, middleware, or routes can return a result.
- Re-apply policy filtering after `listTools` hooks so hooks cannot reintroduce hidden tools.
- Automatically enforce rate limiters attached to policy decisions.
- **BREAKING**: Make group policy evaluation deterministic and deny-safe by ensuring explicit denies cannot be overridden by membership in another allowing group.
- Add diagnostics and tests that make open policy configurations visible during `check` and `doctor`.

## Capabilities

### New Capabilities

- `proxy-policy-enforcement`: Covers deny-by-default policy behavior, non-bypassable deny decisions, tool discovery filtering, policy limiter enforcement, group policy semantics, and related diagnostics.

### Modified Capabilities

- None.

## Impact

- Affects `packages/core/src/proxy/capabilities.ts`, `packages/core/src/proxy/McpProxy.ts`, governance policy evaluation, rate limit integration, and CLI health checks.
- Changes the default security posture for users who currently rely on implicit allow behavior.
- Requires regression tests for policy-free proxies, policy deny hooks, `listTools` hook expansion, group overlap behavior, and rate limiter enforcement.
