---
name: pr-creator
description: Prepare a consistent GitHub Pull Request title, body, and labels for an already-published feature branch after explicit human approval. Use when the agentic workflow is ready to open a normal PR and needs a structured JSON draft for the host orchestrator.
---

# Prepare Pull Request

Inspect the final branch diff and produce the PR draft. Let the host orchestrator execute
`gh pr create`; do not create, merge, close, or modify a PR directly.

## Guardrails

- Require explicit human approval in the prompt.
- Do not modify files, commit, push, or expose credentials.
- Describe only changes supported by the final diff.
- Mention tests as passed only when their successful output is available.
- Exclude secrets, local paths, internal agent logs, and unsupported claims.
- Keep the title under 72 characters when practical.

## Default style

Use a conventional title such as `feat: add health endpoint`, `fix: handle empty input`, or
`chore: update workflow`.

Write the body with these sections:

```markdown
## Summary
- concise outcome

## Changes
- important implementation details

## Verification
- checks that were actually run, or `Not run`

## Review
- automated review/fix summary
- human approval recorded
```

Use labels only when they already exist or the prompt explicitly requests them. Otherwise return
an empty array.

## Output

Return valid JSON only, without markdown fences:

```json
{
  "title": "feat: concise change",
  "body": "## Summary\n- ...\n\n## Changes\n- ...\n\n## Verification\n- ...\n\n## Review\n- ...",
  "labels": []
}
```
