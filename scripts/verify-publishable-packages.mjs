import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDefinitions = [
  { name: "@fentaris/core", directory: "core", required: ["dist/index.js", "dist/index.d.ts", "dist/extensions.js", "dist/extensions.d.ts", "dist/experimental/plugins.js", "dist/experimental/plugins.d.ts"] },
  { name: "@fentaris/edge", directory: "edge", bin: "dist/index.js", required: ["dist/index.js", "dist/index.d.ts"] },
  { name: "@fentaris/approval-telegram", directory: "approval-telegram", required: ["dist/index.js", "dist/index.d.ts"] },
  { name: "@fentaris/cli", directory: "cli", bin: "dist/index.js", required: ["dist/index.js", "dist/index.d.ts"] },
];
const sentinelSecrets = [
  "release-check-auth-key-DO-NOT-LOG",
  "release-check-telegram-token-DO-NOT-LOG",
  "release-check-npm-token-DO-NOT-LOG",
];
const workRoot = await mkdtemp(path.join(tmpdir(), "fentaris-release-check-"));
const artifactsDirectory = path.join(workRoot, "artifacts");
const extractedDirectory = path.join(workRoot, "extracted");
const npmCache = path.join(workRoot, "npm-cache");
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const packageState = new Map();

try {
  await mkdir(artifactsDirectory, { recursive: true });
  await mkdir(extractedDirectory, { recursive: true });
  await mkdir(npmCache, { recursive: true });

  console.log("[release-check] Packing and inspecting publishable artifacts");
  for (const definition of packageDefinitions) {
    const sourceDirectory = path.join(root, "packages", definition.directory);
    const sourceManifest = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
    await run("pnpm", ["pack", "--pack-destination", artifactsDirectory, "--json"], { cwd: sourceDirectory });
    const tarball = await findTarball(sourceManifest.name, sourceManifest.version);
    const extractionRoot = path.join(extractedDirectory, definition.directory);
    await mkdir(extractionRoot, { recursive: true });
    await run("tar", ["-xzf", tarball, "-C", extractionRoot]);
    const packageRoot = path.join(extractionRoot, "package");
    const packedManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    await validatePackedPackage(definition, sourceManifest, packedManifest, packageRoot);
    const previousVersion = await previousVersionFromChangelog(definition, sourceManifest.version);
    packageState.set(definition.name, { definition, sourceManifest, packedManifest, tarball, previousVersion });
    console.log(`[release-check] ${definition.name}@${sourceManifest.version} artifact is complete`);
  }

  validateInternalDependencyVersions();

  console.log("[release-check] Installing candidate tarballs in an empty project");
  const cleanProject = await createProject("clean-install");
  await installTarballs(cleanProject);
  await writeSmokeFiles(cleanProject);
  await verifyInstalledSet(cleanProject, "candidate");
  await verifyRuntimeAndTypes(cleanProject);
  await verifyBins(cleanProject);

  console.log("[release-check] Generating, checking, and building a real CLI project");
  await verifyGeneratedProject(cleanProject);

  console.log("[release-check] Exercising published upgrade, reinstall, downgrade, and re-upgrade");
  const upgradeProject = await createProject("upgrade-path");
  await installPreviousVersions(upgradeProject);
  await verifyInstalledSet(upgradeProject, "previous");
  await writeSmokeFiles(upgradeProject);
  await verifyRuntimeAndTypes(upgradeProject);
  await verifyBins(upgradeProject);

  await installTarballs(upgradeProject);
  await verifyInstalledSet(upgradeProject, "candidate");
  await verifyRuntimeAndTypes(upgradeProject);
  await verifyBins(upgradeProject);

  const edge = packageState.get("@fentaris/edge");
  await run("npm", ["install", "--force", "--ignore-scripts", "--no-audit", "--no-fund", edge.tarball], { cwd: upgradeProject });
  await verifyInstalledSet(upgradeProject, "candidate");
  await verifyBins(upgradeProject);

  await installPreviousVersions(upgradeProject);
  await verifyInstalledSet(upgradeProject, "previous");
  await verifyRuntimeAndTypes(upgradeProject);
  await verifyBins(upgradeProject);

  await installTarballs(upgradeProject);
  await verifyInstalledSet(upgradeProject, "candidate");
  await verifyRuntimeAndTypes(upgradeProject);
  await verifyBins(upgradeProject);

  console.log("[release-check] PASS: tarballs, manifests, clean install, generated project, upgrade, downgrade, reinstall, and secret-log checks are green");
} finally {
  if (workRoot.startsWith(path.join(tmpdir(), "fentaris-release-check-"))) {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function validatePackedPackage(definition, sourceManifest, packedManifest, packageRoot) {
  assert(packedManifest.name === sourceManifest.name, `${definition.name}: packed name changed`);
  assert(packedManifest.version === sourceManifest.version, `${definition.name}: packed version changed`);
  assert(!("prepare" in (packedManifest.scripts ?? {})), `${definition.name}: prepare script leaked into published manifest`);

  for (const relativePath of [...definition.required, "README.md", "LICENSE.txt"]) {
    await access(path.join(packageRoot, relativePath), constants.R_OK).catch(() => {
      throw new Error(`${definition.name}: missing ${relativePath} from tarball`);
    });
  }

  const files = await listFiles(packageRoot);
  assert(!files.some((file) => file.startsWith("src/") || file.includes("/test") || file.startsWith("node_modules/")), `${definition.name}: source, tests, or node_modules leaked into tarball`);

  for (const [dependency, version] of Object.entries({ ...packedManifest.dependencies, ...packedManifest.optionalDependencies, ...packedManifest.peerDependencies })) {
    assert(!/^(workspace:|file:|link:|portal:)/.test(String(version)), `${definition.name}: unpublished dependency reference ${dependency}@${version}`);
  }

  if (definition.bin) {
    const binPath = path.join(packageRoot, definition.bin);
    const binContents = await readFile(binPath, "utf8");
    assert(binContents.startsWith("#!/usr/bin/env node"), `${definition.name}: bin is missing its node shebang`);
    if (process.platform !== "win32") {
      const mode = (await stat(binPath)).mode;
      assert((mode & 0o111) !== 0, `${definition.name}: bin is not executable`);
    }
  }

  const changelog = await readFile(path.join(root, "packages", definition.directory, "CHANGELOG.md"), "utf8");
  assert(changelog.includes(`## ${sourceManifest.version}`), `${definition.name}: changelog has no ${sourceManifest.version} entry`);
}

function validateInternalDependencyVersions() {
  for (const { packedManifest } of packageState.values()) {
    for (const [dependency, version] of Object.entries(packedManifest.dependencies ?? {})) {
      const internal = packageState.get(dependency);
      if (internal) {
        assert(version === internal.sourceManifest.version, `${packedManifest.name}: expected ${dependency}@${internal.sourceManifest.version}, found ${version}`);
      }
    }
  }
}

async function previousVersionFromChangelog(definition, currentVersion) {
  const changelog = await readFile(path.join(root, "packages", definition.directory, "CHANGELOG.md"), "utf8");
  const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+(?:-[^\s]+)?)$/gm)].map((match) => match[1]);
  const previous = versions.find((version) => version !== currentVersion);
  assert(previous, `${definition.name}: no previous published version is recorded in the changelog`);
  return previous;
}

