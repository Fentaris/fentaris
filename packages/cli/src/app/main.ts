import { runBuild } from "../commands/build.js";
import { runCheck } from "../commands/check.js";
import { runDev } from "../commands/dev.js";
import { runDoctor } from "../commands/doctor.js";
import { runInit } from "../commands/init.js";
import { runSecrets } from "../commands/secrets.js";
import { cliVersion } from "../shared/constants.js";
import { parseCommand } from "../shared/parse.js";
import type { CliCommand, Prompt, Runtime } from "../shared/types.js";
import { printCommandHelp, printParseError, printRuntimeError } from "../ui/format.js";

export async function main(argv: string[], runtime: Runtime): Promise<number> {
  const parsed = parseCommand(argv);

  if (parsed.kind === "version") {
    runtime.out.log(cliVersion);
    runtime.prompt.close();
    return 0;
  }

  if (parsed.kind === "help") {
    printCommandHelp(runtime, parsed.path);
    runtime.prompt.close();
    return 0;
  }

  if (parsed.kind === "parse-error") {
    printParseError(runtime, parsed.message, parsed.path);
    runtime.prompt.close();
    return 2;
  }

  try {
    await route(parsed.command, runtimeForCommand(parsed.command, runtime));
    return 0;
  } catch (error: unknown) {
    printRuntimeError(runtime, error);
    return 1;
  } finally {
    runtime.prompt.close();
  }
}

function runtimeForCommand(command: CliCommand, runtime: Runtime): Runtime {
  if (command.options["non-interactive"] !== true) {
    return runtime;
  }

  return {
    ...runtime,
    nonInteractive: true,
    prompt: nonInteractivePrompt(runtime.prompt),
  };
}

function nonInteractivePrompt(prompt: Prompt): Prompt {
  const fail = async () => {
    throw new Error("Command requires interactive input. Pass explicit options or omit --non-interactive.");
  };
  return {
    text: fail,
    select: fail,
    confirm: fail,
    close: () => prompt.close(),
  };
}

async function route(command: CliCommand, runtime: Runtime): Promise<void> {
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

  throw new Error(`Unknown command "${command.name}".`);
}
