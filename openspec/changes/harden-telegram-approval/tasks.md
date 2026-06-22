## 1. Callback Authorization

- [ ] 1.1 Validate callback message chat ID against the configured approval chat ID.
- [ ] 1.2 Reject callbacks whose chat cannot be determined.
- [ ] 1.3 Add tests for valid chat, wrong chat, and missing chat metadata.

## 2. Webhook And Payload Integrity

- [ ] 2.1 Add webhook secret token validation for Telegram webhook requests.
- [ ] 2.2 Generate compact signed callback data for approve and deny actions.
- [ ] 2.3 Verify callback signatures before resolving pending approval requests.
- [ ] 2.4 Add tests for forged request IDs, invalid signatures, and missing webhook secret headers.

## 3. Failure Semantics

- [ ] 3.1 Change `failOpen` default to `false`.
- [ ] 3.2 Add explicit warning or validation output when `failOpen: true` is configured.
- [ ] 3.3 Add tests proving Telegram send failures do not approve by default.

## 4. Verification And Documentation

- [ ] 4.1 Run approval provider tests.
- [ ] 4.2 Update Telegram approval documentation for webhook secrets, signed callbacks, and fail-open risk.