async function createProject(name) {
  const directory = path.join(workRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ name: `fentaris-${name}`, private: true, type: "module" }, null, 2)}\n`);
  return directory;
}

async function installTarballs(project) {
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packageDefinitions.map(({ name }) => packageState.get(name).tarball)], { cwd: project });
}

async function installPreviousVersions(project) {
  await run("npm", ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", ...packageDefinitions.map(({ name }) => `${name}@${packageState.get(name).previousVersion}`)], { cwd: project });
}

async function verifyInstalledSet(project, kind) {
  for (const { name } of packageDefinitions) {
    const state = packageState.get(name);
    const expected = kind === "candidate" ? state.sourceManifest.version : state.previousVersion;
    const installed = JSON.parse(await readFile(path.join(project, "node_modules", ...name.split("/"), "package.json"), "utf8"));
    assert(installed.version === expected, `${name}: expected installed ${kind} version ${expected}, found ${installed.version}`);
  }
}

async function writeSmokeFiles(project) {
  await writeFile(path.join(project, "smoke.mjs"), `import { Policy } from "@fentaris/core";\nimport { redactEdgeValue } from "@fentaris/edge";\nimport { createInMemoryTelegramApprovalStore } from "@fentaris/approval-telegram";\nimport { main } from "@fentaris/cli";\nif (typeof Policy.allowAll !== "function" || typeof redactEdgeValue !== "function" || typeof createInMemoryTelegramApprovalStore !== "function" || typeof main !== "function") process.exit(1);\n`);
  await writeFile(path.join(project, "smoke.ts"), `import { Policy } from "@fentaris/core";\nimport { redactEdgeValue } from "@fentaris/edge";\nimport { createInMemoryTelegramApprovalStore } from "@fentaris/approval-telegram";\nimport { main } from "@fentaris/cli";\nvoid [Policy.allowAll(), redactEdgeValue({ token: "value" }), createInMemoryTelegramApprovalStore(), main];\n`);
  await writeFile(path.join(project, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true }, include: ["smoke.ts"] }, null, 2)}\n`);
}

