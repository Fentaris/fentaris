## Context

The runtime already contains secure primitives in some places, such as timing-safe comparison in `FentarisAuth` and key-name redaction. The review found inconsistent use of those primitives and non-atomic rate limiter accounting, which can create exploitable gaps under specific conditions.

## Goals / Non-Goals

**Goals:**

- Route every API key comparison through a timing-safe helper.
- Make rate limit enforcement correct under concurrent calls.
- Redact likely secrets even when they appear in generic fields such as `input`, `body`, or `query`.

**Non-Goals:**

- Replacing the entire auth subsystem.
- Adding distributed rate limiting.
- Guaranteeing perfect detection of every possible secret string.

## Decisions

- Centralize API key comparison on `FentarisAuth.compareApiKey` or an equivalent shared helper. This avoids reintroducing raw `===` checks.
- Change the rate limiter store interface to expose an atomic consume/check-and-increment operation. In-memory storage can implement this synchronously; future external stores can map it to native atomic commands.
- Add value-pattern redaction for common token formats, including bearer tokens, JWT-like strings, GitHub tokens, and high-entropy API key shapes. Keep key-name redaction as the first layer.
- Apply redaction before profiler sink dispatch, log rendering, and error metadata serialization.

## Risks / Trade-offs

- Value-pattern redaction can over-redact harmless strings. Mitigation: target high-confidence patterns and allow custom redaction rules to tune behavior.
- Atomic rate limiter API changes can affect custom stores. Mitigation: keep adapters or provide a migration shim during the change.
- Timing tests are unreliable. Mitigation: test that auth paths call the shared helper rather than asserting timing measurements.

## Migration Plan

- Introduce the atomic rate limiter method while adapting existing stores.
- Update all internal rate limiter call sites to use the atomic method.
- Preserve custom redaction extension points.

## Open Questions

- Should the atomic rate limiter method return remaining quota and reset time for better client errors?
