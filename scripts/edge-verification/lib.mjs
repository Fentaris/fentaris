import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const IGNORED_TREE_NAMES = new Set([".git", "node_modules", "dist", ".turbo", ".cache"]);

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
  const { command, args = [], cwd, env = {}, logs, id, expectedExitCodes = [0], timeoutMs = 600_000 } = input;
  const stdoutPath = path.join(logs, `${id}.stdout.log`);
  const stderrPath = path.join(logs, `${id}.stderr.log`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
  await writeFile(stdoutPath, result.stdout, { mode: 0o600 });
  await writeFile(stderrPath, result.stderr, { mode: 0o600 });
  const record = { id, command: [command, ...args], cwd, exitCode: result.code, expectedExitCodes, stdoutPath, stderrPath };
  if (!expectedExitCodes.includes(result.code)) {
    const error = new Error(`${command} ${args.join(" ")} exited ${result.code}`);
    error.record = record;
    throw error;
  }
  return record;
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
  for (const result of results) for (const scenario of result.scenarios) byScenario.set(scenario, result);
  return requirementSources.flatMap((source) => source.requirements.map((requirement) => {
    const evidence = source.scenarios.flatMap((scenario) => byScenario.get(scenario)?.commands?.flatMap((record) => [record.stdoutPath, record.stderrPath]) ?? []);
    const states = source.scenarios.map((scenario) => byScenario.get(scenario)?.status ?? "not-run");
    return {
      requirement,
      source: source.source,
      scenarios: [...source.scenarios],
      mandatory: true,
      status: states.every((status) => status === "passed") && evidence.length > 0 ? "passed" : states.includes("failed") ? "failed" : "blocked",
      evidence,
    };
  }));
}

export function renderMatrix(rows, attempt) {
  const header = "| Requirement | Source | Scenarios | Status | Evidence |\n|---|---|---|---|---|";
  const body = rows.map((row) => `| ${escapeCell(row.requirement)} | ${escapeCell(row.source)} | ${row.scenarios.join(", ")} | ${row.status.toUpperCase()} | ${row.evidence.map((file) => path.relative(attempt, file)).join("<br>")} |`).join("\n");
  return `# Edge practical verification matrix\n\n${header}\n${body}\n`;
}

export function renderReport(input) {
  const commands = input.results.flatMap((result) => result.commands ?? []);
  const commandRows = commands.length === 0 ? "No commands completed." : commands.map((record) => `| \`${escapeCell(record.command.join(" "))}\` | ${record.exitCode} | ${path.relative(input.attempt, record.stdoutPath)} | ${path.relative(input.attempt, record.stderrPath)} |`).join("\n");
  const failures = input.results.filter((result) => result.status === "failed" || result.status === "blocked");
  return `# Fentaris Edge practical verification\n\n## Verdict\n\n**${input.verdict}**\n\n- Core: ${input.verdict}\n- Canaries: ${input.canaryStatus}\n- Platform: ${process.platform}/${process.arch}\n- Node: ${process.version}\n- Branch: ${input.identity.branch}\n- Source head: ${input.identity.sourceHead}\n- Tree: ${input.identity.tree}\n- Target dev: ${input.identity.targetDev}\n- Attempt: ${input.attempt}\n\n## Stages\n\n${input.results.map((result) => `- ${result.id}: **${result.status.toUpperCase()}**${result.reason ? ` — ${result.reason}` : ""}`).join("\n")}\n\n## Commands\n\n| Command | Exit | stdout | stderr |\n|---|---:|---|---|\n${commandRows}\n\n## Integrity and secrecy\n\n- Changed candidate files: ${input.changedFiles.length ? input.changedFiles.join(", ") : "none"}\n- Redacted sentinel leaks: ${input.leaks.length ? input.leaks.map((leak) => path.relative(input.attempt, leak.file)).join(", ") : "none"}\n- Packed artifacts: ${input.artifacts.length ? input.artifacts.map((artifact) => `${path.basename(artifact.file)} (${artifact.digest})`).join(", ") : "none"}\n\n## Failures and blockers\n\n${failures.length ? failures.map((failure) => `- ${failure.id}: ${failure.reason}`).join("\n") : "- None."}\n\n## Scope and residual risk\n\n- Physical macOS reboot was not exercised.\n- Linux and Windows lifecycle behavior is represented only by repository adapter tests.\n- External registry and container coverage is reported separately as ${input.canaryStatus}.\n`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
