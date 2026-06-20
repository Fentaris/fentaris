import path from "node:path";
import { getDoctorResults } from "../domain/health/checks.js";
import {
  ensureEmptyTargetDirectory,
  resolveProjectName,
  runPackageInstall,
  selectPackageManager,
} from "../domain/project/project.js";
import { renderTemplate, writeTemplate } from "../domain/template/template.js";
import type { CliCommand, Runtime } from "../shared/types.js";
import { numberOption, stringOption } from "../shared/utils.js";
import { nextSteps, printBanner, printHealthResults, section, style } from "../ui/format.js";

export async function runInit(command: CliCommand, runtime: Runtime): Promise<void> {
  printBanner(runtime);
  const projectName = await resolveProjectName(command.args[0], runtime.prompt);
  const targetDir = path.resolve(runtime.cwd, projectName);
  await ensureEmptyTargetDirectory(targetDir);

  const packageManager = await selectPackageManager(runtime.probe, runtime.prompt);
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
  if (command.options["skip-install"] === true) {
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
