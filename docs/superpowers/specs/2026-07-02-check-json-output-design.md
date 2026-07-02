# `fentaris check --json` design

## Goal

Add machine-readable output to `fentaris check` so CI jobs and agent-driven
workflows can consume project diagnostics without parsing ANSI-formatted text.

## Approaches considered

1. Add a command-specific `--json` branch to `runCheck`, matching the existing
   `fentaris doctor --json` response. This is the selected approach because it
   keeps the change small and preserves the existing health result contract.
2. Extract a shared JSON formatter for `check`, `doctor`, and `secrets doctor`.
   This would reduce a small amount of duplication, but it broadens the change
   without changing the public result shape.
3. Add `--json` as a global option for every CLI command. This would create an
   inconsistent promise because several commands do not have a useful structured
   response yet.

## User-facing behavior

`fentaris check --json` prints one JSON document to standard output:

```json
{
  "results": [
    {
      "group": "Project",
      "label": "Configuration",
      "status": "pass",
      "detail": "Configuration is valid."
    }
  ]
}
```

Each entry uses the existing `HealthResult` fields. Optional `hint` and
`metadata` fields are included when present. Runtime-only implementation fields,
including automatic fix callbacks, are omitted by `JSON.stringify`.

The JSON mode suppresses the human-readable section heading, summary, ANSI
styles, issue groups, and verbose hint. `--offline`, `--strict`, and the existing
exit-code behavior remain unchanged:

- exit `0` when no failures are present;
- exit `1` when a failure is present;
- exit `1` when `--strict` is used and a warning is present.

`--verbose` has no effect when combined with `--json`, matching the existing
`doctor --json` behavior.

## Implementation

- Register `--json` on the `check` command in the CLI specification.
- In `runCheck`, serialize `{ results }` when JSON mode is enabled; otherwise
  retain the current human-readable rendering path.
- Keep failure evaluation after output generation so automation receives the
  diagnostic payload before the command exits unsuccessfully.
- Document the flag and its CI use in the CLI reference.
- Add a minor changeset for `@fentaris/cli` because this is a new compatible
  user-facing option.

## Verification

Tests will cover:

- parser acceptance and contextual help for `fentaris check --json`;
- valid JSON output without ANSI formatting or the `Project Check` heading;
- preservation of result fields;
- unchanged nonzero exit behavior for failures and strict warnings;
- unchanged human-readable output when `--json` is absent.

Focused verification will run the CLI test suite, followed by lint and
typechecking if the workflow environment supports the full repository checks.
