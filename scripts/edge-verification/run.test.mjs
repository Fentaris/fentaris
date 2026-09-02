import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allocateAttempt,
  assertAbsoluteContained,
  buildRequirementMatrix,
  compareSnapshots,
  coreVerdict,
  initializeAttempt,
  renderMatrix,
  renderReport,
  scanAndRedactLogs,
} from "./lib.mjs";

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
});

test("builds the tracked requirement matrix without reading source specs", () => {
  const sources = [{ source: "openspec/specs/example/spec.md", requirements: ["Tracked requirement"], scenarios: ["scenario"] }];
  const results = [{ status: "passed", scenarios: ["scenario"], commands: [{ stdoutPath: "/tmp/stdout", stderrPath: "/tmp/stderr" }] }];
  assert.deepEqual(buildRequirementMatrix(sources, results), [{
    requirement: "Tracked requirement",
    source: "openspec/specs/example/spec.md",
    scenarios: ["scenario"],
    mandatory: true,
    status: "passed",
    evidence: ["/tmp/stdout", "/tmp/stderr"],
  }]);
});

test("renders matrix and structured report", () => {
  const attempt = "/tmp/install9";
  const matrix = [{ requirement: "Edge joins", source: "spec.md", scenarios: ["join"], status: "passed", evidence: ["/tmp/install9/logs/join.log"] }];
  assert.match(renderMatrix(matrix, attempt), /Edge joins/);
  const report = renderReport({ verdict: "BLOCKED", canaryStatus: "PARTIAL", identity: { branch: "codex/test", sourceHead: "abc", tree: "def", targetDev: "123" }, attempt, results: [{ id: "00", status: "blocked", reason: "native gate missing", commands: [] }], matrix, leaks: [], changedFiles: [], artifacts: [] });
  assert.match(report, /\*\*BLOCKED\*\*/);
  assert.match(report, /Canaries: PARTIAL/);
  assert.match(report, /native gate missing/);
});
