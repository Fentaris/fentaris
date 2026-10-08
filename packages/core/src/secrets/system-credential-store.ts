import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
/** Injectable OS credential store; implementations must never print keys or use plaintext files. */
export type SystemCredentialStore = {
  get(projectId: string): Promise<string | undefined>;
  set(projectId: string, key: string): Promise<void>;
};
/** macOS Keychain. Other platforms require an explicit unlock key or an application-provided adapter. */
export function systemCredentialStore(platform = process.platform): SystemCredentialStore {
  if (platform !== "darwin") return {
    async get() { return undefined; },
    async set() { throw new Error("No supported system credential store. Configure FENTARIS_VAULT_KEY explicitly."); },
  };
  return {
    async get(projectId) {
      try {
        const result = await execute("/usr/bin/security", ["find-generic-password", "-s", "com.fentaris.project-vault", "-a", projectId, "-w"], { timeout: 10_000, maxBuffer: 4096 });
        return result.stdout.trim() || undefined;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === 44) return undefined;
        // Credential-bearing subprocess errors must not be attached as causes.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Unable to read the macOS Keychain credential.", { cause: new Error("Credential-store failure details were redacted.") });
      }
    },
    async set(projectId, key) {
      if (!/^[a-f0-9-]{36}$/.test(projectId) || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Invalid generated vault credential.");
      // Interactive security mode accepts its command on stdin, keeping the key out of process arguments.
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
        const timer = setTimeout(() => { child.kill(); reject(new Error("Keychain write timed out.")); }, 10_000);
        child.once("error", () => { clearTimeout(timer); reject(new Error("Keychain write failed.")); });
        child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("Keychain write failed.")); });
        child.stdin.on("error", () => { /* Report the process outcome without exposing command input. */ });
        child.stdin.end(`add-generic-password -s com.fentaris.project-vault -a ${projectId} -w ${key}\n`);
      });
      const persisted = await this.get(projectId);
      if (persisted !== key) throw new Error("The vault unlock key was not saved by Keychain.");
    },
  };
}
