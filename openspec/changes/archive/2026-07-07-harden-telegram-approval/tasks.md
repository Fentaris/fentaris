## 1. Callback Authorization

- [x] 1.1 Validate callback message chat ID against the configured approval chat ID.
- [x] 1.2 Reject callbacks whose chat cannot be determined.
- [x] 1.3 Add tests for valid chat, wrong chat, and missing chat metadata.

## 2. Webhook And Payload Integrity

- [x] 2.1 Add webhook secret token validation for Telegram webhook requests.
- [x] 2.2 Generate compact signed callback data for approve and deny actions.
- [x] 2.3 Verify callback signatures before resolving pending approval requests.
- [x] 2.4 Add tests for forged request IDs, invalid signatures, and missing webhook secret headers.

## 3. Failure Semantics

- [x] 3.1 Change `failOpen` default to `false`.
- [x] 3.2 Add explicit warning or validation output when `failOpen: true` is configured.
- [x] 3.3 Add tests proving Telegram send failures do not approve by default.

## 4. Verification And Documentation

- [x] 4.1 Run approval provider tests.
- [x] 4.2 Update Telegram approval documentation for webhook secrets, signed callbacks, and fail-open risk.
