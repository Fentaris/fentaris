import path from "node:path";
import { getDoctorResults } from "../domain/health/checks.js";
import {
  ensureEmptyTargetDirectory,
  resolveProjectName,
  runPackageInstall,
  selectPackageManager,
  validatePackageManager,
} from "../domain/project/project.js";
import { renderTemplate, writeTemplate } from "../domain/template/template.js";
import type { CliCommand, PackageManager, Runtime } from "../shared/types.js";
import { numberOption, stringOption } from "../shared/utils.js";
import { nextSteps, printBanner, printHealthResults, section, style } from "../ui/format.js";

export async function runInit(command: CliCommand, runtime: Runtime): Promise<void> {
  printBanner(runtime);
  if (runtime.nonInteractive && !command.args[0]?.trim()) {
    throw new Error("Project name is required for non-interactive init. Pass it as an argument.");
  }
  const projectName = await resolveProjectName(command.args[0], runtime.prompt);
  const targetDir = path.resolve(runtime.cwd, projectName);
  await ensureEmptyTargetDirectory(targetDir);

  const skipInstall = command.options["skip-install"] === true;
  const packageManager = await resolveInitPackageManager(command, runtime, { requireInstalled: !skipInstall });
  const template = renderTemplate({
    projectName,
    packageManager,
    port: numberOption(command.options, "port", 4000),
    proxyPath: stringOption(command.options, "path", "/mcp"),
  });

  section(runtime, "Create Project");
  await writeTemplate(targetDir, template.files);
  runtime.out.log(`  ${style.pass(`Created ${projectName}`)}`);

  section(runtime, "Install");
  if (skipInstall) {
    runtime.out.log(`  ${style.warn("Skipped dependency install by request.")}`);
  } else {
    await runPackageInstall(packageManager, targetDir, runtime.runner);
    runtime.out.log(`  ${style.pass(`Installed dependencies with ${packageManager}`)}`);
  }

  section(runtime, "Git");
  if (command.options["skip-git"] === true) {
    runtime.out.log(`  ${style.warn("Skipped git initialization by request.")}`);
  } else if (runtime.probe("git", ["--version"])) {
    await runtime.runner("git", ["init"], { cwd: targetDir, stdio: "ignore" });
    runtime.out.log(`  ${style.pass("Initialized git repository")}`);
  } else {
    runtime.out.log(`  ${style.warn("Skipped git initialization because git was not found.")}`);
  }

  section(runtime, "Doctor");
  const doctorResults = await getDoctorResults({ ...runtime, cwd: targetDir }, false);
  printHealthResults(runtime, doctorResults, { verboseHint: "doctor" });

  section(runtime, "Next Steps");
  runtime.out.log(nextSteps([`cd ${projectName}`, "fentaris dev"]));
}

async function resolveInitPackageManager(command: CliCommand, runtime: Runtime, options: { requireInstalled: boolean }): Promise<PackageManager> {
  const option = stringOption(command.options, "package-manager", "");
  if (option) {
    const packageManager = validatePackageManager(option);
    if (options.requireInstalled && !runtime.probe(packageManager, ["--version"])) {
      throw new Error(`Package manager '${packageManager}' was not found. Install ${packageManager} or pass --skip-install.`);
    }
    return packageManager;
  }

  return selectPackageManager(runtime.probe, runtime.prompt);
}
