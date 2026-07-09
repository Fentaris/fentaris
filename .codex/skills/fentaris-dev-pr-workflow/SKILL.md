---
name: fentaris-dev-pr-workflow
description: Use in the Fentaris repository whenever Codex is asked to implement a new code change, OpenSpec change, fix, refactor, feature, branch, commit, or pull request intended to merge into dev.
---

# Fentaris Dev PR Workflow

Use this workflow for implementation work before release promotion.

## Default Flow

1. Inspect the current worktree and avoid staging unrelated user changes.
2. Create a scoped branch with GitButler before editing, unless the user explicitly says to keep the current branch.
3. Branch names should use `codex/` and a short kebab-case task name, for example `codex/add-auth-checks`.
4. Implement the requested change.
5. Run focused tests first, then broader checks when the change touches shared behavior.
6. Commit coherent chunks as work is completed. Do not wait until the end if the work naturally splits into reviewable commits.
7. Add or update a Changeset when the change affects published package behavior, unless the user says `no release` or `niente release`.
8. When finished, summarize the implemented change, commits, verification, release impact, and ask for approval before creating a pull request.
9. After approval, create a pull request into `dev`.

## GitButler

Prefer GitButler for version-control operations when available:

- `but branch new <branch-name>` for new task branches.
- `but status` to inspect changes.
- `but stage <path> <branch-name>` to stage only intended files.
- `but commit` for commits.

Use non-interactive commands where possible. Never stage unrelated files.

## Pull Request Targeting

Feature, fix, refactor, docs, and OpenSpec implementation PRs:

- Source: task branch.
- Target: `dev`.
- Template: feature-to-dev.

Release promotion PRs are not part of this skill. Use the Fentaris release workflow for `dev` to `main`.

## Changesets

Use the release hint from the user when present:

- `minor update` or `minor`: create a `minor` changeset.
- `patch`: create a `patch` changeset.
- `major`: create a `major` changeset and call out breaking-change risk.
- `no release` or `niente release`: do not create a publishing changeset.

If no hint is provided and published package behavior changed, choose conservatively:

- `patch` for fixes and small compatible behavior changes.
- `minor` for new compatible user-facing features.
- `major` only for explicit breaking changes.

## PR Body

Use this structure:

```md
## Summary
- ...

## Verification
- ...

## Release
- Changeset: yes/no
- Version impact: patch/minor/major/none
- Target: dev
```

## Approval Gate

Do not create the pull request until the user approves. The final pre-PR message should include:

- branch name
- commit summary
- changed files summary
- verification results
- release impact
- proposed PR title and target branch
