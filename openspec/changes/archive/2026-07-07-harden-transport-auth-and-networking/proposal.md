## Why

HTTP/SSE session continuation and exposure transport defaults currently allow requests to avoid authentication checks after the initial connection, while upstream HTTP header propagation can leak credentials. This change hardens transport authentication, networking defaults, and upstream URL safety.

## What Changes

- Require authentication or session-token binding on every HTTP Streamable request that resumes an MCP session.
- Require authentication on SSE `/messages` POST requests, not only the initial `/sse` GET.
- Bind MCP sessions to the authenticated identity that created them and reject mismatched or unauthenticated continuations.
- Enforce `identityRequired` for stdio exposure.
- Stop spreading arbitrary environment variables into upstream HTTP headers.
- Default exposure transports to listen on `127.0.0.1` unless a host is explicitly configured.
- Add configurable SSRF guardrails for upstream HTTP/S URLs, including localhost, RFC1918, and cloud metadata addresses.

## Capabilities

### New Capabilities

- `transport-auth-networking`: Covers downstream session authentication, exposure host defaults, upstream header allowlisting, stdio identity enforcement, and upstream URL guardrails.

### Modified Capabilities

- None.

## Impact

- Affects HTTP Streamable, SSE, and stdio exposure transports plus HTTP upstream client transport setup.
- May require configuration migration for deployments that intentionally bind to all interfaces or send custom upstream headers through env.
- Requires tests for unauthenticated session continuation, SSE messages auth, stdio identity checks, safe header mapping, host binding, and SSRF-blocked upstream URLs.
