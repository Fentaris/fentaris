# Fresh-Install Verification

Use this optional verification gate only when routed here by `fentaris-dev-pr-workflow`. It tests the exact committed PR candidate in a new directory with a context-free Codex subagent. Do not declare the branch ready for a PR until the gate returns `PASS` and the main agent has reviewed its evidence.

This gate strengthens verification only. It does not authorize a push, pull request, destructive cleanup, production access, or use of secrets.

## 1. Freeze the candidate

- Finish and commit all changes intended for the PR. Keep unrelated workspace changes out of the candidate.
- Record the source branch, its pushable head commit SHA, its tree SHA, the current target `dev` SHA, and the explicit ancestry of any stacked branches. Treat this tuple as the candidate identity.
- GitButler workspaces may combine several applied branches and uncommitted files. Never test a copy of the visible workspace: it can contain changes that are absent from the candidate branch.
- Prove that the recorded source head and tree are the ones GitButler would push for the source branch. A synthetic workspace tree or a commit from another applied branch is not a valid candidate.
- Prove that the recorded target `dev` SHA is an ancestor of the source head. If it is not, update the workspace with GitButler, resolve conflicts, rerun normal checks, and freeze a new candidate identity before starting the gate.
- Do not push merely to enable this test. If the exact candidate is already available remotely, it may be cloned. Otherwise use a clean local materialization of the exact committed tree and report that fallback explicitly.

## 2. Allocate an isolated attempt

Resolve `../installation_tests` relative to the Fentaris repository root. Create a new directory named `install<N>`, where `N` is the next unused non-negative integer.

- Allocate the directory atomically and increment `N` if another process created it first.
- Never reuse, overwrite, or delete an earlier `install<N>` directory.
- Use absolute paths in the subagent prompt.
- Request the required filesystem or network approval when the environment cannot create the sibling directory, clone, or install dependencies without it.
- Keep package-manager stores, caches, and temporary files inside the attempt directory through their tool-specific configuration. Do not override `HOME`. If a tool requires writes elsewhere and no narrow approval exists, return `BLOCKED`.

Each retry gets a new numbered directory so earlier evidence remains inspectable.

## 3. Spawn a context-free verifier

Use a Codex subagent with `fork_turns: "none"`. The subagent receives no conversation history or conclusions from the main agent. Its prompt must provide only the raw inputs needed to test the candidate:

- absolute attempt directory and read-only source-repository path;
- source branch, source head SHA, tree SHA, target `dev` SHA, and stack ancestry;
- remote URL when remote acquisition is possible;
- required baseline checks and the user-visible behavior changed by the candidate;
- permission boundaries and the report contract below.

Tell the subagent to begin by changing into the attempt directory and confirming its working directory. The subagent may create files only inside its assigned `install<N>` directory. It must not edit the source repository, change GitButler state, push, open a PR, use real credentials, or fix the candidate.

Do not tell the verifier that the change is expected to pass, suggest likely defects, or provide the main agent's interpretation. Independence is part of the test.

## 4. Acquire a clean source tree

The verifier must obtain the exact candidate under `install<N>`:

1. Prefer a fresh remote clone when the exact candidate commit is already reachable without performing a new push.
2. Otherwise create a clean local archive or equivalent materialization from the exact committed candidate tree in the source repository.

The verifier must record `remote-clone` or `local-committed-tree` as the source mode, independently confirm that the supplied target `dev` SHA is an ancestor of the source head, and prove that the materialized tree matches the supplied tree SHA. Because the source head contains the recorded `dev`, this materialized source tree is the prospective integration tree. It must not copy the current workspace, reuse its `node_modules`, use symlinks into it, or import its generated build output.

Before installing or building, capture the integrity of every file in the candidate tree. After all tests, prove those original files—including the lockfile—are unchanged. For a clone, also require a clean tracked Git state. Generated untracked artifacts may remain only inside the attempt directory.

