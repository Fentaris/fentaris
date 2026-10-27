import { ROOT } from "./cli.js";
import { toClientError } from "./errors.js";
import { globalOptions, parse, renderHelp } from "./framework.js";
import { writeError, writeResult } from "./output.js";
import { defaultRuntime, type Runtime } from "./runtime.js";
import { VERSION } from "./session.js";

export async function main(argv: string[], runtime: Runtime = defaultRuntime()): Promise<number> {
  let json = argv.includes("--json");
  try {
    const parsed = parse(argv, ROOT);
    if (parsed.kind === "version") { runtime.write(`${VERSION}\n`); return 0; }
    if (parsed.kind === "help") { runtime.write(renderHelp(parsed.command)); return 0; }
    const global = globalOptions(parsed.options, runtime);
    json = global.json;
    const result = await parsed.command.run!({ runtime, argv, args: parsed.args, options: parsed.options, global });
    return writeResult(runtime, result, json);
  } catch (error) {
    return writeError(runtime, toClientError(error), json);
  }
}
