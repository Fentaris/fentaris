import { getDoctorResults, hasFailure, hasWarning } from "../domain/health/checks.js";
import type { CliCommand, Runtime } from "../shared/types.js";
import { numberOption } from "../shared/utils.js";
import { printHealthResults, section } from "../ui/format.js";

export async function runDoctor(command: CliCommand, runtime: Runtime): Promise<void> {
  const results = await getDoctorResults(runtime, {
    fix: command.options.fix === true,
    runtime: command.options.runtime === true,
    timeoutMs: numberOption(command.options, "timeout", 10_000),
  });
  if (command.options.json === true) {
    runtime.out.log(JSON.stringify({ results }, null, 2));
  } else {
    section(runtime, "Doctor");
    printHealthResults(runtime, results);
  }
  if (hasFailure(results) || (command.options.strict === true && hasWarning(results))) {
    throw new Error("Doctor reported issues.");
  }
}
