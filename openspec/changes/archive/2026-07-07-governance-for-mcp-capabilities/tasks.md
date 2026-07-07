## 1. Permission Model

- [x] 1.1 Define generalized MCP operation names for tool, resource, prompt, and completion operations
- [x] 1.2 Add a capability permission type that matches server, operation, target name or URI, effect, limiter, approval, and metadata
- [x] 1.3 Add compatibility adapters so existing `ToolPermission` and `Policy.evaluate` behavior still works for tools
- [x] 1.4 Add tests for compatibility with current group policies and global policies

## 2. Policy Evaluation And Filtering

- [x] 2.1 Implement policy evaluation for `resources/list` and `resources/read`
- [x] 2.2 Implement policy evaluation for `resources/templates/list`
- [x] 2.3 Implement policy evaluation for `prompts/list` and `prompts/get`
- [x] 2.4 Implement policy evaluation for `completion/complete`
- [x] 2.5 Filter listed resources, resource templates, and prompts according to effective policy
- [x] 2.6 Return structured MCP errors for denied direct operations before upstream forwarding

## 3. Unified Context

- [x] 3.1 Extend `ProxyOperation` with non-tool operations
- [x] 3.2 Add `ctx.resource` metadata for resource operations
- [x] 3.3 Add `ctx.prompt` metadata for prompt operations
- [x] 3.4 Add `ctx.completion` metadata for completion operations
- [x] 3.5 Include credentials, policy decision, subject, auth, transport, raw request, and logger fields for all new operations
- [x] 3.6 Add context construction tests for resource, prompt, and completion operations

## 4. Middleware And Routing

- [x] 4.1 Decide and implement the public route API for non-tool operations
- [x] 4.2 Dispatch global middleware for governed non-tool operations
- [x] 4.3 Allow middleware to deny or fail non-tool operations before upstream forwarding
- [x] 4.4 Preserve existing tool route and middleware ordering semantics
- [x] 4.5 Add middleware tests for resource read, prompt get, and completion

## 5. Events And Logging

- [x] 5.1 Add event names and payload types for resource, prompt, and completion start/success/error/after flows
- [x] 5.2 Emit events with duration and result/error metadata for all governed non-tool operations
- [x] 5.3 Add contextual logger metadata for operation, subject, server, target, policy outcome, and credential source
- [x] 5.4 Add audit logging tests for allowed and denied operations

## 6. Documentation And Verification

- [x] 6.1 Update governance docs to explain operation-based capability permissions
- [x] 6.2 Update migration docs showing current tool policies continuing to work
- [x] 6.3 Run `pnpm --filter @fentaris/core test`
- [x] 6.4 Run `pnpm --filter @fentaris/core build`
