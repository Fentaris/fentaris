## 1. Policy Defaults

- [x] 1.1 Change capability and tool policy evaluation to deny when no explicit allow policy matches.
- [x] 1.2 Add an explicit development allow-all path and update internal examples that intentionally require open access.
- [x] 1.3 Add CLI diagnostics for configs without global policy, group policy, or explicit allow-all policy.

## 2. Non-bypassable Enforcement

- [x] 2.1 Short-circuit denied `callTool` requests before hook, middleware, route, or upstream dispatch.
- [x] 2.2 Add regression coverage where a denied call hook returns success but the proxy still denies.
- [x] 2.3 Ensure policy denial events and errors remain redacted and observable through existing profiler/logger paths.

## 3. Tool Discovery

- [x] 3.1 Re-apply policy filtering to the final `listTools` response after hook processing.
- [x] 3.2 Add regression coverage for hooks that attempt to reintroduce hidden tools.
- [x] 3.3 Decide and document how hook-created synthetic tools are matched by policy.

## 4. Group And Limiter Semantics

- [x] 4.1 Update group policy evaluation so explicit denies win over allows from other groups.
- [x] 4.2 Automatically enforce policy decision limiters in `McpProxy.callTool`.
- [x] 4.3 Add integration tests for overlapping groups and policy-attached rate limiters without manual middleware.

## 5. Verification And Documentation

- [x] 5.1 Run focused core policy and governance tests.
- [x] 5.2 Run CLI check or doctor tests covering open policy diagnostics.
- [x] 5.3 Update public docs or inline guidance for deny-by-default, allow-all development mode, and deny-wins group behavior.
