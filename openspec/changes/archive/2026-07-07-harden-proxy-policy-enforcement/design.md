## Context

Policy decisions are currently advisory in a few paths: absent policies allow all capabilities, call hooks can return before a deny reaches the terminal forwarder, `listTools` hooks can replace filtered lists, and policy limiter metadata is not applied unless middleware is registered manually. This weakens production safety and creates a mismatch between configured policy and observed behavior.

## Goals / Non-Goals

**Goals:**

- Make policy deny decisions impossible to bypass from hooks, middleware, or route handlers.
- Make unconfigured policy fail closed unless the operator explicitly chooses an allow-all development policy.
- Ensure tool discovery never reveals tools excluded by policy.
- Apply policy-attached rate limiters without requiring manual middleware wiring.
- Define group overlap behavior so explicit denies win over allows.

**Non-Goals:**

- Replacing the policy DSL.
- Removing hook or middleware extension points.
- Implementing a full role-based access control redesign.

## Decisions

- Evaluate policy before extension dispatch and return immediately on deny. This keeps extension points useful for allowed traffic while preserving policy as the final authority for rejection.
- Use explicit allow-all for development instead of implicit allow. This is a breaking but safer default because generated or minimal configuration should not expose all upstream tools by accident.
- Apply `filterToolsByPolicy` to the final `listTools` result after hooks. This allows hooks to reduce or decorate tool lists but prevents them from expanding beyond the policy-visible set.
- Enforce `policyDecision.metadata.limiter` inside `McpProxy.callTool` before forwarding. Middleware can remain available for custom throttling, but policy limiters must work when configured.
- Treat explicit group denies as higher priority than allows. Alternatives considered were documenting the current OR behavior or using intersection-only semantics; deny-wins preserves common multi-group access while preventing a low-trust group from being ignored.

## Risks / Trade-offs

- Existing local setups without policy may start denying calls. Mitigation: document `Policy.allowAll()` as the development escape hatch and add CLI diagnostics before runtime failure surprises.
- Some users may rely on current OR group privilege union. Mitigation: mark the behavior as breaking and add targeted migration notes.
- Double-filtering `listTools` can remove hook-generated synthetic tools unless they have policy coverage. Mitigation: require synthetic tools to be declared or explicitly allowed by policy.

## Migration Plan

- Add warnings to `fentaris check` and `doctor` for missing production policy before changing examples.
- Update tests to encode fail-closed defaults and deny-wins behavior.
- Document the development-only allow-all configuration in code comments and user-facing diagnostics.

## Open Questions

- Should synthetic tools created by hooks have a dedicated policy namespace, or should they reuse the current tool name matcher?
