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
    async select(question, choices, options = {}) {
      if (choices.length === 0) {
        throw new Error(`No choices available for ${question}.`);
      }
      if (isInteractiveSelectAvailable()) {
        return askSelect(question, choices, options.visibleItems);
      }
      return askSelectLine(question, choices);
    },
    async confirm(question) {
      const answer = await askLine(`${question} ${style.hint("[y/N]")} `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    },
    close() {
      process.stdin.pause();
    },
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
    process.stdin.pause();
  }
}

async function askSelectLine<T extends string>(question: string, choices: T[]): Promise<T> {
  console.log(style.heading(question));
  choices.forEach((choice, index) => {
    const marker = index === 0 ? style.command("›") : " ";
    console.log(`  ${marker} ${style.option(String(index + 1).padStart(2))}. ${choice}`);
  });
  const answer = await askLine(`${style.hint("Choose by number or exact label")} ${style.command("›")} `);
  const trimmed = answer.trim();
  if (!trimmed) {
    return choices[0];
  }
  const selectedByNumber = choices[Number(trimmed) - 1];
  const selected = selectedByNumber ?? choices.find((choice) => choice === trimmed);
  if (!selected) {
    throw new Error(`Expected one of: ${choices.join(", ")}`);
  }
  return selected;
}

function indexForChoiceAnswer<T extends string>(answer: string, choices: T[]): number | undefined {
  if (/^[1-9]\d*$/.test(answer)) {
    const choiceIndex = Number(answer) - 1;
    if (choiceIndex >= 0 && choiceIndex < choices.length) {
      return choiceIndex;
    }
  }

  const exactIndex = choices.findIndex((choice) => choice === answer);
  return exactIndex === -1 ? undefined : exactIndex;
}

function isInteractiveSelectAvailable(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === "function");
}

async function askSelect<T extends string>(question: string, choices: T[], visibleItems = 8): Promise<T> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw === true;
    const limit = Math.max(1, Math.min(choices.length, visibleItems));
    let selectedIndex = 0;
    let topIndex = 0;
    let renderedLines = 0;
    let answer = "";

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\u001b[?25h");
    };
    const finish = () => {
      const requestedIndex = answer.trim() ? indexForChoiceAnswer(answer.trim(), choices) : selectedIndex;
      if (requestedIndex === undefined) {
        cleanup();
        clearRenderedLines();
        reject(new Error(`Expected one of: ${choices.join(", ")}`));
        return;
      }

      selectedIndex = requestedIndex;
      cleanup();
      clearRenderedLines();
      output.write(`${style.heading(question)}: ${choices[selectedIndex]}\n`);
      resolve(choices[selectedIndex]);
    };
    const cancel = () => {
      cleanup();
      clearRenderedLines();
      output.write("^C\n");
      reject(new Error("Prompt cancelled."));
    };
    const keepSelectedVisible = () => {
      if (selectedIndex < topIndex) {
        topIndex = selectedIndex;
      } else if (selectedIndex >= topIndex + limit) {
        topIndex = selectedIndex - limit + 1;
      }
    };
    const move = (delta: number) => {
      answer = "";
      selectedIndex = (selectedIndex + delta + choices.length) % choices.length;
      keepSelectedVisible();
      render();
    };
    const updateAnswer = (nextAnswer: string) => {
      answer = nextAnswer;
      const requestedIndex = indexForChoiceAnswer(answer.trim(), choices);
      if (requestedIndex !== undefined) {
        selectedIndex = requestedIndex;
        keepSelectedVisible();
      }
      render();
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
      if (key.name === "up") {
        move(-1);
        return;
      }
      if (key.name === "down") {
        move(1);
        return;
      }
      if (key.name === "backspace") {
        updateAnswer(answer.slice(0, -1));
        return;
      }
      if (character && !key.ctrl && !key.meta) {
        updateAnswer(`${answer}${character}`);
      }
    };
    const clearRenderedLines = () => {
      if (renderedLines === 0) {
        return;
      }
      output.write(`\u001b[${renderedLines}A\u001b[J`);
      renderedLines = 0;
    };
    const render = () => {
      clearRenderedLines();
      const visible = choices.slice(topIndex, topIndex + limit);
      const lines = [
        `${style.heading(question)}`,
        ...visible.map((choice, index) => {
          const choiceIndex = topIndex + index;
          const marker = choiceIndex === selectedIndex ? style.command("›") : " ";
          return `  ${marker} ${style.option(String(choiceIndex + 1).padStart(2))}. ${choice}`;
        }),
        `${style.hint("Choose by number or exact label")} ${style.command("›")} ${answer || choices[selectedIndex]}`,
      ];
      if (topIndex > 0) {
        lines.splice(1, 0, `  ${style.hint("↑ more")}`);
      }
      if (topIndex + limit < choices.length) {
        lines.splice(lines.length - 1, 0, `  ${style.hint("↓ more")}`);
      }
      output.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };

    output.write("\u001b[?25l");
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
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
      input.pause();
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
    let settled = false;
    const finish = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code });
    };
    const child = spawn(command, args, options);
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}
