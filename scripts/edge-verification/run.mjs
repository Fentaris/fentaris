#!/usr/bin/env node
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PHASES, REQUIREMENT_SOURCES, SENTINELS } from "./catalog.mjs";
import {
  allocateAttempt,
  buildRequirementMatrix,
  compareSnapshots,
  coreVerdict,
  hashFile,
  initializeAttempt,
  renderMatrix,
  renderReport,
  runLogged,
  scanAndRedactLogs,
  snapshotTree,
  verifyCandidateIdentity,
} from "./lib.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseArgs(process.argv.slice(2));
const selected = options.phase === "all" ? PHASES : PHASES.filter((phase) => phase.id === options.phase);
if (selected.length === 0) throw new Error(`Unknown phase: ${options.phase}`);
const attempt = options.attempt ?? await allocateAttempt(path.resolve(repositoryRoot, "../installation_tests"));
const layout = await initializeAttempt(attempt);
const candidateRoot = path.resolve(options.candidate ?? repositoryRoot);
const identityRepository = path.resolve(options.identityRepo ?? candidateRoot);

const identity = await resolveIdentity(identityRepository, options);
const identityVerification = await verifyCandidateIdentity({ candidateRoot, identityRepository, ...identity });
const before = await snapshotTree(candidateRoot);
await writeJson(path.join(layout.logs, "candidate-tree-before.json"), before);
await writeJson(path.join(attempt, "identity.json"), { ...identity, verification: identityVerification });

const environment = {
  CI: "true",
  FENTARIS_AUTH_KEY: SENTINELS[0],
  FENTARIS_EDGE_TEST_TOKEN: SENTINELS[1],
  FENTARIS_EDGE_PRIVATE_PATH_SENTINEL: SENTINELS[2],
  npm_config_cache: path.join(layout.cache, "npm"),
  PNPM_HOME: path.join(layout.cache, "pnpm-home"),
  TMPDIR: layout.tmp,
};
const results = [];
const artifacts = [];
let canaryStatus = options.canary ? "BLOCKED" : "NOT_REQUESTED";

if (!identityVerification.verified) {
  for (const phase of selected) {
    results.push({
      id: phase.id,
      title: phase.title,
      scenarios: [...phase.scenarios],
      status: "blocked",
      reason: `Candidate identity could not be proven: ${identityVerification.errors.join("; ")}`,
      commands: [],
    });
  }
} else for (const phase of selected) {
  const project = path.join(layout.projects, phase.id);
  await mkdir(project, { recursive: true, mode: 0o700 });
  await writeJson(path.join(project, "scenario.json"), { phase: phase.id, title: phase.title, scenarios: phase.scenarios });
  const result = { id: phase.id, title: phase.title, scenarios: [...phase.scenarios], status: "passed", commands: [] };
  try {
    if (phase.id === "00-package-smoke") {
      const packageResult = await packageSmoke({ candidateRoot, project, layout, environment });
      result.commands.push(...packageResult.commands);
      artifacts.push(...packageResult.artifacts);
    } else {
      if (artifacts.length === 0) {
        const focused = await prepareFocusedArtifacts({ candidateRoot, layout, environment });
        result.commands.push(...focused.commands);
        artifacts.push(...focused.artifacts);
      }
      for (let index = 0; index < phase.commands.length; index += 1) {
        const command = phase.commands[index];
        result.commands.push(await runLogged({ command: command.command, args: command.args, cwd: candidateRoot, env: environment, logs: layout.logs, id: `${phase.id}-${command.id}` }));
      }
      result.commands.push(...await runPracticalScenario({ phase, candidateRoot, project, layout, environment, artifacts }));
    }
    if (phase.id === "05-managed-installation" && options.canary) {
      canaryStatus = await runCanaries({ project, layout, environment, result });
    }
    if (phase.id === "06-resilience-and-launchd") {
      if (!options.nativeService) {
        result.status = "blocked";
        result.reason = "Native launchd was not enabled; rerun with --native-service on macOS.";
      } else if (process.platform !== "darwin") {
        result.status = "blocked";
        result.reason = "Native launchd requires macOS.";
      } else {
        result.commands.push(await runLogged({ command: "pnpm", args: ["--filter", "@fentaris/edge", "build"], cwd: candidateRoot, env: environment, logs: layout.logs, id: `${phase.id}-edge-build` }));
        const entry = path.join(candidateRoot, "packages/edge/dist/index.js");
        result.commands.push(await runLogged({
          command: process.execPath,
          args: [path.join(repositoryRoot, "scripts/edge-verification/native-launchd.mjs"), entry, project, path.basename(attempt)],
          cwd: project,
          env: environment,
          logs: layout.logs,
          id: `${phase.id}-native-launchd`,
        }));
      }
    }
    await assertOwnerOnly(project);
  } catch (error) {
    if (error.record) result.commands.push(error.record);
    result.status = "failed";
    result.reason = error instanceof Error ? error.message : String(error);
  }
  results.push(result);
}

