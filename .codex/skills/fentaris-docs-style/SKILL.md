---
name: fentaris-docs-style
description: Write, restructure, and maintain Fentaris documentation in the project style. Use when Codex edits files under docs/, changes CLI commands, config files, environment variables, public @fentaris/core APIs, generated API reference, user-facing behavior, tutorials, quickstarts, troubleshooting, or any code change that may require documentation updates.
---

# Fentaris Docs Style

## Overview

Use this skill to keep Fentaris documentation concise, operational, and consistent with the MCP-use inspired style adopted by the repo.

## Workflow

1. Identify whether the task changes documentation directly or changes user-facing behavior that requires docs.
2. Read `references/doc-impact-checklist.md` for any code change before finishing.
3. Read `references/page-style.md` before writing or rewriting MDX pages.
4. Read `references/docs-architecture.md` before changing navigation, page placement, or section names.
5. Read `references/terminology.md` when naming Fentaris concepts, CLI commands, transports, auth, policy, or observability terms.
6. Prefer focused docs updates next to the changed behavior. Avoid broad rewrites unless the user asks for a docs restructure.

## Documentation Rules

- Write task-first pages: show the command or code path before deep explanation.
- Keep intros short: one paragraph after the title and blockquote is usually enough.
- Use `## Quick Start` when a page teaches a task that can be started immediately.
- Use `###` headings for flags, options, config keys, errors, and troubleshooting cases.
- Use fenced code blocks with `theme={null}` for commands and TypeScript examples.
- Use Mintlify callouts for operational guidance: `<Note>`, `<Tip>`, `<Warning>`.
- End pages with `## Related Documentation` when there are useful next links.
- Do not add marketing copy. Explain what to run, what it does, defaults, constraints, and failure modes.

## Resources

- `references/page-style.md`: page structure, formatting, and tone.
- `references/docs-architecture.md`: navigation model and page placement.
- `references/doc-impact-checklist.md`: required documentation updates for code changes.
- `references/terminology.md`: preferred Fentaris terms and naming rules.
