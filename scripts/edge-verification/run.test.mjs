import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PHASES, REQUIREMENT_SOURCES } from "./catalog.mjs";
import {
  allocateAttempt,
  assertAbsoluteContained,
  buildRequirementMatrix,
  compareSnapshots,
  coreVerdict,
  initializeAttempt,
  renderMatrix,
  renderReport,
  runLogged,
  scanAndRedactLogs,
  verifyCandidateIdentity,
} from "./lib.mjs";

const execFileAsync = promisify(execFile);

test("allocates immutable attempts atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edge-attempt-test-"));
  const attempts = await Promise.all(Array.from({ length: 4 }, () => allocateAttempt(root)));
  assert.equal(new Set(attempts).size, 4);
  assert.deepEqual(attempts.map((attempt) => path.basename(attempt)).sort(), ["install0", "install1", "install2", "install3"]);
  await initializeAttempt(attempts[0]);
  await assert.rejects(() => initializeAttempt(attempts[0]), /already used/);
});

test("rejects paths outside the attempt parent", () => {
  assert.equal(assertAbsoluteContained("/tmp/edge-parent", "/tmp/edge-parent/install0"), "/tmp/edge-parent/install0");
  assert.throws(() => assertAbsoluteContained("/tmp/edge-parent", "/tmp/other"), /not a child/);
  assert.throws(() => assertAbsoluteContained("relative", "/tmp/other"), /absolute/);
});

test("compares source snapshots", () => {
  assert.deepEqual(compareSnapshots([{ path: "pnpm-lock.yaml", digest: "a" }], [{ path: "pnpm-lock.yaml", digest: "b" }, { path: "new", digest: "c" }]), ["new", "pnpm-lock.yaml"]);
});

test("redacts sentinel leaks and makes the verdict fail", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edge-log-test-"));
  const logs = path.join(root, "logs");
  await mkdir(logs);
  await writeFile(path.join(logs, "scenario.stdout.log"), "token=secret-sentinel");
  const leaks = await scanAndRedactLogs(logs, ["secret-sentinel"]);
  assert.equal(leaks.length, 1);
  assert.equal(await readFile(path.join(logs, "scenario.stdout.log"), "utf8"), "token=[REDACTED]");
  assert.equal(coreVerdict({ selectedAll: true, results: [], matrix: [], leaks, changedFiles: [], nativeRequired: false }), "FAIL");
});

test("requires complete evidence and native identity before PASS", () => {
  const matrix = [{ mandatory: true, status: "passed" }];
  assert.equal(coreVerdict({ selectedAll: true, results: [{ status: "passed" }], matrix, leaks: [], changedFiles: [], nativeRequired: false }), "PASS");
  assert.equal(coreVerdict({ selectedAll: false, results: [{ status: "passed" }], matrix, leaks: [], changedFiles: [], nativeRequired: false }), "BLOCKED");
  assert.equal(coreVerdict({ selectedAll: true, results: [{ status: "failed" }], matrix, leaks: [], changedFiles: [], nativeRequired: false }), "FAIL");
  assert.equal(coreVerdict({ selectedAll: true, results: [{ status: "passed" }], matrix, leaks: [], changedFiles: [], nativeRequired: true }), "BLOCKED");
  assert.equal(coreVerdict({ selectedAll: true, results: [{ status: "passed" }], matrix, leaks: [], changedFiles: [], identityUnverified: true }), "BLOCKED");
});

test("rejects unknown phases before allocating an immutable attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edge-phase-guard-"));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "run.mjs");
  await assert.rejects(
    () => execFileAsync(process.execPath, [script, "--attempt", path.join(root, "install0"), "--phase", "not-a-phase"], { cwd: path.dirname(script) }),
    (error) => /Unknown phase: not-a-phase/.test(`${error?.message ?? ""}\n${error?.stderr ?? ""}`),
  );
  await assert.rejects(() => readFile(path.join(root, "install0", ".edge-verification.json")), (error) => error?.code === "ENOENT");
});

test("builds the tracked requirement matrix without reading source specs", () => {
  const sources = [{ source: "openspec/specs/example/spec.md", requirements: [{ title: "Tracked requirement", scenario: "scenario", expectation: "Observable result", evidenceIds: ["scenario-command"] }] }];
  const results = [{ status: "passed", scenarios: ["scenario"], commands: [{ id: "scenario-command", exitCode: 0, expectedExitCodes: [0], stdoutPath: "/tmp/stdout", stderrPath: "/tmp/stderr" }] }];
  assert.deepEqual(buildRequirementMatrix(sources, results), [{
    requirement: "Tracked requirement",
    source: "openspec/specs/example/spec.md",
    scenarios: ["scenario"],
    expectation: "Observable result",
    evidenceIds: ["scenario-command"],
    mandatory: true,
    status: "passed",
    evidence: ["/tmp/stdout", "/tmp/stderr"],
  }]);
  assert.equal(buildRequirementMatrix(sources, [{ status: "passed", scenarios: ["scenario"], commands: [] }])[0].status, "blocked");
});

