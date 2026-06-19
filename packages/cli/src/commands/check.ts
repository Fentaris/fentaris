import { getProjectCheckResults, hasFailure, hasWarning } from "../domain/health/checks.js";
import { discoverProject } from "../domain/project/project.js";
import type { CliCommand, Runtime } from "../shared/types.js";
import { printHealthResults, section } from "../ui/format.js";

export async function runCheck(command: CliCommand, runtime: Runtime): Promise<void> {
  const project = await discoverProject(runtime.cwd);
  section(runtime, "Project Check");
  const results = await getProjectCheckResults(project, command.options.offline === true, runtime);
  printHealthResults(runtime, results, { verbose: command.options.verbose === true });
  if (hasFailure(results) || (command.options.strict === true && hasWarning(results))) {
    throw new Error("Project check reported issues.");
  }
}
