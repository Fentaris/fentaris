# telegram-approval-security Specification

## Purpose
TBD - created by archiving change harden-telegram-approval. Update Purpose after archive.
## Requirements
### Requirement: Authorized callback chat

Telegram approval callbacks SHALL be accepted only when the callback message chat matches the configured approval chat.

#### Scenario: Callback from another chat

- **WHEN** a callback query for a pending approval comes from a chat other than the configured `chatId`
- **THEN** the approval provider rejects the callback and does not approve the request

### Requirement: Webhook secret validation

Telegram webhook handlers SHALL validate the configured Telegram webhook secret token before processing approval updates.

#### Scenario: Missing webhook secret header

- **WHEN** webhook mode is configured with a secret token and a request omits or mismatches the Telegram secret header
- **THEN** the handler rejects the request before processing callback data

### Requirement: Callback payload integrity

Telegram approval callback data SHALL include integrity protection that binds the action to the request ID.

#### Scenario: Forged request ID

- **WHEN** callback data contains a modified request ID or invalid signature
- **THEN** the approval provider rejects the callback

### Requirement: Fail-closed approval default

Telegram approval SHALL deny or fail pending approval requests by default when the provider cannot deliver or process the approval message.

#### Scenario: Telegram send fails

- **WHEN** sending an approval message to Telegram fails and `failOpen` is not explicitly enabled
- **THEN** the approval provider does not approve the protected tool call

### Requirement: Explicit fail-open warning

The provider SHALL expose `failOpen` only as an explicit option and SHALL surface a warning when it is enabled.

#### Scenario: Operator enables failOpen

- **WHEN** Telegram approval is configured with `failOpen: true`
- **THEN** startup or configuration validation reports that approval failures will allow protected calls

