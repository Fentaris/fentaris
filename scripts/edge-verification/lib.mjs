import { hashFile } from "../verification/lib.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const IGNORED_TREE_NAMES = new Set([".git", "node_modules", "dist", ".turbo", ".cache"]);
const execFileAsync = promisify(execFile);
const LOCAL_TOOLING_NAMES = new Set([".pnpm-store", "tmp", ".DS_Store", ".agents", ".claude", ".codex", ".cursor", ".grok", ".opencode", ".pi", "openspec", "AGENTS.md", "agent-skills.json", "agent-skills.lock"]);
function localToolingPath(relative, name) {
  return LOCAL_TOOLING_NAMES.has(name) || relative === ".github/prompts" || relative === ".github/skills";
}

export async function verifyCandidateIdentity({ candidateRoot, identityRepository, branch, sourceHead, tree, targetDev, ignoreGenerated = false }) {
  const errors = [];
  const repository = path.resolve(identityRepository);
  const candidate = path.resolve(candidateRoot);
  if (!validBranch(branch)) errors.push("branch name is missing or invalid");
  for (const [label, value] of [["source head", sourceHead], ["tree", tree], ["target dev", targetDev]]) {
    if (!/^[0-9a-f]{40,64}$/i.test(value ?? "")) errors.push(`${label} is not a full object id`);
  }
  if (errors.length > 0) return { verified: false, repository, errors };

  const git = async (args) => (await execFileAsync("git", ["-C", repository, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  try {
    const resolvedHead = await git(["rev-parse", `${sourceHead}^{commit}`]);
    if (resolvedHead !== sourceHead) errors.push(`source head resolves to ${resolvedHead}`);
    const resolvedTree = await git(["rev-parse", `${sourceHead}^{tree}`]);
    if (resolvedTree !== tree) errors.push(`source tree is ${resolvedTree}, not ${tree}`);
    const resolvedTarget = await git(["rev-parse", `${targetDev}^{commit}`]);
    if (resolvedTarget !== targetDev) errors.push(`target dev resolves to ${resolvedTarget}`);
    try {
      await execFileAsync("git", ["-C", repository, "merge-base", "--is-ancestor", targetDev, sourceHead]);
    } catch {
      errors.push("target dev is not an ancestor of source head");
    }
    const branchRefs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
    const branchHeads = [];
    for (const ref of branchRefs) {
      try { branchHeads.push(await git(["rev-parse", "--verify", ref])); } catch { /* ref is optional */ }
    }
    if (!branchHeads.includes(sourceHead)) errors.push(`branch ${branch} does not resolve to source head`);
    const materialized = await compareCandidateToCommit(candidate, repository, sourceHead, ignoreGenerated);
    errors.push(...materialized.errors);
    return {
      verified: errors.length === 0,
      repository,
      materializedFiles: materialized.materializedFiles,
      trackedFiles: materialized.trackedFiles,
      errors,
    };
  } catch (error) {
    errors.push(`identity repository could not prove the candidate: ${error instanceof Error ? error.message : String(error)}`);
    return { verified: false, repository, errors };
  }
}

async function compareCandidateToCommit(candidateRoot, repository, sourceHead, ignoreGenerated) {
  const { stdout } = await execFileAsync("git", ["-C", repository, "ls-tree", "-rz", "-r", "--full-tree", sourceHead], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  const tracked = new Map();
  for (const frame of stdout.toString("utf8").split("\0")) {
    if (!frame) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(frame);
    if (!match) throw new Error(`unexpected git tree entry: ${frame}`);
    tracked.set(match[4], { mode: match[1], type: match[2], object: match[3] });
  }
  const materialized = await materializedTree(candidateRoot, ignoreGenerated);
  const errors = [];
  for (const file of [...new Set([...tracked.keys(), ...materialized.keys()])].sort()) {
    const expected = tracked.get(file);
    const actual = materialized.get(file);
    if (!expected) errors.push(`materialized candidate has untracked file ${file}`);
    else if (!actual) errors.push(`materialized candidate is missing ${file}`);
    else if (expected.type !== "blob") errors.push(`unsupported tracked ${expected.type} at ${file}`);
    else if (expected.object !== actual.object || expected.mode !== actual.mode) errors.push(`materialized candidate differs at ${file}`);
  }
  return { errors, materializedFiles: materialized.size, trackedFiles: tracked.size };
}

async function materializedTree(root, ignoreGenerated) {
  const rows = new Map();
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryRelative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/");
      if (entry.name === ".git" || (ignoreGenerated && (IGNORED_TREE_NAMES.has(entry.name) || localToolingPath(entryRelative, entry.name) || entry.name.endsWith(".tsbuildinfo")))) continue;
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const details = await lstat(file);
        const contents = entry.isSymbolicLink() ? Buffer.from(await readlink(file)) : await readFile(file);
        rows.set(relative, {
          mode: entry.isSymbolicLink() ? "120000" : (details.mode & 0o111) === 0 ? "100644" : "100755",
          object: gitBlobHash(contents),
        });
      }
    }
  };
  await walk(root);
  return rows;
}

function gitBlobHash(contents) {
  return createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");
}

function validBranch(value) {
  return typeof value === "string" && /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/.test(value);
}

export async function snapshotTree(root, { ignoreLocalFiles = false } = {}) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryRelative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/");
      if (IGNORED_TREE_NAMES.has(entry.name) || entry.name.endsWith(".tsbuildinfo") || (ignoreLocalFiles && localToolingPath(entryRelative, entry.name))) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) rows.push({ path: path.relative(root, file).split(path.sep).join("/"), digest: await hashFile(file) });
    }
  };
  await walk(root);
  return rows;
}

