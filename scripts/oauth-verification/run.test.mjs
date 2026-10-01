import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { parseArgs } from "./run.mjs";
import { MCPJAM_CLI_VERSION, SCENARIOS } from "./catalog.mjs";
import { REQUIREMENTS } from "./requirements.mjs";
import { initializeAttempt, scanArtifacts, requirementMatrix, verdict, renderReport } from "./lib.mjs";
import { materializeFixtures } from "./fixtures.mjs";
const exec = promisify(execFile);

test("validates options before allocating attempts", () => {
  assert.throws(() => parseArgs(["--scenario", "unknown"]), /Unknown scenario/);
  assert.throws(() => parseArgs(["--attempt", "relative"]), /absolute/);
  assert.throws(() => parseArgs(["--candidate"]), /Invalid option/);
  assert.equal(parseArgs([]).scenario, "all");
  assert.match(MCPJAM_CLI_VERSION, /^\d+\.\d+\.\d+$/);
});
test("a partial or evidence-free campaign cannot PASS", () => {
  const results = SCENARIOS.map((scenario) => ({ ...scenario, status: "PASS", commands: [{}] }));
  assert.equal(verdict(results, requirementMatrix(REQUIREMENTS, results), []), "PASS");
  results[2].status = "BLOCKED";
  assert.equal(verdict(results, requirementMatrix(REQUIREMENTS, results), []), "BLOCKED");
  results[2].status = "FAIL";
  assert.equal(verdict(results, requirementMatrix(REQUIREMENTS, results), []), "FAIL");
  assert.equal(verdict([], requirementMatrix(REQUIREMENTS, []), []), "BLOCKED");
  assert.equal(verdict(results, [], [{ file: "leak" }]), "FAIL");
});
test("retains report links, immutable attempts and redacts nested artifact leaks", async () => {
  const attempt = await mkdtemp(path.join(tmpdir(), "oauth-verification-selftest-"));
  try {
    const layout = await initializeAttempt(attempt, ".oauth-verification.json");
    await assert.rejects(initializeAttempt(attempt, ".oauth-verification.json"), /already used/);
    await mkdir(path.join(layout.artifacts, "nested"));
    const file = path.join(layout.artifacts, "nested/token.json");
    await writeFile(file, '{"secret":"sentinel-token"}');
    const leaks = await scanArtifacts(attempt, ["sentinel-token", ""]);
    assert.equal(leaks.length, 1); assert.equal(await readFile(file, "utf8"), '{"secret":"[REDACTED]"}');
    const report = renderReport({ attempt, identity: { branch: "candidate", sourceHead: "abc", tree: "def", targetDev: "dev" }, artifacts: [], results: [{ id: "blocked", status: "BLOCKED", commands: [{ command: ["node", "scenario.mjs"], exitCode: 1, stdoutPath: file, stderrPath: file }] }], matrix: [], verdict: "BLOCKED", leaks, integrityErrors: [], mcpjamVersion: MCPJAM_CLI_VERSION });
    assert.match(report, /\*\*BLOCKED\*\*/); assert.match(report, /\]\(artifacts\/nested\/token.json\)/);
  } finally { await rm(attempt, { recursive: true, force: true }); }
});
test("materializes parseable fixtures with stable identity and no product source imports", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "oauth-fixtures-selftest-"));
  try {
    const root = path.resolve(import.meta.dirname, "../..");
    const fixtures = await materializeFixtures(root, project);
    assert.equal(fixtures.length, 3);
    for (const fixture of fixtures) {
      assert.match(fixture.sourceDigest, /^sha256:/);
      const file = path.join(project, `${fixture.fixture}.mjs`);
      await exec(process.execPath, ["--check", file]);
      assert.doesNotMatch(await readFile(file, "utf8"), /\.\.\/.*src/);
    }
  } finally { await rm(project, { recursive: true, force: true }); }
});
