---
name: fentaris-dev-pr-agent-coordination
description: Use in the Fentaris repository only when Codex is asked to implement a code change, OpenSpec change, fix, refactor, feature, branch, commit, or pull request intended to merge into dev AND the user explicitly asks to use Agent Coordination, agent coordinator, the agent-coordination plugin, coordinated agents, or coordination with other agents. For normal Fentaris dev changes without an Agent Coordination request, use fentaris-dev-pr-workflow instead.
---

# Fentaris Dev PR With Agent Coordination

## Overview

Use this workflow for Fentaris implementation work that should be coordinated with other active agents before release promotion. It combines the Fentaris `dev` pull request workflow with the Agent Coordination shared activity board.

Agent Coordination is a shared board, not an orchestrator. Keep normal Codex judgment: inspect the repo, avoid unrelated changes, keep scope tight, verify the work, and communicate clearly with the user.

## Activation Boundary

Use this skill only when both are true:

- The work is a Fentaris implementation, fix, refactor, docs-affecting code change, OpenSpec implementation, branch, commit, or PR intended to merge into `dev`.
- The user explicitly asks for Agent Coordination or equivalent wording such as "use agent coordinator", "usa agent coordination", "con agent coordinator", or names the `agent-coordination` plugin.

If the user asks for a normal Fentaris dev change without Agent Coordination, do not use this skill; use `fentaris-dev-pr-workflow`.

## Required Tools

Use GitButler for version-control operations when available:

- `but branch new <branch-name>` for new task branches.
- `but status` to inspect changes.
- `but stage <path> <branch-name>` to stage only intended files.
- `but commit` for commits.

Use the Agent Coordination MCP tools when available:

- `list_activities` to inspect active project work.
- `check_conflicts` to compare planned `areas` and `files`.
- `start_activity` to declare intent before editing.
- `update_activity` to refresh status, ETA, areas, files, steps, notes, and context.
- `post_message` to coordinate with another agent.
- `list_messages` after waiting or before entering overlapping scope.
- `finish_activity` to close the activity with outcome and changed files.

If the Agent Coordination MCP tools are not exposed in the current session, state that briefly, continue with the Fentaris dev PR workflow, and mention the missing coordination tool access in the final summary.

## Default Flow

1. Inspect the current worktree with `but status` or the best available status command. Avoid staging unrelated user changes.
2. Infer the likely `project`, `worktree`, current branch, intended task branch, `areas`, and known `files`.
3. Use Agent Coordination before editing:
   - Call `check_conflicts` for planned `areas` and known `files`, or `list_activities` if files are not known yet.
   - Treat conflicts as soft coordination signals, not hard locks.
   - Call `start_activity` before making edits. Use `status: planning` unless editing begins immediately.
4. Create a scoped branch with GitButler before editing, unless the user explicitly says to keep the current branch.
5. Branch names must use `codex/` and a short kebab-case task name, for example `codex/add-auth-checks`.
6. After inspecting relevant code, call `update_activity` with better `areas`, `files`, `summary`, and `steps`.
7. Before changing files, call `update_activity` with `status: editing`.
8. Implement the requested change.
9. Run focused tests first, then broader checks when the change touches shared behavior.
10. During testing or review, call `update_activity` with `status: testing` or `reviewing`.
11. Commit coherent chunks as work is completed. Do not wait until the end if the work naturally splits into reviewable commits.
12. Add or update a Changeset when the change affects published package behavior, unless the user says `no release` or `niente release`.
13. Finish Agent Coordination with `finish_activity`, using `outcome: completed` for completed work or `outcome: abandoned` if stopping without completion. Include changed files when possible.
14. When finished, summarize the implemented change, commits, verification, release impact, and Agent Coordination outcome. Ask for approval before creating a pull request.
15. After approval, create a pull request into `dev`.

## Activity Shape

Keep Agent Coordination activity fields compact:

- `project`: use a stable repo identifier such as `fentaris`.
- `agent`: stable session, thread, or agent label when available.
- `title`: short task title.
- `summary`: one sentence about current work.
- `status`: one of `planning`, `waiting`, `editing`, `testing`, `blocked`, `reviewing`, `done`, `abandoned`.
- `worktree`: current worktree path when useful.
- `branch`: task branch when known.
- `areas`: semantic areas such as `auth`, `cli`, `core`, `mcp-server`, `docs`, `tests`.
- `files`: exact paths only when known.
- `eta_minutes`, `steps`, `notes`, `progress`, `freeform`, or `data` when useful.

Do not over-model. Put details that only humans or LLMs need into `notes`, `progress`, `steps`, or `freeform`.

## Conflict Behavior

- `file_overlap` or `blocking`: coordinate before editing the overlapping file. Prefer a short wait or a concise message.
- `area_overlap`: inspect details, message if unclear, and avoid overlapping files until scope is clear.
- `same_project`: proceed carefully and keep the activity updated.
- `stale`: mention the stale activity in notes and proceed unless the stale activity shows clear risk.

If non-overlapping work can be done safely first, do that instead of waiting.

## Waiting And Messaging

Never sleep for a long ETA blindly. Use short coordination cycles:

- Light conflict: wait 1-3 minutes, then recheck.
- Strong conflict with short ETA: wait 3-5 minutes, then recheck.
- After each wait, call `list_activities` and `list_messages`.
- After 2-3 unchanged cycles, mark your own activity `blocked` or ask the user how to proceed.

Use concise coordination messages to ask whether another agent is still editing an area or file, announce that you will work around their scope, or hand off when you finish an area they were waiting on. Messages do not replace activity updates.

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

## Pull Request Targeting

Feature, fix, refactor, docs, and OpenSpec implementation PRs:

- Source: task branch.
- Target: `dev`.
- Template: feature-to-dev.

Release promotion PRs are not part of this skill. Use the Fentaris release workflow for `dev` to `main`.

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

## Coordination
- Agent Coordination: completed/blocked/unavailable
- Activity: ...
```

## Approval Gate

Do not create the pull request until the user approves. The final pre-PR message should include:

- branch name
- commit summary
- changed files summary
- verification results
- release impact
- Agent Coordination outcome
- proposed PR title and target branch
