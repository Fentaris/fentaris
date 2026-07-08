## Context

Fentaris has policy, groups, rate limits, middleware, unified context, and events around tool operations. After adding resources, prompts, and completion, those operations need the same governance primitives because they can expose data, influence model behavior, or leak sensitive suggestions.

This change generalizes governance without removing existing tool-oriented APIs.

## Goals / Non-Goals

**Goals:**
- Represent permissions for all proxied MCP operations.
- Filter list results according to effective policy.
- Deny read/get/complete operations before forwarding upstream.
- Extend `ProxyContext` and event payloads with selected resource, prompt, and completion details.
- Preserve current tool middleware, `ToolPermission`, and policy behavior.

**Non-Goals:**
- Implementing server feature proxying itself.
- Implementing client feature bridging.
- Designing a full policy DSL beyond the current group/policy model.
- Changing auth identity resolution.

## Decisions

### Introduce operation-based permissions

Add a generalized permission model keyed by operation, server, and target. Tool permissions become a specialized case of capability permissions.

Alternative considered: create separate `ResourcePermission`, `PromptPermission`, and `CompletionPermission` types. That is explicit but would duplicate matching, rate-limit, approval, and metadata behavior.

### Keep list filtering and direct-operation denial separate

List operations will filter invisible entries. Direct operations such as `resources/read`, `prompts/get`, and `completion/complete` will evaluate policy and return a structured MCP error when denied.

Alternative considered: show all entries but deny only on use. That leaks resource and prompt inventory.

### Extend context rather than create parallel contexts

`ProxyContext` will gain optional `resource`, `prompt`, and `completion` fields. `ctx.operation` identifies the active operation.

Alternative considered: introduce separate context types per capability. That would fragment middleware and event APIs.

### Add capability routes and events incrementally

Tool routes remain tool-specific. New route registration can be capability-oriented, such as `proxy.resource(...)`, `proxy.prompt(...)`, or a generic `proxy.operation(...)`, depending on final API fit. Event names should remain explicit and readable.

Alternative considered: overload `proxy.tool(...)` to match resources and prompts. That would blur model-controlled tools with application/user-controlled MCP primitives.

## Risks / Trade-offs

- Generalized policy can become too abstract -> Keep operation names concrete and documented.
- Backward compatibility around `Policy.evaluate` is sensitive -> Add adapter behavior and tests for existing policies.
- List filtering can conflict with completion references -> Completion must deny references the user cannot list or access.
- More event names can add API surface -> Keep legacy tool events stable and add capability events only where useful.

## Migration Plan

1. Add generalized permission types alongside existing tool permission types.
2. Adapt current tool policy evaluation to the new operation model internally.
3. Add list filtering for resources, templates, and prompts.
4. Add direct-operation policy evaluation for read/get/complete.
5. Extend context, events, logging, and docs.
6. Keep old tool APIs working as aliases until a later explicit breaking-change proposal.

## Open Questions

- Should resource permissions match exact proxied URI, original URI, URI template, or all three?
- Should completion permission be derived from the referenced prompt/resource permission by default?
- What public route API is most consistent with the current Express-like DX?
