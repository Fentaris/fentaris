import { runBuild } from "../commands/build.js";
import { runCheck } from "../commands/check.js";
import { runDev } from "../commands/dev.js";
import { runDoctor } from "../commands/doctor.js";
import { runInit } from "../commands/init.js";
import { runSecrets } from "../commands/secrets.js";
import { cliVersion } from "../shared/constants.js";
import { parseCommand } from "../shared/parse.js";
import type { CliCommand, Runtime } from "../shared/types.js";
import { printHelp, style } from "../ui/format.js";

export async function main(argv: string[], runtime: Runtime): Promise<number> {
  const command = parseCommand(argv);

  try {
    await route(command, runtime);
    return 0;
  } catch (error: unknown) {
    runtime.out.error(style.fail(error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    runtime.prompt.close();
  }
}

async function route(command: CliCommand, runtime: Runtime): Promise<void> {
  if (command.name === "version" || (command.name === "help" && (command.options.version === true || command.options.v === true))) {
    runtime.out.log(cliVersion);
    return;
  }

  if (command.name === "help" || command.options.help === true || command.options.h === true) {
    printHelp(runtime);
    return;
  }

  if (command.name === "secrets") {
    await runSecrets(command, runtime);
    return;
  }

  if (command.name === "init") {
    await runInit(command, runtime);
    return;
  }

  if (command.name === "doctor") {
    await runDoctor(command, runtime);
    return;
  }

  if (command.name === "check") {
    await runCheck(command, runtime);
    return;
  }

  if (command.name === "dev") {
    await runDev(runtime);
    return;
  }

  if (command.name === "build") {
    await runBuild(runtime);
    return;
  }

  throw new Error(`Unknown command "${command.name}". Run fentaris help.`);
}
