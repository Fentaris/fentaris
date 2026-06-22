## 1. Session Authentication

- [ ] 1.1 Add authenticated session metadata storage for HTTP Streamable sessions.
- [ ] 1.2 Re-authenticate or validate session binding on every HTTP session continuation request.
- [ ] 1.3 Apply `identityRequired` and user resolution to SSE `/messages` POST requests.
- [ ] 1.4 Add tests for valid session ID without auth and session ID with mismatched identity.

## 2. Exposure Defaults

- [ ] 2.1 Add host configuration to HTTP and SSE exposure transports.
- [ ] 2.2 Default HTTP and SSE listeners to `127.0.0.1` when host is omitted.
- [ ] 2.3 Enforce `identityRequired` during stdio exposure startup.
- [ ] 2.4 Add tests for host defaults and stdio identity-required failures.

## 3. Upstream HTTP Safety

- [ ] 3.1 Replace arbitrary env-to-header spreading in `HttpTransport.withEnv` with an explicit header mapper.
- [ ] 3.2 Align upstream header behavior with existing streamable HTTP header resolution.
- [ ] 3.3 Add tests proving token-like env keys are not sent as headers by default.

## 4. URL Guardrails

- [ ] 4.1 Add upstream URL classification for localhost, RFC1918, link-local, and metadata ranges.
- [ ] 4.2 Add configuration for explicit private-network allowlists where operators need them.
- [ ] 4.3 Add tests for blocked and explicitly allowed upstream URLs.

## 5. Verification And Documentation

- [ ] 5.1 Run focused transport exposure and upstream transport tests.
- [ ] 5.2 Update generated config/docs to show explicit production host binding and custom header mapping.
