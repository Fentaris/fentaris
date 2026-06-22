## Why

Telegram approval callbacks currently do not sufficiently bind approvals to the intended chat, webhook source, or callback payload integrity. This can allow unauthorized approval if the webhook is reachable or if callback data is forged.

## What Changes

- Verify approval callbacks originate from the configured Telegram chat.
- Validate Telegram webhook secret tokens when webhook mode is used.
- Add signed or otherwise integrity-protected callback data for approve/deny actions.
- Change approval failure behavior to fail closed by default.
- Keep `failOpen` available only as an explicit, documented development or emergency override.

## Capabilities

### New Capabilities

- `telegram-approval-security`: Covers callback authorization, webhook validation, signed callback data, fail-closed defaults, and approval audit behavior.

### Modified Capabilities

- None.

## Impact

- Affects `packages/approval-telegram/src/index.ts`, approval provider options, callback handling tests, and user-facing documentation.
- May require operators to configure Telegram webhook secret tokens.
- Changes default behavior for Telegram send failures from approval to denial.
