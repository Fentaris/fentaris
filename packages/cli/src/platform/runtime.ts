import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { CommandResult, Prompt, Runtime } from "../shared/types.js";
import { style } from "../ui/format.js";

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
  return {
    async text(question, options = {}) {
      if (options.secret === true) {
        return askSecret(question, options.defaultValue);
      }
      const answer = await askLine(formatTextQuestion(question, options));
      return answer.trim() || options.defaultValue || "";
    },
    async select(question, choices) {
      console.log(style.heading(question));
      choices.forEach((choice, index) => {
        const marker = index === 0 ? style.command("›") : " ";
        console.log(`  ${marker} ${style.option(String(index + 1).padStart(2))}. ${choice}`);
      });
      const answer = await askLine(`${style.hint("Choose by number or exact label")} ${style.command("›")} `);
      const trimmed = answer.trim();
      const selectedByNumber = choices[Number(trimmed) - 1];
      const selected = selectedByNumber ?? choices.find((choice) => choice === trimmed);
      if (!selected) {
        throw new Error(`Expected one of: ${choices.join(", ")}`);
      }
      return selected;
    },
    async confirm(question) {
      const answer = await askLine(`${question} ${style.hint("[y/N]")} `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    },
    close() {},
  };
}

function formatTextQuestion(question: string, options: { secret?: boolean; defaultValue?: string }): string {
  const suffix = options.defaultValue ? ` ${style.hint(`(${options.defaultValue})`)}` : "";
  return `${question}${suffix}: ${style.command("›")} `;
}

async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdin.resume();
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function askSecret(question: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Secret prompts require an interactive terminal. Use FENTARIS_AUTH_KEY, --key, or --value-stdin for automation.");
  }

  return new Promise((resolve, reject) => {
    let answer = "";
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw === true;

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
    };
    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(answer.trim() || defaultValue || "");
    };
    const cancel = () => {
      cleanup();
      output.write("^C\n");
      reject(new Error("Prompt cancelled."));
    };
    const erase = () => {
      if (answer.length === 0) {
        return;
      }
      answer = answer.slice(0, -1);
      output.write("\b \b");
    };
    const onKeypress = (character: string, key: { ctrl?: boolean; meta?: boolean; name?: string }) => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        erase();
        return;
      }
      if (character && !key.ctrl && !key.meta) {
        answer += character;
        output.write("*");
      }
    };

    output.write(`${question}${defaultValue ? ` ${style.hint(`(${defaultValue})`)}` : ""}: `);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
  });
}

function runProcess(command: string, args: string[], options: SpawnOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
}
