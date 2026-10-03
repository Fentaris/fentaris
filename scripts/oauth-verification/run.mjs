#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MCPJAM_CLI_VERSION, MCPJAM_SDK_VERSION, SCENARIOS } from "./catalog.mjs";
import { REQUIREMENTS } from "./requirements.mjs";
import { materializeFixtures } from "./fixtures.mjs";
import { allocateAttempt, initializeAttempt, runLogged, packCandidateArtifacts, scanArtifacts, requirementMatrix, verdict, renderReport } from "./lib.mjs";
import { verifyCandidateIdentity, snapshotTree, compareSnapshots } from "../edge-verification/lib.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execAsync = promisify(execFile);
export function parseArgs(args) {
  const options = { scenario: "all" };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!["--candidate", "--attempt", "--parent", "--scenario", "--branch", "--source-head", "--tree", "--target-dev"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid option ${name}`);
    options[name.slice(2)] = args[++index];
  }
  if (options.scenario !== "all" && !SCENARIOS.some((scenario) => scenario.id === options.scenario)) throw new Error(`Unknown scenario ${options.scenario}`);
  for (const key of ["candidate", "attempt", "parent"]) if (options[key] && !path.isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
  return options;
}
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

export async function run(options) {
  const candidateRoot = options.candidate ?? repositoryRoot;
  const attempt = options.attempt ?? await allocateAttempt(options.parent ?? path.resolve(repositoryRoot, "../installation_tests"));
  const layout = await initializeAttempt(attempt, ".oauth-verification.json");
  const results = [], artifacts = [], sentinels = [], integrityErrors = [];
  const identity = { branch: options.branch ?? "codex/oauth-2-1-inbound-resource-server", sourceHead: options["source-head"], tree: options.tree, targetDev: options["target-dev"] };
  const selected = options.scenario === "all" ? SCENARIOS : SCENARIOS.filter((scenario) => scenario.id === options.scenario);
  let before;
  try {
    const git = async (args) => (await execAsync("git", ["-C", candidateRoot, ...args])).stdout.trim();
    identity.sourceHead ??= await git(["rev-parse", identity.branch]);
    identity.tree ??= await git(["rev-parse", `${identity.sourceHead}^{tree}`]);
    identity.targetDev ??= await git(["rev-parse", "refs/remotes/origin/dev"]);
    const verification = await verifyCandidateIdentity({ candidateRoot, identityRepository: candidateRoot, ignoreGenerated: true, ...identity });
    await writeJson(path.join(attempt, "identity.json"), { ...identity, verification });
    if (!verification.verified) throw Object.assign(new Error("Candidate identity could not be proven"), { blocked: true });
    before = await snapshotTree(candidateRoot, { ignoreLocalFiles: true });
    const project = path.join(layout.projects, "consumer"); await mkdir(project);
    const env = { CI: "true", FENTARIS_AUTH_KEY: `oauth-verification-store-${randomUUID()}`, OAUTH_API_KEY: `oauth-verification-key-${randomUUID()}`, OAUTH_CLIENT_SECRET: `oauth-verification-client-${randomUUID()}`, npm_config_cache: path.join(layout.cache, "npm"), TMPDIR: layout.tmp };
    sentinels.push(env.FENTARIS_AUTH_KEY, env.OAUTH_API_KEY, env.OAUTH_CLIENT_SECRET);
    const setup = { id: "00-candidate", status: "BLOCKED", commands: [] }; results.push(setup);
    setup.commands.push(await runLogged({ command: "pnpm", args: ["build"], cwd: candidateRoot, env, logs: layout.logs, id: "00-oauth-candidate-build" }));
    const packed = await packCandidateArtifacts({ candidateRoot, layout, environment: env }, "00-oauth"); artifacts.push(...packed.artifacts); setup.commands.push(...packed.commands);
    const dependencies = Object.fromEntries(artifacts.map((artifact) => [`@fentaris/${artifact.package}`, `file:${artifact.file}`]));
    await writeJson(path.join(project, "package.json"), { name: "fentaris-oauth-candidate", private: true, type: "module", dependencies: { ...dependencies, "@mcpjam/cli": MCPJAM_CLI_VERSION, "@mcpjam/sdk": MCPJAM_SDK_VERSION, "@modelcontextprotocol/sdk": "1.30.1", zod: "4.6.5" }, overrides: { ...dependencies, "@mcpjam/sdk": MCPJAM_SDK_VERSION } });
    setup.commands.push(await runLogged({ command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: project, env, logs: layout.logs, id: "00-oauth-consumer-install" }));
    for (const artifact of artifacts) {
      const packedManifest = JSON.parse(await readFile(path.join(candidateRoot, "packages", artifact.package, "package.json"), "utf8"));
      const installed = JSON.parse(await readFile(path.join(project, "node_modules/@fentaris", artifact.package, "package.json"), "utf8"));
      if (packedManifest.version !== installed.version) throw new Error(`Packed ${artifact.package} version mismatch`);
    }
    const fixtures = await materializeFixtures(candidateRoot, project);
    await writeJson(path.join(layout.artifacts, "fixtures.json"), fixtures);
    await copyFile(path.join(candidateRoot, "scripts/verification/lib.mjs"), path.join(project, "verification-lib.mjs"));
    await copyFile(path.join(candidateRoot, "scripts/oauth-verification/scenario.mjs"), path.join(project, "scenario.mjs"));
    setup.status = "PASS";
    for (const scenario of selected) {
      const result = { ...scenario, status: "PASS", commands: [] }; results.push(result);
      try {
        result.commands.push(await runLogged({ command: process.execPath, args: ["scenario.mjs", scenario.id, project, layout.logs], cwd: project, env, logs: layout.logs, id: scenario.id, timeoutMs: 180_000 }));
      } catch (error) {
        result.status = "FAIL"; result.reason = error.message;
        if (error.record) result.commands.push(error.record);
      } finally {
        const secretsFile = path.join(project, `${scenario.id}.secrets.json`);
        try { sentinels.push(...JSON.parse(await readFile(secretsFile, "utf8"))); } catch { result.status = "FAIL"; result.reason = "Scenario did not complete secret inventory"; }
        await rm(secretsFile, { force: true });
        try { result.commands.push(...JSON.parse(await readFile(path.join(project, `${scenario.id}.commands.json`), "utf8"))); } catch { /* worker failure remains FAIL */ }
      }
    }
  } catch (error) {
    results.push({ id: "campaign", status: error.blocked ? "BLOCKED" : "FAIL", reason: error.message, commands: error.record ? [error.record] : [] });
  } finally {
    for (const scenario of SCENARIOS) if (!results.some((result) => result.id === scenario.id)) results.push({ ...scenario, status: "BLOCKED", reason: "Scenario did not run", commands: [] });
    if (before) integrityErrors.push(...compareSnapshots(before, await snapshotTree(candidateRoot, { ignoreLocalFiles: true })));
    await writeJson(path.join(layout.artifacts, "results.json"), results);
    const leaks = await scanArtifacts(attempt, sentinels);
    // Reload after redaction: report must not reintroduce a secret from memory.
    const safeResults = JSON.parse(await readFile(path.join(layout.artifacts, "results.json"), "utf8"));
    const matrix = requirementMatrix(REQUIREMENTS, safeResults);
    const outcome = verdict(safeResults, matrix, leaks, integrityErrors);
    await writeFile(path.join(attempt, "REPORT.md"), renderReport({ attempt, identity, artifacts, results: safeResults, matrix, verdict: outcome, leaks, mcpjamVersion: MCPJAM_CLI_VERSION, integrityErrors }), { mode: 0o600 });
    console.log(`${outcome}: ${path.join(attempt, "REPORT.md")}`);
    return outcome === "PASS" ? 0 : 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run(parseArgs(process.argv.slice(2)));
