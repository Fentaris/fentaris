## Context

The exposure transports perform authentication at connection creation time but not consistently on follow-up requests tied to an existing MCP session. Separately, the upstream HTTP client can receive an env object that is spread directly into headers, and exposure servers bind to all interfaces when no host is supplied.

## Goals / Non-Goals

**Goals:**

- Authenticate every request that can operate an MCP session.
- Bind session IDs to the identity and auth context that created them.
- Prevent accidental upstream leakage of arbitrary environment variables as HTTP headers.
- Make local-only exposure the default for development.
- Provide SSRF defenses for operator-controlled upstream URLs.

**Non-Goals:**

- Replacing the MCP transport implementations.
- Designing a distributed session store.
- Removing explicit production host binding support.

## Decisions

- Store session metadata at creation time, including user identity, auth method, creation time, and optional token fingerprint. Continuation requests must either re-authenticate or prove they match the stored binding.
- Apply `identityRequired` to every HTTP/SSE request path that can send messages or resume a session. This prevents `/messages` from becoming a lower-security side channel.
- Replace `HttpTransport.withEnv` header spreading with an allowlist mapper. Known auth fields and explicitly configured headers can be forwarded; arbitrary env keys cannot.
- Add a `host` option to exposure transports and default it to `127.0.0.1`. Operators can opt into `0.0.0.0` explicitly.
- Add URL guardrails before opening upstream HTTP/S transports. Use hostname/IP classification after DNS resolution where feasible, and make blocklists configurable for deployments that need private networks.

## Risks / Trade-offs

- Re-authenticating every request can add small overhead. Mitigation: allow secure session binding validation where credentials are already associated with the session.
- Default localhost binding changes behavior for users expecting LAN access. Mitigation: emit clear startup output showing host and port.
- SSRF checks can block legitimate internal MCP servers. Mitigation: provide explicit allow configuration with warnings.

## Migration Plan

- Introduce host and upstream URL safety config with conservative defaults.
- Update generated config and docs to show explicit production binding.
- Add compatibility notes for custom upstream headers currently passed through env.

## Open Questions

- Should session expiration be fixed by default or configurable per exposure transport?
