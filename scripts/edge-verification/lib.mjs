import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const IGNORED_TREE_NAMES = new Set([".git", "node_modules", "dist", ".turbo", ".cache"]);
const execFileAsync = promisify(execFile);

export function assertAbsoluteContained(parent, child) {
  if (!path.isAbsolute(parent) || !path.isAbsolute(child)) throw new Error("Attempt and parent paths must be absolute.");
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path ${child} is not a child of ${parent}.`);
  return path.resolve(child);
}

export async function allocateAttempt(parent) {
  if (!path.isAbsolute(parent)) throw new Error("Installation-test parent must be absolute.");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (let index = 0; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const attempt = path.join(parent, `install${index}`);
    try {
      await mkdir(attempt, { mode: 0o700 });
      return attempt;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("No installation-test attempt number is available.");
}

export async function initializeAttempt(attempt) {
  if (!path.isAbsolute(attempt)) throw new Error("--attempt must be an absolute path.");
  await mkdir(attempt, { recursive: true, mode: 0o700 });
  const marker = path.join(attempt, ".edge-verification.json");
  let handle;
  try {
    handle = await open(marker, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ version: 1, createdAt: new Date().toISOString() }, null, 2)}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Attempt already used: ${attempt}`);
    throw error;
  } finally {
    await handle?.close();
  }
  const directories = Object.fromEntries(await Promise.all(["artifacts", "logs", "projects", "cache", "tmp"].map(async (name) => {
    const directory = path.join(attempt, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return [name, directory];
  })));
  return { attempt, marker, ...directories };
}

export async function runLogged(input) {
  const { command, args = [], cwd, env = {}, logs, id, expectedExitCodes = [0], timeoutMs = 600_000, killAfterMs = 2_000 } = input;
  const stdoutPath = path.join(logs, `${id}.stdout.log`);
  const stderrPath = path.join(logs, `${id}.stderr.log`);
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let terminationSignal;
    let killTimer;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ ...value, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut, terminationSignal });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminationSignal = "SIGTERM";
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminationSignal = "SIGKILL";
        terminateProcessTree(child, "SIGKILL");
      }, killAfterMs);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish({ code: 1, spawnError: error }));
    child.on("close", (code, signal) => finish({ code: code ?? 1, signal }));
  });
  await writeFile(stdoutPath, result.stdout, { mode: 0o600 });
  await writeFile(stderrPath, result.stderr, { mode: 0o600 });
  const record = {
    id,
    command: [command, ...args],
    cwd,
    exitCode: result.code,
    expectedExitCodes,
    stdoutPath,
    stderrPath,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timedOut: true, terminationSignal: result.terminationSignal } : {}),
  };
  if (result.timedOut || result.spawnError || !expectedExitCodes.includes(result.code)) {
    const message = result.timedOut
      ? `${command} timed out after ${timeoutMs}ms and exited after ${result.terminationSignal}`
      : result.spawnError
        ? `${command} could not start: ${result.spawnError.message}`
        : `${command} ${args.join(" ")} exited ${result.code}`;
    const error = new Error(message);
    error.record = record;
    throw error;
  }
  return record;
}

function terminateProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function verifyCandidateIdentity({ candidateRoot, identityRepository, branch, sourceHead, tree, targetDev }) {
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
    const materialized = await compareCandidateToCommit(candidate, repository, sourceHead);
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

async function compareCandidateToCommit(candidateRoot, repository, sourceHead) {
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
  const materialized = await materializedTree(candidateRoot);
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

async function materializedTree(root) {
  const rows = new Map();
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git") continue;
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

export async function hashFile(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

export async function snapshotTree(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED_TREE_NAMES.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
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

export async function scanAndRedactLogs(logs, sentinels) {
  const leaks = [];
  for (const entry of await readdir(logs, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const file = path.join(logs, entry.name);
    let contents = await readFile(file, "utf8");
    for (const sentinel of sentinels) {
      if (!contents.includes(sentinel)) continue;
      leaks.push({ file, value: sentinel });
      contents = contents.replaceAll(sentinel, "[REDACTED]");
    }
    if (leaks.some((leak) => leak.file === file)) await writeFile(file, contents, { mode: 0o600 });
  }
  return leaks;
}

export function coreVerdict({ selectedAll, results, matrix, leaks, changedFiles, nativeRequired }) {
  if (results.some((result) => result.status === "failed") || leaks.length > 0 || changedFiles.length > 0) return "FAIL";
  if (!selectedAll || nativeRequired || matrix.some((row) => row.mandatory && row.status !== "passed")) return "BLOCKED";
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
