## 1. Session Authentication

- [x] 1.1 Add authenticated session metadata storage for HTTP Streamable sessions.
- [x] 1.2 Re-authenticate or validate session binding on every HTTP session continuation request.
- [x] 1.3 Apply `identityRequired` and user resolution to SSE `/messages` POST requests.
- [x] 1.4 Add tests for valid session ID without auth and session ID with mismatched identity.

## 2. Exposure Defaults

- [x] 2.1 Add host configuration to HTTP and SSE exposure transports.
- [x] 2.2 Default HTTP and SSE listeners to `127.0.0.1` when host is omitted.
- [x] 2.3 Enforce `identityRequired` during stdio exposure startup.
- [x] 2.4 Add tests for host defaults and stdio identity-required failures.

## 3. Upstream HTTP Safety

- [x] 3.1 Replace arbitrary env-to-header spreading in `HttpTransport.withEnv` with an explicit header mapper.
- [x] 3.2 Align upstream header behavior with existing streamable HTTP header resolution.
- [x] 3.3 Add tests proving token-like env keys are not sent as headers by default.

## 4. URL Guardrails

- [x] 4.1 Add upstream URL classification for localhost, RFC1918, link-local, and metadata ranges.
- [x] 4.2 Add configuration for explicit private-network allowlists where operators need them.
- [x] 4.3 Add tests for blocked and explicitly allowed upstream URLs.

## 5. Verification And Documentation

- [x] 5.1 Run focused transport exposure and upstream transport tests.
- [x] 5.2 Update generated config/docs to show explicit production host binding and custom header mapping.
