## 1. API Key Comparison

- [x] 1.1 Replace raw declared API key equality checks with the shared timing-safe helper.
- [x] 1.2 Add tests or spies proving declared API key auth uses the shared comparison path.
- [x] 1.3 Search for and remove any remaining raw API key comparisons.

## 2. Atomic Rate Limiting

- [x] 2.1 Add an atomic consume/check-and-increment operation to the rate limiter store contract.
- [x] 2.2 Update in-memory rate limiter storage to enforce the operation atomically.
- [x] 2.3 Update middleware and policy limiter call sites to use the atomic operation.
- [x] 2.4 Add concurrency tests for limit boundary behavior.

## 3. Value Redaction

- [x] 3.1 Add high-confidence token value patterns to runtime/profiler redaction defaults.
- [x] 3.2 Apply value-pattern redaction to generic fields before logger and profiler sink dispatch.
- [x] 3.3 Add tests for JWT-like values, bearer tokens, GitHub-style tokens, and custom redaction overrides.

## 4. Verification And Documentation

- [x] 4.1 Run focused auth, rate limit, profiler, and logger tests.
- [x] 4.2 Update API notes for custom rate limiter stores if the store contract changes.