export function compareSnapshots(before, after) {
  const left = new Map(before.map((row) => [row.path, row.digest]));
  const right = new Map(after.map((row) => [row.path, row.digest]));
  return [...new Set([...left.keys(), ...right.keys()])].sort().filter((file) => left.get(file) !== right.get(file));
}

export function coreVerdict({ selectedAll, results, matrix, leaks, changedFiles, nativeRequired = false, identityUnverified = false }) {
  if (results.some((result) => result.status === "failed") || leaks.length > 0 || changedFiles.length > 0) return "FAIL";
  if (!selectedAll || nativeRequired || identityUnverified || matrix.some((row) => row.mandatory && row.status !== "passed")) return "BLOCKED";
  return "PASS";
}

export function buildRequirementMatrix(requirementSources, results) {
  const byScenario = new Map();
  const byEvidenceId = new Map();
  for (const result of results) {
    for (const scenario of result.scenarios) byScenario.set(scenario, result);
    for (const record of result.commands ?? []) byEvidenceId.set(record.id, record);
  }
  return requirementSources.flatMap((source) => source.requirements.map((requirement) => {
    const scenario = byScenario.get(requirement.scenario);
    const records = requirement.evidenceIds.map((id) => byEvidenceId.get(id)).filter(Boolean);
    const evidence = records.flatMap((record) => [record.stdoutPath, record.stderrPath]);
    const complete = scenario?.status === "passed"
      && records.length === requirement.evidenceIds.length
      && records.every((record) => record.expectedExitCodes.includes(record.exitCode) && !record.timedOut);
    return {
      requirement: requirement.title,
      source: source.source,
      scenarios: [requirement.scenario],
      expectation: requirement.expectation,
      evidenceIds: [...requirement.evidenceIds],
      mandatory: true,
      status: complete ? "passed" : scenario?.status === "failed" || records.some((record) => !record.expectedExitCodes.includes(record.exitCode) || record.timedOut) ? "failed" : "blocked",
      evidence,
    };
  }));
}

export function renderMatrix(rows, attempt) {
  const header = "| Requirement | Source | Scenario | Observable expectation | Status | Evidence |\n|---|---|---|---|---|---|";
  const body = rows.map((row) => `| ${escapeCell(row.requirement)} | ${escapeCell(row.source)} | ${row.scenarios.join(", ")} | ${escapeCell(row.expectation)} | ${row.status.toUpperCase()} | ${row.evidence.map((file) => path.relative(attempt, file)).join("<br>")} |`).join("\n");
  return `# Edge practical verification matrix\n\n${header}\n${body}\n`;
}

export function renderReport(input) {
  const commands = input.results.flatMap((result) => result.commands ?? []);
  const commandRows = commands.length === 0 ? "No commands completed." : commands.map((record) => `| \`${escapeCell(record.command.join(" "))}\` | ${record.exitCode} | ${path.relative(input.attempt, record.stdoutPath)} | ${path.relative(input.attempt, record.stderrPath)} |`).join("\n");
  const failures = input.results.filter((result) => result.status === "failed" || result.status === "blocked");
  return `# Fentaris Edge practical verification\n\n## Verdict\n\n**${input.verdict}**\n\n- Core: ${input.verdict}\n- Canaries: ${input.canaryStatus}\n- Platform: ${process.platform}/${process.arch}\n- Node: ${process.version}\n- Branch: ${input.identity.branch}\n- Source head: ${input.identity.sourceHead}\n- Tree: ${input.identity.tree}\n- Target dev: ${input.identity.targetDev}\n- Candidate identity: ${input.identityVerification?.verified ? "VERIFIED" : "UNVERIFIED"}\n- Identity repository: ${input.identityVerification?.repository ?? "unknown"}\n- Attempt: ${input.attempt}\n\n## Stages\n\n${input.results.map((result) => `- ${result.id}: **${result.status.toUpperCase()}**${result.reason ? ` — ${result.reason}` : ""}`).join("\n")}\n\n## Commands\n\n| Command | Exit | stdout | stderr |\n|---|---:|---|---|\n${commandRows}\n\n## Integrity and secrecy\n\n- Identity proof errors: ${input.identityVerification?.errors?.length ? input.identityVerification.errors.join("; ") : "none"}\n- Materialized/tracked files: ${input.identityVerification?.materializedFiles ?? "unknown"}/${input.identityVerification?.trackedFiles ?? "unknown"}\n- Changed candidate files: ${input.changedFiles.length ? input.changedFiles.join(", ") : "none"}\n- Redacted sentinel leaks: ${input.leaks.length ? input.leaks.map((leak) => path.relative(input.attempt, leak.file)).join(", ") : "none"}\n- Packed artifacts: ${input.artifacts.length ? input.artifacts.map((artifact) => `${path.basename(artifact.file)} (${artifact.digest})`).join(", ") : "none"}\n\n## Failures and blockers\n\n${failures.length ? failures.map((failure) => `- ${failure.id}: ${failure.reason}`).join("\n") : "- None."}\n\n## Scope and residual risk\n\n- Physical macOS reboot was not exercised.\n- Linux and Windows lifecycle behavior is represented only by repository adapter tests.\n- External registry and container coverage is reported separately as ${input.canaryStatus}.\n`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export { assertAbsoluteContained, allocateAttempt, initializeAttempt, runLogged, hashFile, scanAndRedactLogs } from "../verification/lib.mjs";
