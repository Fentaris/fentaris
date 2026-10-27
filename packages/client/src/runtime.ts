import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export type ExecResult = { code: number; stdout: string; stderr: string };

/** Process boundary used by every command; tests replace it with an in-memory runtime. */
export type Runtime = {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
  /** Both stdin and stdout are terminals. */
  interactive: boolean;
  stdoutIsTTY: boolean;
  write(text: string): void;
  writeBytes(data: Uint8Array): void;
  error(text: string): void;
  readStdin(): Promise<string>;
  /** Read one line without echo when stdin is a terminal. */
  readSecret(prompt: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  openUrl(url: string): Promise<void>;
  exec(command: string, args: string[], input?: string): Promise<ExecResult>;
  fetch: typeof fetch;
};

export function defaultRuntime(): Runtime {
  return {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    write: (text) => { process.stdout.write(text); },
    writeBytes: (data) => { process.stdout.write(data); },
    error: (text) => { process.stderr.write(text); },
    async readStdin() {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString("utf8");
    },
    readSecret: (prompt) => process.stdin.isTTY ? askHidden(prompt) : defaultRuntime().readStdin(),
    async confirm(question) {
      const answer = await askLine(`${question} [y/N] `);
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    },
    async openUrl(url) {
      // Never route URLs through a shell: query strings contain shell metacharacters.
      const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
      await exec(command, args).catch(() => undefined);
    },
    exec,
    fetch: (input, init) => fetch(input, init),
  };
}

function exec(command: string, args: string[], input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = ""; let stderr = "";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function askHidden(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stderr.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); process.stderr.write("\n"); resolve(answer); });
    muted = true;
  });
}
