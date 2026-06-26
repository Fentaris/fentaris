---
name: fix-pr-issues
description: "Use when the user asks the pi agent to fix, resolve, or address issues from a PR review on the Fentaris repo (e.g. /pi resolve the issues you found, /pi fixa i P2). Defines the autonomous fix flow: read review, prioritize, fix, validate, commit, push."
---

# Fix PR Issues — Fentaris

## When this skill applies

This skill is loaded when the agent receives a request to fix issues on an existing PR. Trigger phrases:

- `fix the issues`
- `resolve the issues`
- `address the review`
- `fixa i P2`, `risolvi`, `sistema`
- `apply the review feedback`

The agent is running in a GitHub Actions workflow (`pi-comment.yml`) on a checked-out PR branch, with `loaded_tools: all` enabled (full read+write+git access).

## Flow

### 1. Read existing reviews

```typescript
get_issue_or_pr_thread({ pull_number: <pr-number> })
```

This returns all review comments (summary bodies + inline). Parse them to find:

- The list of P1/P2/P3 issues
- File paths and line numbers
- Issue titles and bodies

If the user gave a scope (e.g. "fix only P2"), respect it — don't expand.

### 2. Prioritize

| Severity | Action |
|---|---|
| P1 (blocker) | must fix |
| P2 (major) | must fix |
| P3 (minor) | fix only if trivial (≤ 5 line change) |
| P4 (nit) | skip unless user explicitly asked |

If the user said `fix everything` or `fixa tutto`, default to P1 + P2 only. P3/P4 stay as nits.

### 3. For each issue to fix

1. `read_file` on the relevant file to see current code + context
2. Read surrounding lines (the issue might be in a helper, not the line flagged)
3. Apply the fix with `Edit` (preferred — minimal diff) or `write_file` (last resort)
4. If there's an existing test for the affected behavior, read it and check if it still passes

### 4. Validate (run all, in order)

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm -r test
```

If `lint` or `typecheck` fails on code you did NOT touch, **stop and ask the user** — don't try to fix pre-existing issues.

If a test fails on your change, fix it. If a test fails for an unrelated reason, note it in the commit body but commit anyway.

### 5. Commit (one per issue)

- **Atomic**: one commit per issue, easy to revert
- **Style**: conventional commits — `fix(<area>): <one-line summary>`
  - `fix(cli):` for `packages/cli/`
  - `fix(core):` for `packages/core/`
  - `fix(workflows):` for `.github/`
  - `fix(skill):` for `.pi/skills/`
- **Body**: explain WHY, not what (the diff shows what). Include the issue context.
- **Example**:
  ```
  fix(cli): validate every semver comparator token

  P2 from review #167 — quoted multi-token values like
  `--core-version '>=2.0.0 typo'` passed validation because
  trailing tokens weren't checked as semver comparators.
  Now rejected at parse time.
  ```

### 6. Push to the PR

Use `update_pull_request` with one call per commit:

```typescript
update_pull_request({
  pull_number: <pr-number>,
  message: "<the commit message>"
})
```

The action handles `git add` + `git commit` + `git push` for you.

**Do NOT use `create_pull_request`** — fixes go on the existing PR, not a new one.

### 7. Comment on the PR

Post a summary so the user knows what was done:

```
🤖 **Fixes applied by pi + <model>**

**Resolved (N):**
- 🛑 P1: <title> → commit `<sha>`
- 🟠 P2: <title> → commit `<sha>`

**Skipped (M):**
- 🟡 P3: <title> — <reason>

**Verification:**
- pnpm lint ✅
- pnpm typecheck ✅
- pnpm test ✅ (X tests, Y passed)

Review the commits and merge when ready.
```

## Hard rules

- ❌ **NEVER push to `main` or `dev` directly** — only to the PR's branch
- ❌ **NEVER merge the PR** — the user merges
- ❌ **NEVER change unrelated code** — scope creep is the #1 way to break things
- ❌ **NEVER skip validation** — if lint/typecheck fails, stop and ask
- ❌ **NEVER add a changeset** for internal fixes — only if the fix changes published behavior (CLI flag, public API, default behavior). When in doubt, skip the changeset.
- ❌ **NEVER refactor while fixing** — separate concern. If you see refactor opportunities, mention them in the comment, don't do them.

## Edge cases

### Issue is subjective / needs design decision
Post a comment on the PR asking for clarification. Do NOT guess.

Example:
> "🤖 pi + <model>: I see the P2 about X, but there are 2 valid approaches:
> 1. Approach A: <description> — pros: ..., cons: ...
> 2. Approach B: <description> — pros: ..., cons: ...
> Which one do you prefer? I won't apply either until you confirm."

### Fix is too large (>50 lines or touches >2 packages)
Stop, ask the user. Don't auto-apply big refactors.

### Validation fails on code you didn't touch
Stop, report which file and which rule, ask the user how to proceed.

### The PR has merge conflicts
`update_pull_request` will fail. Report the conflict in the comment, don't try to resolve it (merge conflicts need human judgment).

### Multiple commits fail to push (e.g. force-push protection)
Report the issue, link the run logs.

## Repository conventions (Fentaris-specific)

- **Package manager**: pnpm (never npm/yarn)
- **TypeScript**: strict mode, no `any` in new code
- **Public API**: changes to `@fentaris/core` exports need a `major` changeset
- **CLI**: changes to command surface (new flags, changed behavior) need at least a `minor` changeset
- **Tests**: colocated in `test/` directory per package, run with `vitest`
- **Linting**: `pnpm lint` runs ESLint + Prettier
- **Skill files** are in `.pi/skills/<name>/SKILL.md` — load them with `read_file` when relevant
