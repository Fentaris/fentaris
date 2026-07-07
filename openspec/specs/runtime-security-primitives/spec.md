# runtime-security-primitives Specification

## Purpose
TBD - created by archiving change harden-runtime-security-primitives. Update Purpose after archive.
## Requirements
### Requirement: Consistent timing-safe API key comparison

All runtime API key authentication paths SHALL compare secrets through a timing-safe comparison helper.

#### Scenario: Declared API key auth

- **WHEN** a request is authenticated using a declared API key
- **THEN** the comparison uses the shared timing-safe helper rather than direct string equality

### Requirement: Atomic rate limit consumption

Rate limiter enforcement SHALL check and record a call atomically for a given limiter key.

#### Scenario: Concurrent requests at limit boundary

- **WHEN** multiple concurrent requests attempt to consume the final available quota for the same limiter key
- **THEN** no more requests are allowed than the configured limit permits

### Requirement: Value-pattern redaction

Runtime redaction SHALL mask likely secret values even when they appear in generic fields whose key names are not sensitive.

#### Scenario: Token in generic input field

- **WHEN** profiler or logger metadata includes a token-like value under `input`, `body`, `query`, or another generic key
- **THEN** the emitted event or log masks the token-like value

### Requirement: Redaction before sink dispatch

Profiler and logger sinks SHALL receive redacted payloads by default.

#### Scenario: Custom sink receives event

- **WHEN** a custom profiler sink receives an event containing sensitive metadata
- **THEN** the payload has already passed through default redaction

