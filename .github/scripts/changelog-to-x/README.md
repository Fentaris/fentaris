# Changelog to X

Posts a short thread from the Fentaris X account after every Changesets release wave, the way [@ClaudeCodeLog](https://x.com/ClaudeCodeLog) announces Claude Code releases. The text comes from the release notes Changesets generated (i.e. from the changeset files written in the PRs), condensed by Claude into one to three tweets, validated by code, with the link to the GitHub Release in a reply.

Nothing in this folder is part of a published package. It has its own `package.json` and lockfile and is installed with `--ignore-workspace`.

## How a wave becomes a post

1. `Release` finishes on `main`. The `Changelog to X` workflow runs on `workflow_run` and checks out the same commit.
2. `lib/wave.mjs` compares every `packages/*/package.json` version with its first parent. No bump means the push was a "promote dev to main" or a chore, and the run ends. A bump means a "Version Packages" merge.
3. For each bumped package it asks `gh release view` for the GitHub Release. Changesets creates one only for what it published, so this is also the "npm publish happened" check. The release body is the notes.
4. Packages whose notes are only `Updated dependencies` are marked dependency-only. The main package is the one with the highest bump among the rest (ties: core, cli, edge, approval-telegram). If every package is dependency-only, nothing is announced.
5. The Version Packages PR is found from the commit. An existing `changelog-to-x` comment on it is the idempotency marker: `status=posted` (or `partial`) stops the run unless `--force`.
6. `lib/compose.mjs` calls Claude with `prompt/system.md` and the notes, expecting `{ skip, reason, tweets }`. `lib/validate.mjs` checks the result: lengths (single < 200, thread < 250 code points), no URLs, no `@`, at most one `#`, no emoji, no `!`, banned vocabulary, no first person, every number present in the notes, tweet 1 naming the main package and version, no repeated sentences. One failure sends the errors back to Claude for a retry; a second failure uses the deterministic template (`fentaris/core 3.1.1 is out. <first bullet>`). If even that fails validation, the run exits 1 and the text lands in the comment for a human.
7. In `dry-run` the thread is written to the PR comment and the job summary. In `live` it is posted with OAuth 1.0a: the marker is written right after the first tweet succeeds, the rest of the thread follows, then `Release notes: <url>` as the last reply.

## Modes

| `CHANGELOG_X_MODE` (repository variable) | Behaviour |
|---|---|
| unset or `off` | The job is skipped at the `if`. Default. |
| `dry-run` | Compose, comment on the PR, post nothing. |
| `live` | Post. |

A `workflow_dispatch` can pass `mode=dry-run` to lower a `live` variable for one run. It can never raise `dry-run` to `live`; the variable is the only switch.

`CHANGELOG_X_MODEL` (optional variable) overrides the model, default `claude-sonnet-5`.

## Secrets

| Secret | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com. Use a dedicated key so it can be revoked alone. |
| `X_API_KEY`, `X_API_SECRET` | console.x.com, signed in as the Fentaris account: create a project and an app, then Keys and tokens, Consumer keys. |
| `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | Same app, Authentication tokens, Access token and secret. Set the app's user authentication to **Read and Write before** generating them: tokens generated while the app is read-only stay read-only and fail with 403 on `POST /2/tweets`. |

X bills API usage per request from prepaid credits on the developer account: about $0.015 per tweet and $0.20 for the reply that contains the link, so roughly $0.25 per wave.

## Running it by hand

From a clone, with `gh` authenticated:

```sh
cd .github/scripts/changelog-to-x
pnpm install --ignore-workspace
pnpm test

# Show what the 2026-09-14 wave would have produced, without touching the PR
CHANGELOG_X_MODE=dry-run node index.mjs --tags "@fentaris/core@3.1.1,@fentaris/cli@1.6.1,@fentaris/edge@0.3.4,@fentaris/approval-telegram@0.1.15" --stdout

# Same, without calling Claude (template only)
CHANGELOG_X_MODE=dry-run node index.mjs --tags "@fentaris/core@3.1.1" --stdout --no-llm

# A promote push: must print "not a release wave"
CHANGELOG_X_MODE=dry-run node index.mjs --ref 0188c469 --stdout
```

`--stdout` prints the comment instead of writing it to the PR. `--no-llm` skips Claude. `--force` ignores a posted marker.

In CI, once the workflow is on `main`:

```sh
gh workflow run changelog-to-x.yml -R Fentaris/fentaris -f tags="@fentaris/core@3.1.1" -f mode=dry-run
```

## Reading the PR comment

Every run that reaches the compose step leaves one comment on the Version Packages PR, updated in place. The first line is the machine marker:

```
<!-- changelog-to-x wave=<sha> status=dry-run|posted|partial|failed|skipped|needs-human tweets=<ids> -->
```

`partial` means the first tweet went out and a later one failed: finish or delete the thread by hand, then either leave the marker (the wave stays closed) or re-run with `force` after deleting the posted tweets.

## What it refuses to do

- Post when there is no pull request to anchor the marker on (a commit pushed to `main` by hand).
- Retry a 403 from X (permissions or duplicate text).
- Mark the `Release` run as failed: this workflow fails on its own.
