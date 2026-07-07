## Why

Fentaris already exposes subject, authentication, and policy metadata, but the current shape still leaves developers checking optional fields and mixing legacy `user`, `policyDecision`, and response-controller access. A clearer context DX makes middleware, routes, approvals, and hooks easier to read and safer to use.

## What Changes

- Make `ctx.subject`, `ctx.auth`, and `ctx.policy` the primary structured domains for new proxy handlers.
- Ensure authenticated requests expose subject fields directly through `ctx.subject.id`, `ctx.subject.email`, `ctx.subject.metadata`, `ctx.subject.tenant`, `ctx.subject.groups`, and `ctx.subject.hasGroup(groupId)`.
- Expand policy context with `ctx.policy.allowed`, `ctx.policy.reason`, `ctx.policy.matchedPermissions`, and `ctx.policy.can(server, tool)`.
- Define unauthenticated and non-tool operation behavior so handlers can use predictable nullability and avoid ambiguous `undefined` policy state.
- Preserve compatibility aliases such as `ctx.user`, `ctx.policyDecision`, `ctx.res`, and existing middleware signatures.
- Update docs and examples to recommend the structured context domains.

## Capabilities

### New Capabilities
- `structured-proxy-context-dx`: Covers the normalized `ctx.subject`, `ctx.auth`, and `ctx.policy` developer experience, including policy capability checks.

### Modified Capabilities
- `proxy-context-dx`: Refines the existing unified context requirements so structured domains have explicit field contracts and compatibility behavior.
- `governance-context`: Refines subject and policy context requirements around stable subject access and policy capability checks.

## Impact

- Affected code: `packages/core/src/types.ts`, `packages/core/src/McpProxy.ts`, `packages/core/src/governance.ts`, `packages/core/src/policy.ts`, generated docs, and focused tests.
- Public API impact: additive TypeScript fields/helpers on existing context objects; no breaking changes intended.
- Runtime impact: small extra policy helper construction per context; `ctx.policy.can(...)` must be deterministic and must not expose secret values.
