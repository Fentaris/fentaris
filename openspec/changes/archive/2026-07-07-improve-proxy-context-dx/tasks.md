## 1. Context Types

- [x] 1.1 Add explicit public types for structured subject, auth, and policy context domains in `packages/core/src/types.ts`
- [x] 1.2 Add `can(server, tool): boolean | Promise<boolean>` to the public policy context type
- [x] 1.3 Preserve compatibility fields for `ctx.user`, `ctx.policyDecision`, `ctx.res`, and existing legacy middleware types

## 2. Runtime Context Construction

- [x] 2.1 Update `McpProxy.createProxyContext` to always construct stable `auth`, `policy`, `credentials`, `transport`, `response`, and `state` domains
- [x] 2.2 Ensure `ctx.subject` is attached only when a subject is resolved and includes id, email, metadata, tenant, groups, and `hasGroup`
- [x] 2.3 Ensure unauthenticated or unresolved requests expose `ctx.auth.authenticated` without creating an anonymous subject
- [x] 2.4 Keep raw API keys, bearer tokens, decrypted credentials, and environment secret values out of structured context domains

## 3. Policy Capability Checks

- [x] 3.1 Implement `ctx.policy.can(server, tool)` using existing global policy and group policy matching semantics
- [x] 3.2 Ensure explicit deny takes precedence over allow when multiple group policies match
- [x] 3.3 Ensure `ctx.policy.can(server, tool)` returns `false` when policy is configured and no allow matches
- [x] 3.4 Ensure `ctx.policy.can(server, tool)` returns `true` when no policy model is configured, matching current permissive runtime behavior
- [x] 3.5 Document that `can` does not consume rate limits, invoke manual approval, or expose credential values

## 4. Tests

- [x] 4.1 Add tests for authenticated `ctx.subject.id`, `email`, `metadata`, `tenant`, `groups`, and `hasGroup`
- [x] 4.2 Add tests for unauthenticated context behavior and `ctx.auth.authenticated`
- [x] 4.3 Add tests for `ctx.policy.allowed`, `reason`, `matchedGroups`, and `matchedPermissions` on allowed and denied tool calls
- [x] 4.4 Add tests for `ctx.policy.can(server, tool)` with group policy allow, explicit deny override, missing allow, global policy, and no-policy cases
- [x] 4.5 Add regression tests proving raw credential values are not exposed through `ctx.subject`, `ctx.auth`, `ctx.policy`, or `ctx.credentials`
- [x] 4.6 Add compatibility tests for `ctx.user`, `ctx.policyDecision`, and `ctx.res`

## 5. Documentation

- [x] 5.1 Update middleware/governance docs to show `ctx.subject`, `ctx.auth`, and `ctx.policy` as the recommended DX
- [x] 5.2 Add examples for `ctx.subject.hasGroup("admins")` and `ctx.policy.can("github", "delete_repo")`
- [x] 5.3 Regenerate API reference docs if public exported types change

## 6. Verification

- [x] 6.1 Run `pnpm --filter @fentaris/core test`
- [x] 6.2 Run `pnpm --filter @fentaris/core build`
- [x] 6.3 Run `pnpm typecheck`
