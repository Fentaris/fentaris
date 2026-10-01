import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

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


export async function initializeAttempt(attempt, markerName = ".edge-verification.json") {
  if (!path.isAbsolute(attempt)) throw new Error("--attempt must be an absolute path.");
  await mkdir(attempt, { recursive: true, mode: 0o700 });
  const marker = path.join(attempt, markerName);
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


export async function hashFile(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
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


export async function scanArtifacts(root, sentinels) {
  const leaks = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "cache") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      let contents = await readFile(file);
      const archive = entry.name.endsWith(".tgz");
      if (archive) contents = gunzipSync(contents);
      for (const sentinel of new Set(sentinels.filter(Boolean))) {
        if (!contents.includes(Buffer.from(sentinel))) continue;
        leaks.push({ file });
        contents = Buffer.from(contents.toString("utf8").replaceAll(sentinel, "[REDACTED]"));
      }
      if (!archive && leaks.some((leak) => leak.file === file)) await writeFile(file, contents, { mode: 0o600 });
    }
  };
  await walk(root);
  return leaks;
}

export async function packCandidateArtifacts(input, prefix = "00-package-smoke") {
  const commands = [];
  const artifacts = [];
  for (const directory of ["core", "edge", "cli"]) {
    const packageRoot = path.join(input.candidateRoot, "packages", directory);
    const beforeFiles = new Set(await readdir(input.layout.artifacts));
    commands.push(await runLogged({ command: "pnpm", args: ["pack", "--pack-destination", input.layout.artifacts, "--json"], cwd: packageRoot, env: input.environment, logs: input.layout.logs, id: `${prefix}-pack-${directory}` }));
    const created = (await readdir(input.layout.artifacts)).filter((file) => file.endsWith(".tgz") && !beforeFiles.has(file));
    if (created.length !== 1) throw new Error(`Expected one ${directory} tarball, found ${created.length}.`);
    const file = path.join(input.layout.artifacts, created[0]);
    artifacts.push({ package: directory, file, digest: await hashFile(file) });
  }
  await writeFile(path.join(input.layout.artifacts, "SHA256.json"), `${JSON.stringify(artifacts, null, 2)}\n`, { mode: 0o600 });
  return { commands, artifacts };
}
