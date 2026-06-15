import { discoverProject, runPackageScript } from "../domain/project/project.js";
import type { Runtime } from "../shared/types.js";
import { section, style } from "../ui/format.js";

export async function runDev(runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
  section(runtime, "Dev");
  runtime.out.log(`  ${style.pass(`Starting ${project.config.name} at http://localhost:${project.config.port}${project.config.path}`)}`);
  await runPackageScript(project.config.packageManager, project.root, "dev", runtime.runner);
}