const after = await snapshotTree(candidateRoot);
await writeJson(path.join(layout.logs, "candidate-tree-after.json"), after);
const changedFiles = compareSnapshots(before, after);
const leaks = await scanAndRedactLogs(layout.logs, SENTINELS);
const matrix = buildRequirementMatrix(REQUIREMENT_SOURCES, results);
const selectedAll = selected.length === PHASES.length;
const verdict = coreVerdict({
  selectedAll,
  results,
  matrix,
  leaks,
  changedFiles,
  nativeRequired: process.platform === "darwin" && !options.nativeService,
  identityUnverified: !identityVerification.verified,
});
await writeJson(path.join(attempt, "matrix.json"), matrix);
await writeFile(path.join(attempt, "MATRIX.md"), renderMatrix(matrix, attempt), { mode: 0o600 });
await writeFile(path.join(attempt, "REPORT.md"), renderReport({ verdict, canaryStatus, identity, identityVerification, attempt, results, matrix, leaks, changedFiles, artifacts }), { mode: 0o600 });
await writeJson(path.join(attempt, "result.json"), { verdict, canaryStatus, identity, identityVerification, results, matrix, leaks: leaks.map(({ file }) => file), changedFiles, artifacts });
console.log(JSON.stringify({ verdict, canaryStatus, attempt, report: path.join(attempt, "REPORT.md") }, null, 2));
process.exitCode = verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2;

async function packageSmoke(input) {
  const commands = [];
  const command = async (id, executable, args, expectedExitCodes) => {
    const record = await runLogged({ command: executable, args, cwd: input.candidateRoot, env: input.environment, logs: input.layout.logs, id: `00-package-smoke-${id}`, ...(expectedExitCodes ? { expectedExitCodes } : {}) });
    commands.push(record);
    return record;
  };
  await command("node", process.execPath, ["--version"]);
  await command("pnpm", "pnpm", ["--version"]);
  await command("install", "pnpm", ["install", "--frozen-lockfile"]);
  await command("verify", "pnpm", ["verify"]);
  await command("verify-release", "pnpm", ["verify:release"]);
  const packedResult = await packCandidateArtifacts(input);
  commands.push(...packedResult.commands);
  const packed = packedResult.artifacts;
  await writeJson(path.join(input.layout.artifacts, "SHA256.json"), packed);
  const manifest = {
    name: "fentaris-edge-practical-consumer",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(packed.map((artifact) => [`@fentaris/${artifact.package}`, `file:${artifact.file}`])),
  };
  await writeJson(path.join(input.project, "package.json"), manifest);
  await writeFile(path.join(input.project, "smoke.mjs"), `import { edge } from "@fentaris/core";\nimport { redactEdgeValue } from "@fentaris/edge";\nimport { main } from "@fentaris/cli";\nif (typeof edge !== "function" || typeof redactEdgeValue !== "function" || typeof main !== "function") process.exit(1);\n`, { mode: 0o600 });
  await writeFile(path.join(input.project, "smoke.ts"), `import { edge } from "@fentaris/core";\nimport { redactEdgeValue } from "@fentaris/edge";\nimport { main } from "@fentaris/cli";\nvoid [edge, redactEdgeValue, main];\n`, { mode: 0o600 });
  await writeJson(path.join(input.project, "tsconfig.json"), { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true }, include: ["smoke.ts"] });
  commands.push(await runLogged({ command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: input.project, env: input.environment, logs: input.layout.logs, id: "00-package-smoke-consumer-install" }));
  for (const directory of ["core", "edge", "cli"]) {
    const installed = JSON.parse(await readFile(path.join(input.project, "node_modules", "@fentaris", directory, "package.json"), "utf8"));
    for (const version of Object.values({ ...installed.dependencies, ...installed.optionalDependencies, ...installed.peerDependencies })) {
      if (/^(workspace:|file:|link:|portal:)/.test(String(version))) throw new Error(`Packed @fentaris/${directory} leaks dependency ${version}.`);
    }
  }
  commands.push(await runLogged({ command: process.execPath, args: ["smoke.mjs"], cwd: input.project, env: input.environment, logs: input.layout.logs, id: "00-package-smoke-runtime" }));
  commands.push(await runLogged({ command: path.join(input.candidateRoot, "node_modules/.bin/tsc"), args: ["-p", "tsconfig.json"], cwd: input.project, env: input.environment, logs: input.layout.logs, id: "00-package-smoke-types" }));
  commands.push(await runLogged({ command: path.join(input.project, "node_modules/.bin/fentaris"), args: ["--version"], cwd: input.project, env: input.environment, logs: input.layout.logs, id: "00-package-smoke-cli-bin" }));
  commands.push(await runLogged({ command: path.join(input.project, "node_modules/.bin/fentaris-edge"), args: ["not-a-command"], cwd: input.project, env: input.environment, logs: input.layout.logs, id: "00-package-smoke-edge-bin", expectedExitCodes: [2] }));
  return { commands, artifacts: packed };
}

