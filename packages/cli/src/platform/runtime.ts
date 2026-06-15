import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { CommandResult, Prompt, Runtime } from "../shared/types.js";

export function defaultRuntime(): Runtime {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: console,
    runner: runProcess,
    probe: (command, args = ["--version"]) => spawnSync(command, args, { stdio: "ignore", timeout: 2_000 }).status === 0,
    prompt: createPrompt(),
  };
}

function createPrompt(): Prompt {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async text(question, options = {}) {
      const answer = await rl.question(`${question}${options.defaultValue ? ` (${options.defaultValue})` : ""}: `);
      return answer.trim() || options.defaultValue || "";
    },
    async select(question, choices) {
      const answer = await rl.question(`${question} (${choices.join("/")}): `);
      const selected = choices.find((choice) => choice === answer.trim());
      if (!selected) {
        throw new Error(`Expected one of: ${choices.join(", ")}`);
      }
      return selected;
    },
    async confirm(question) {
      const answer = await rl.question(`${question} [y/N]: `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    },
    close() {
      rl.close();
    },
  };
}

function runProcess(command: string, args: string[], options: SpawnOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
}
