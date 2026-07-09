---
name: fentaris-pr-release-workflow
description: Use when working in the Fentaris repository on commits, branches, pull requests, release preparation, changelogs, versioning, npm publishing, GitHub releases, or Changesets.
---

# Fentaris PR and Release Workflow

Follow this workflow when the user asks to create commits, branches, pull requests, releases, changelogs, or npm publishing setup in this repository.

## Branch Model

- `dev` is the default development branch.
- `main` is the release branch.
- Feature branches merge into `dev`.
- Release PRs merge `dev` into `main`.
- Do not merge feature branches directly into `main` unless the user explicitly asks for a hotfix.

## Pull Requests

For feature work:

- Target branch: `dev`.
- Include tests/build verification in the PR body.
- Mention whether a Changeset is needed.
- If the user gives a release hint such as `patch`, `minor`, `major`, `minor update`, or `no release`, apply it without asking again.
- If the PR changes published package behavior and the user did not say `no release` or `niente release`, create a Changeset automatically before opening the PR.
- If release impact is unclear, choose conservatively:
  - `patch` for fixes, docs that ship in packages, CI/release fixes, small compatible behavior changes.
  - `minor` for new compatible user-facing features.
  - `major` only for explicit breaking changes.

For release work:

- Target branch: `main`.
- Source branch: `dev` or a generated version branch.
- The PR must make clear whether it is a release promotion or a generated version PR.

Use concise PR bodies:

```md
## Summary
- ...

## Verification
- ...

## Release
- Changeset: yes/no
- Version impact: patch/minor/major/none
```

## Versioning and Changelog

Use Changesets for published package changes.

- Add a changeset for any user-facing or npm-published change.
- When Codex is asked to make a PR, Codex is responsible for adding the changeset unless the user explicitly says no release is needed.
- Use `patch` for bug fixes and small compatible changes.
- Use `minor` for new compatible features.
- Use `major` for breaking changes.
- Do not invent version bumps from commit messages.
- Changelog entries should explain user-visible impact, not implementation trivia.
- If the user says only `minor update`, apply `minor` to the published package(s) touched by the PR.
- If multiple published packages changed, include all affected packages in one changeset unless separate changelog messages would be clearer.
- If only repo automation, tests, internal docs, or non-published files changed, either add an empty changeset or mark `Changeset: no` in the PR body, depending on whether Changesets would otherwise require one.

## Automation Expectations

The preferred release automation is:

1. PRs merge into `dev`.
2. A release PR promotes `dev` into `main`.
3. GitHub Actions on `main` runs Changesets.
4. If changesets exist, the action opens or updates a Version Packages PR against `main`.
5. Merging the Version Packages PR publishes packages to npm and creates GitHub releases.

Prefer npm Trusted Publishing with OIDC over long-lived `NPM_TOKEN` secrets when package and account setup allow it.

## Agent Behavior

When Codex makes commits or PRs in this repo:

- Prefer GitButler commands when available for branch, stage, commit, and PR work.
- Keep commits scoped and named clearly.
- Do not stage unrelated user changes.
- Include verification results in the final response and PR body.
- If release-relevant files changed and no changeset exists, create it before finalizing.
- Interpret user shorthand:
  - `fai una PR minor update` means create/update a changeset with `minor`.
  - `fai una PR patch` means create/update a changeset with `patch`.
  - `fai una PR major` means create/update a changeset with `major`, but mention breaking-change risk.
  - `fai una PR no release` or `niente release` means do not create a publishing changeset.
