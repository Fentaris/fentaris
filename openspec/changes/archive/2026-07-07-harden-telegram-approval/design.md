## Context

Telegram approvals gate potentially sensitive tool calls. The current callback handler accepts callback data with the expected prefix but does not verify the chat identity, webhook secret, or callback payload integrity. The default `failOpen` behavior also permits calls when Telegram delivery fails.

## Goals / Non-Goals

**Goals:**

- Ensure only callbacks from the configured chat can approve or deny a request.
- Reject forged webhook traffic when a webhook secret is configured.
- Prevent callback data tampering or request ID substitution.
- Make approval failures deny by default.

**Non-Goals:**

- Replacing Telegram Bot API integration.
- Adding multi-approver quorum workflows.
- Persisting long-term approval audit logs outside the provider boundary.

## Decisions

- Validate `callback_query.message.chat.id` against the configured `chatId` before resolving a request. This directly addresses cross-chat approval.
- Support Telegram `X-Telegram-Bot-Api-Secret-Token` validation for webhook deployments. Polling mode can skip webhook header validation because Telegram delivers updates through the Bot API.
- Encode callback data with action, request ID, and an HMAC computed from provider secret material. This prevents a caller from fabricating approval data for another request.
- Set `failOpen` default to `false`. If operators explicitly enable it, emit a warning and require docs to call out the risk.

## Risks / Trade-offs

- Callback data length is limited by Telegram. Mitigation: use compact action and truncated HMAC formats that fit Telegram limits.
- Operators without webhook secret configuration need migration guidance. Mitigation: support optional secret initially but warn in production-oriented checks.
- Fail-closed can block tools during Telegram outages. Mitigation: expose explicit emergency override rather than silent approval.

## Migration Plan

- Introduce signed callback generation while accepting old callback format only during a short compatibility window if needed.
- Update provider defaults and tests to assert fail-closed behavior.
- Document webhook secret setup and `failOpen` risk.

## Open Questions

- Should old unsigned callbacks be rejected immediately or accepted behind an explicit compatibility option for one release?