test("requires explicit scenario, expectation, and evidence ids for every tracked requirement", () => {
  const requirements = REQUIREMENT_SOURCES.flatMap((source) => source.requirements);
  const catalogEvidence = new Set(PHASES.flatMap((phase) => [
    ...phase.commands.map((command) => `${phase.id}-${command.id}`),
    `${phase.id}-consumer-install`,
    `${phase.id}-practical`,
  ]));
  assert.ok(requirements.length > 0);
  assert.equal(new Set(requirements.map((requirement) => requirement.title)).size, requirements.length);
  for (const requirement of requirements) {
    assert.ok(requirement.scenario);
    assert.ok(requirement.expectation);
    assert.ok(requirement.evidenceIds.length >= 3);
    assert.ok(requirement.evidenceIds.some((id) => id.endsWith("-consumer-install")));
    assert.ok(requirement.evidenceIds.some((id) => id.endsWith("-practical")));
    for (const evidenceId of requirement.evidenceIds) assert.ok(catalogEvidence.has(evidenceId), `${requirement.title} references unknown evidence ${evidenceId}`);
  }
});

test("renders matrix and structured report", () => {
  const attempt = "/tmp/install9";
  const matrix = [{ requirement: "Edge joins", source: "spec.md", scenarios: ["join"], expectation: "Join is observable", status: "passed", evidence: ["/tmp/install9/logs/join.log"] }];
  assert.match(renderMatrix(matrix, attempt), /Edge joins/);
  const report = renderReport({ verdict: "BLOCKED", canaryStatus: "PARTIAL", identity: { branch: "codex/test", sourceHead: "abc", tree: "def", targetDev: "123" }, identityVerification: { verified: false, repository: "/tmp/source", errors: ["not proven"] }, attempt, results: [{ id: "00", status: "blocked", reason: "native gate missing", commands: [] }], matrix, leaks: [], changedFiles: [], artifacts: [] });
  assert.match(report, /\*\*BLOCKED\*\*/);
  assert.match(report, /Canaries: PARTIAL/);
  assert.match(report, /Candidate identity: UNVERIFIED/);
  assert.match(report, /native gate missing/);
});

test("proves commit, tree, ancestry, branch, and materialized files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edge-identity-test-"));
  const repository = path.join(root, "source");
  const candidate = path.join(root, "candidate");
  await mkdir(repository);
  await execFileAsync("git", ["init", "-b", "codex/test"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "verification@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Verification Test"], { cwd: repository });
  await writeFile(path.join(repository, "candidate.txt"), "base\n");
  await mkdir(path.join(repository, "nested"));
  await writeFile(path.join(repository, "nested", "tracked.txt"), "nested\n");
  await execFileAsync("git", ["add", "candidate.txt", "nested/tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });
  const targetDev = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  await writeFile(path.join(repository, "candidate.txt"), "candidate\n");
  await execFileAsync("git", ["commit", "-am", "candidate"], { cwd: repository });
  const sourceHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const tree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })).stdout.trim();
  await cp(repository, candidate, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
  const verified = await verifyCandidateIdentity({ candidateRoot: candidate, identityRepository: repository, branch: "codex/test", sourceHead, tree, targetDev });
  assert.equal(verified.verified, true, verified.errors.join("; "));
  await writeFile(path.join(candidate, "candidate.txt"), "dirty\n");
  const dirty = await verifyCandidateIdentity({ candidateRoot: candidate, identityRepository: repository, branch: "codex/test", sourceHead, tree, targetDev });
  assert.equal(dirty.verified, false);
  assert.match(dirty.errors.join("; "), /differs at candidate\.txt/);
});

test("kills timed-out process groups and retains their logs", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edge-timeout-test-"));
  const program = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  let failure;
  try {
    await runLogged({ command: process.execPath, args: ["-e", program], cwd: root, logs: root, id: "timeout", timeoutMs: 40, killAfterMs: 40 });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.record.timedOut, true);
  assert.equal(failure.record.terminationSignal, "SIGKILL");
  const childPid = Number((await readFile(path.join(root, "timeout.stdout.log"), "utf8")).trim());
  assert.ok(Number.isInteger(childPid));
  assert.throws(() => process.kill(childPid, 0), (error) => error?.code === "ESRCH");
});
