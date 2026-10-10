import { findEnvironmentProjectRoot, loadProjectEnvironment } from "@fentaris/core";
import { commandError } from "../shared/input.js";
import { runAuth } from "../commands/auth.js";
import { runBuild } from "../commands/build.js";
import { runCheck } from "../commands/check.js";
import { runDev } from "../commands/dev.js";
import { runDoctor } from "../commands/doctor.js";
import { runInit } from "../commands/init.js";
import { runSecrets } from "../commands/secrets.js";
import { runMcp } from "../commands/mcp.js";
import { runEdge } from "../commands/edge.js";
import { cliVersion } from "../shared/constants.js";
import { parseCommand } from "../shared/parse.js";
import type { CliCommand, Prompt, Runtime } from "../shared/types.js";
import { printCommandHelp, printParseError } from "../ui/format.js";

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
    if (argv.includes("--json")) commandError(runtime, true, new Error(parsed.message), "INVALID_INPUT");
    else printParseError(runtime, parsed.message, parsed.path);
    runtime.prompt.close();
    return 2;
  }

  const prior = new Map<string, string | undefined>();
  try {
    const env = loadProjectEnvironment(findEnvironmentProjectRoot(runtime.cwd), runtime.env);
    for (const [name, value] of Object.entries(env)) { prior.set(name, process.env[name]); if (value !== undefined) process.env[name] = value; }
    return await route(parsed.command, runtimeForCommand(parsed.command, { ...runtime, env })) ?? 0;
  } catch (error: unknown) {
    commandError(runtime, parsed.command.options.json === true, error);
    return 1;
  } finally {
    for (const [name, value] of prior) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    runtime.prompt.close();
  }
}

function runtimeForCommand(command: CliCommand, runtime: Runtime): Runtime {
  if (command.options["non-interactive"] !== true && command.options.json !== true && runtime.nonInteractive !== true) {
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

async function route(command: CliCommand, runtime: Runtime): Promise<number | void> {
  if (command.name === "edge") {
    return runEdge(command, runtime);
  }
  if (command.name === "auth") {
    await runAuth(command, runtime);
    return;
  }

  if (command.name === "secrets") {
    return await runSecrets(command, runtime);
  }

  if (command.name === "mcp") return runMcp(command, runtime);

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