async function prepareFocusedArtifacts(input) {
  const commands = [];
  commands.push(await runLogged({ command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: input.candidateRoot, env: input.environment, logs: input.layout.logs, id: "focused-candidate-install" }));
  commands.push(await runLogged({ command: "pnpm", args: ["build"], cwd: input.candidateRoot, env: input.environment, logs: input.layout.logs, id: "focused-candidate-build" }));
  const packed = await packCandidateArtifacts(input, "focused");
  commands.push(...packed.commands);
  return { commands, artifacts: packed.artifacts };
}

async function packCandidateArtifacts(input, prefix = "00-package-smoke") {
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
  await writeJson(path.join(input.layout.artifacts, "SHA256.json"), artifacts);
  return { commands, artifacts };
}

async function runPracticalScenario(input) {
  const manifest = {
    name: `fentaris-edge-${input.phase.id}-consumer`,
    private: true,
    type: "module",
    dependencies: Object.fromEntries(input.artifacts.map((artifact) => [`@fentaris/${artifact.package}`, `file:${artifact.file}`])),
  };
  await writeJson(path.join(input.project, "package.json"), manifest);
  await copyFile(path.join(input.candidateRoot, "scripts/edge-verification/practical.mjs"), path.join(input.project, "practical.mjs"));
  await copyFile(path.join(input.candidateRoot, "scripts/edge-verification/fixture-mcp.mjs"), path.join(input.project, "fixture-mcp.mjs"));
  const commands = [];
  commands.push(await runLogged({
    command: "npm",
    args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: input.project,
    env: input.environment,
    logs: input.layout.logs,
    id: `${input.phase.id}-consumer-install`,
  }));
  commands.push(await runLogged({
    command: process.execPath,
    args: ["practical.mjs", input.phase.id],
    cwd: input.project,
    env: { ...input.environment, FENTARIS_EDGE_STATE_DIR: path.join(input.project, "edge-state") },
    logs: input.layout.logs,
    id: `${input.phase.id}-practical`,
  }));
  return commands;
}

async function runCanaries({ project, layout, environment, result }) {
  const canaryDir = path.join(project, "canaries");
  await mkdir(canaryDir, { recursive: true, mode: 0o700 });
  const commands = [
    ["npm", ["view", "is-number@7.0.0", "dist.integrity"]],
    ["python3", ["-m", "pip", "download", "--no-deps", "--dest", canaryDir, "idna==3.10"]],
  ];
  let passed = 0;
  for (let index = 0; index < commands.length; index += 1) {
    try {
      const [command, args] = commands[index];
      result.commands.push(await runLogged({ command, args, cwd: project, env: environment, logs: layout.logs, id: `05-managed-installation-canary-${index + 1}` }));
      passed += 1;
    } catch (error) {
      if (error.record) result.commands.push(error.record);
    }
  }
  const container = await available("docker") ? "docker" : await available("podman") ? "podman" : undefined;
  if (container) {
    try {
      result.commands.push(await runLogged({ command: container, args: ["version"], cwd: project, env: environment, logs: layout.logs, id: "05-managed-installation-canary-container" }));
      passed += 1;
    } catch (error) {
      if (error.record) result.commands.push(error.record);
    }
  }
  return passed === 3 ? "COMPLETE" : passed > 0 ? "PARTIAL" : "BLOCKED";
}

async function resolveIdentity(root, input) {
  const fallback = async (args) => {
    try { return (await execFileAsync("git", ["-C", root, ...args])).stdout.trim(); } catch { return "unknown"; }
  };
  return {
    branch: input.branch ?? await fallback(["branch", "--show-current"]),
    sourceHead: input.sourceHead ?? await fallback(["rev-parse", "HEAD"]),
    tree: input.tree ?? await fallback(["rev-parse", "HEAD^{tree}"]),
    targetDev: input.targetDev ?? await fallback(["rev-parse", "refs/remotes/origin/dev"]),
  };
}

async function assertOwnerOnly(directory) {
  if (process.platform === "win32") return;
  const mode = (await stat(directory)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`Project directory is not owner-only: ${directory} (${mode.toString(8)})`);
}

async function available(command) {
  try { await execFileAsync(command, ["--version"]); return true; } catch { return false; }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function parseArgs(args) {
  const result = { phase: "all", nativeService: false, canary: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") continue;
    if (token === "--native-service") result.nativeService = true;
    else if (token === "--canary") result.canary = true;
    else if (["--attempt", "--candidate", "--identity-repo", "--phase", "--branch", "--source-head", "--tree", "--target-dev"].includes(token)) {
      const value = args[index += 1];
      if (!value) throw new Error(`${token} requires a value.`);
      const key = token.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = value;
    } else if (token === "--help") {
      console.log("Usage: pnpm verify:edge:practical -- --attempt <absolute-path> [--candidate <path>] [--identity-repo <git-path>] [--phase <id|all>] [--native-service] [--canary] [--branch <name> --source-head <sha> --tree <sha> --target-dev <sha>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${token}`);
  }
  if (result.attempt && !path.isAbsolute(result.attempt)) throw new Error("--attempt must be absolute.");
  if (result.identityRepo && !path.isAbsolute(result.identityRepo)) throw new Error("--identity-repo must be absolute.");
  return result;
}
