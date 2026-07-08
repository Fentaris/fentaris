## ADDED Requirements

### Requirement: Distributed rate limiting
The system SHALL provide a RateLimiter that supports sliding-window limits backed by a pluggable distributed store.

#### Scenario: Deny when rate limit exceeded
- **WHEN** a user exceeds the configured rate limit for a tool
- **THEN** the tool call is denied with a policy error response

### Requirement: Quotas per user or policy
The system SHALL support daily quotas (maxDailyCalls) per user or policy.

#### Scenario: Daily quota exceeded
- **WHEN** the daily quota is exhausted for a user
- **THEN** subsequent tool calls are denied until the quota window resets