async function verifyRuntimeAndTypes(project) {
  await run(process.execPath, ["smoke.mjs"], { cwd: project });
  await run(tsc, ["-p", "tsconfig.json"], { cwd: project });
}

async function verifyBins(project) {
  const binDirectory = path.join(project, "node_modules", ".bin");
  const fentaris = path.join(binDirectory, process.platform === "win32" ? "fentaris.cmd" : "fentaris");
  const edge = path.join(binDirectory, process.platform === "win32" ? "fentaris-edge.cmd" : "fentaris-edge");
  await run(fentaris, ["--version"], { cwd: project });
  await run(edge, ["not-a-command"], { cwd: project, expectedExitCodes: [2] });
}

async function verifyGeneratedProject(harnessProject) {
  const cli = path.join(harnessProject, "node_modules", ".bin", process.platform === "win32" ? "fentaris.cmd" : "fentaris");
  const coreTarball = packageState.get("@fentaris/core").tarball;
  await run(cli, ["init", "generated-proxy", "--non-interactive", "--package-manager", "npm", "--core-version", `file:${coreTarball}`, "--skip-git"], { cwd: harnessProject });
  const generated = path.join(harnessProject, "generated-proxy");
  await run("npm", ["run", "typecheck"], { cwd: generated });
  await run("npm", ["run", "build"], { cwd: generated });
  await run(cli, ["check", "--offline", "--json", "--non-interactive"], { cwd: generated });
}

async function findTarball(packageName, version) {
  const expected = `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
  const files = await readdir(artifactsDirectory);
  const filename = files.find((file) => file === expected);
  assert(filename, `${packageName}: pnpm pack did not create ${expected}`);
  return path.join(artifactsDirectory, filename);
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

async function run(command, args, options = {}) {
  const expectedExitCodes = options.expectedExitCodes ?? [0];
  const environment = {
    ...process.env,
    FENTARIS_AUTH_KEY: sentinelSecrets[0],
    TELEGRAM_BOT_TOKEN: sentinelSecrets[1],
    NPM_TOKEN: sentinelSecrets[2],
    npm_config_cache: npmCache,
    npm_config_loglevel: "warn",
  };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after 5 minutes`));
    }, 300_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  for (const secret of sentinelSecrets) {
    assert(!combined.includes(secret), `${command} leaked a sentinel secret in command output`);
  }
  if (!expectedExitCodes.includes(result.code)) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.code}\n${redact(combined)}`);
  }
  return result;
}

function redact(value) {
  return sentinelSecrets.reduce((output, secret) => output.replaceAll(secret, "[REDACTED]"), value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