If the exact candidate cannot be materialized, the verdict is `BLOCKED`, not `PASS`.

## 5. Test from zero

The verifier chooses additional tests from the diff and project documentation, but the following baseline is mandatory unless a command is genuinely inapplicable and the report explains why:

1. Confirm Node satisfies the repository engine requirement and confirm the package-manager version.
2. Install dependencies from the candidate lockfile using the package manager's frozen or immutable lockfile mode.
3. Run the repository's lint, typecheck, build, and complete test suite using its declared scripts. Prefer a repository aggregate verification script when it covers all four.
4. Run any repository-provided package-artifact, clean-install, generated-project, or release verification that is applicable to the candidate.
5. Exercise at least one end-to-end or user-observable scenario selected from the actual change, not only unit tests.
6. When published package behavior changed, pack the affected candidate packages, install those artifacts in an empty consumer project, and exercise their relevant runtime, types, or CLI behavior. A repository-provided script may satisfy this requirement if its evidence shows that it tests the candidate tarballs.

Network-dependent public upstream checks must be identified separately from local product checks. Missing credentials, unavailable infrastructure, or denied network access produce `BLOCKED` when they prevent a mandatory scenario; they are not product failures and must not be silently skipped.

## 6. Require a structured report

The verifier must write `REPORT.md` inside its `install<N>` directory and return the same verdict in its final message. The report must contain:

- verdict: `PASS`, `FAIL`, or `BLOCKED`;
- source mode, branch, candidate identity, and how identity was verified;
- runtime and package-manager versions;
- every command run, its exit status, and a concise result;
- retained stdout and stderr log paths for every mandatory check and end-to-end scenario;
- scenarios exercised and their observable outcomes;
- failures or blockers with reproduction details;
- skipped checks with justification;
- artifact or log paths inside the attempt directory;
- candidate-tree integrity results before and after testing;
- for packed-package tests, tarball filenames, SHA-256 hashes, and evidence that those exact tarballs were installed;
- residual risks and untested behavior.

The verifier must redact secrets and avoid copying tokens, auth stores, or user data into the report or logs.

## Main-Agent Review and Remediation

After the subagent finishes, inspect both its final response and `REPORT.md`. Review supporting logs when a result is unclear. Do not accept the verdict alone.

Accept `PASS` only when:

- the report proves it tested the exact committed candidate;
- all mandatory applicable checks succeeded;
- the changed behavior was exercised through a meaningful scenario;
- no unexplained skip or contradictory evidence remains.

For `FAIL`, reproduce or inspect the evidence, fix the source branch within the user's scope, run appropriate focused checks, commit the fix, and start a new independent attempt in the next `install<N>` directory. The verifier never fixes the source itself.

For `BLOCKED`, correct safe local infrastructure issues and retry in a new directory. Ask the user before expanding scope, using credentials, pushing solely for the test, or taking destructive or externally mutating action.

Stop and request direction when two consecutive attempts have the same root-cause signature after the main agent has made one targeted remediation. Fresh logs alone are not new evidence; a candidate or infrastructure change that directly addresses the root cause is. Also stop when remediation requires a product decision or work outside the requested change.

## Pre-PR Evidence

Add the following to the base workflow's pre-PR approval summary:

- installation-test attempt directory;
- verifier verdict and exact candidate identity;
- source mode;
- baseline checks and end-to-end scenarios completed;
- fixes and independent retries, if any;
- skipped checks or residual risks.

Only describe the branch as ready and ask approval to create the PR into `dev` after a reviewed `PASS`.

Immediately before any push or PR-creation operation, resolve the source head SHA, tree SHA, stack ancestry, and target `dev` SHA again. If the source identity or tested integration base changed, the prior `PASS` is stale: run the complete gate in a new attempt and obtain approval again. After PR creation, verify that the PR head matches the tested source head; if it does not, report the mismatch immediately and do not represent the PR as verified.
