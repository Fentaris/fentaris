import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProjectCheckResults, hasFailure } from "../domain/health/checks.js";
import { discoverProject, runPackageScript } from "../domain/project/project.js";
import { buildDir, cliVersion } from "../shared/constants.js";
import type { Runtime } from "../shared/types.js";
import { printHealthResults, section, style } from "../ui/format.js";

export async function runBuild(runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
  const results = await getProjectCheckResults(project, true);
  if (hasFailure(results)) {
    printHealthResults(runtime, results, { verboseHint: "check" });
    throw new Error("Build requires a valid Fentaris project.");
  }

  section(runtime, "Build");
  await runPackageScript(project.config.packageManager, project.root, "build", runtime.runner);
  const outputDir = path.join(project.root, buildDir);
  await mkdir(outputDir, { recursive: true });
  await copyFile(path.join(project.root, "package.json"), path.join(outputDir, "package.json"));
  await writeFile(
    path.join(outputDir, "manifest.json"),
    JSON.stringify(
      {
        name: project.config.name,
        entrypoint: project.config.entrypoint,
        createdBy: `fentaris ${cliVersion}`,
      },
      null,
      2,
    ),
  );
  runtime.out.log(`  ${style.pass("TypeScript output: dist/index.js")}`);
  runtime.out.log(`  Fentaris metadata: ${path.relative(runtime.cwd, outputDir)}`);
  runtime.out.log(`  Runtime entrypoint metadata: ${project.config.entrypoint}`);
  runtime.out.log("  Run with: node dist/index.js");
}
