## Context

Fentaris already builds a `ProxyContext` for middleware, tool routes, and events. The context contains most of the needed data, but the developer-facing model is not yet strict enough for the desired DX: `ctx.subject`, `ctx.auth`, and `ctx.policy` should feel like stable domains, while legacy aliases remain available for existing code.

The current policy context exposes decision metadata but does not provide a direct capability helper such as `ctx.policy.can("github", "delete_repo")`. Developers must manually inspect matched permissions or re-run policy checks elsewhere.

## Goals / Non-Goals

**Goals:**

- Make `ctx.subject`, `ctx.auth`, and `ctx.policy` the recommended handler surface.
- Keep subject information grouped and readable: id, email, metadata, tenant, groups, and `hasGroup`.
- Add `ctx.policy.can(server, tool)` for ergonomic permission checks in middleware, routes, hooks, and approval-adjacent code.
- Provide predictable behavior for unauthenticated requests and operations where policy has not been evaluated.
- Preserve current `ctx.user`, `ctx.policyDecision`, `ctx.res`, and legacy middleware signatures.
- Keep raw secrets out of every public context domain.

**Non-Goals:**

- Do not introduce the larger `fentaris(...)`, `mcp.*`, `http(...)`, or `zodInput(...)` DSL in this change.
- Do not replace group-owned `Policy` declarations with route-local authorization.
- Do not change MCP tool name mapping or transport behavior.
- Do not implement a remote approval workflow.

## Decisions

### Normalize the subject domain at context construction

`createProxyContext` will receive the resolved subject and attach it as `ctx.subject` when available. Authenticated handlers can read `ctx.subject.id`, `ctx.subject.email`, `ctx.subject.metadata`, `ctx.subject.tenant`, `ctx.subject.groups`, and `ctx.subject.hasGroup(groupId)`.

Unauthenticated contexts keep `ctx.subject` absent rather than creating an anonymous fake subject. This preserves a clear distinction between a known subject and a request that still needs authentication. Examples and TypeScript types should encourage `ctx.subject?.id` in generic middleware and allow direct access after an auth guard.

Alternative considered: always provide an anonymous subject object. That reduces optional checks but makes it easier to accidentally authorize anonymous requests as a real principal.

### Keep auth metadata separate from subject

`ctx.auth` will describe edge authentication: strategy, authenticated state, user id, and non-sensitive metadata. `ctx.subject` will describe the resolved application subject and groups. This keeps identity proof separate from authorization metadata.

Alternative considered: merge auth fields into `ctx.subject`. That is compact, but it blurs unauthenticated identity metadata with declared subject records.

### Add policy helper methods to the policy domain

`ctx.policy` will remain the effective policy snapshot and gain `can(server, tool)`. The helper evaluates against the already configured global policy or effective group policies for the current subject, using the same allow/deny matching semantics as tool calls.

For the current tool call, `ctx.policy.allowed` and `ctx.policy.reason` continue to describe the evaluated request. For arbitrary `can(server, tool)` checks, the helper returns a boolean and does not mutate the current request decision.

Alternative considered: expose only `matchedPermissions` and require application code to inspect them. That leaks policy merge rules into user code and makes deny precedence easy to get wrong.

### Treat no policy as permissive for `can`

When no policy or group policy is configured, `ctx.policy.can(server, tool)` returns `true`, matching the existing runtime behavior where the proxy forwards calls unless policy denies them. When policy is configured but the subject has no matching allow, `can` returns `false`.

Alternative considered: return `undefined` when no policy exists. That is semantically precise but less useful in guard code and diverges from current forwarding behavior.

### Preserve compatibility aliases

`ctx.user` remains the resolved user compatibility object. `ctx.policyDecision` remains available for existing middleware that reads the raw decision. `ctx.res` remains an alias of `ctx.response`. No existing handler signature is removed.

Alternative considered: make this a breaking cleanup. The requested DX is additive and does not require a breaking migration.

## Risks / Trade-offs

- `ctx.policy.can(...)` could be mistaken for a full approval/rate-limit check -> Document that it checks allow/deny permission only and does not consume rate limits or trigger manual approvals.
- Group policy evaluation for arbitrary tools may duplicate some logic -> Centralize the helper around existing permission matching/evaluation utilities and cover deny precedence with tests.
- Optional `ctx.subject` still requires guards in generic middleware -> Provide examples with an auth guard and keep TypeScript types honest.
- Rich context domains can accidentally grow sensitive fields -> Populate domains from allowlisted metadata only and add regression tests that raw credential values are absent.

## Migration Plan

1. Extend public context types with explicit `SubjectContext`, `AuthContext`, and `PolicyContext` shapes.
2. Build the domains in `McpProxy.createProxyContext` and preserve existing aliases.
3. Implement `ctx.policy.can(server, tool)` using the same policy/group semantics used by tool calls.
4. Add tests for authenticated subject access, unauthenticated context behavior, policy allowed/reason metadata, deny precedence, and compatibility aliases.
5. Update docs and examples to prefer `ctx.subject`, `ctx.auth`, and `ctx.policy`.

Rollback is additive: remove the new helper fields and docs while leaving existing proxy execution behavior unchanged.

## Open Questions

- Should a future API expose `ctx.policy.explain(server, tool)` for diagnostics beyond the boolean `can` result?
- Should `ctx.subject` become non-optional inside routes registered after a required-auth guard, or should TypeScript keep the simpler global optional type?
