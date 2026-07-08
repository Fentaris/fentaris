## ADDED Requirements

### Requirement: Default-deny proxy policy

The proxy SHALL deny tool and capability access when no configured policy or group rule explicitly allows the operation.

#### Scenario: Tool call without policy

- **WHEN** a proxy receives a tool call and no global policy, group policy, or explicit allow-all policy matches the call
- **THEN** the proxy rejects the call with a policy denial

#### Scenario: Development allow-all policy

- **WHEN** a proxy is configured with an explicit allow-all policy
- **THEN** tool calls covered by that policy are allowed unless another applicable rule denies them

### Requirement: Terminal deny decisions

The proxy SHALL treat policy deny decisions as terminal before invoking tool call hooks, middleware, routes, or upstream forwarding.

#### Scenario: Hook attempts to satisfy denied call

- **WHEN** a policy denies a tool call and a hook would return a successful result
- **THEN** the proxy returns the policy denial and does not use the hook result

### Requirement: Policy-filtered tool discovery

The proxy SHALL ensure the final `listTools` response contains only tools visible under the active policy context.

#### Scenario: Hook expands tool list

- **WHEN** a `listTools` hook adds a tool that is not allowed by policy
- **THEN** the proxy removes that tool from the final response

### Requirement: Automatic policy limiter enforcement

The proxy SHALL enforce rate limiters attached to policy decisions before forwarding allowed tool calls.

#### Scenario: Policy limiter exceeded

- **WHEN** a policy decision includes a limiter and the caller exceeds that limiter
- **THEN** the proxy rejects the call with a rate limit error without requiring manually registered rate limit middleware

### Requirement: Deny-safe group evaluation

Group policy evaluation SHALL prevent explicit deny decisions from being overridden by allow decisions from other groups.

#### Scenario: User belongs to allow and deny groups

- **WHEN** a user belongs to one group that allows a tool and another group that explicitly denies the same tool
- **THEN** the proxy denies the tool call

### Requirement: Open policy diagnostics

The CLI SHALL warn when a production-relevant proxy configuration has no global policy, no group policy, and no explicit allow-all development policy.

#### Scenario: Policy check runs on open configuration

- **WHEN** `fentaris check` or `fentaris doctor` evaluates a proxy config without policy controls
- **THEN** the CLI reports a security warning with the deny-by-default and allow-all migration guidance
