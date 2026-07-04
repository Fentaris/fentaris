import { describe, expect, it } from "vitest";
import {
  ExecutableAllowlistPolicy,
  redactEdgeValue,
  safeEdgeError,
  type CompiledLocalLaunchPlan,
} from "../src/index.js";

function plan(command: string, args: string[] = []): CompiledLocalLaunchPlan {
  return {
    deploymentId: "fixture",
    recipeDigest: "sha256:recipe",
    command,
    args,
    env: {},
  };
}

describe("edge security hardening", () => {
  it("allows only explicitly configured executables or package launches", () => {
    const policy = new ExecutableAllowlistPolicy({
      executables: ["node", "/opt/fentaris/bin/approved"],
      packages: ["@example/approved-mcp"],
    });
    expect(policy.allow(plan("/usr/local/bin/node"))).toBe(true);
    expect(policy.allow(plan("/opt/fentaris/bin/approved"))).toBe(true);
    expect(policy.allow(plan("npx", ["--yes", "@example/approved-mcp"]))).toBe(true);
    expect(policy.allow(plan("npx", ["malicious-package"]))).toBe(false);
    expect(policy.allow(plan("/bin/sh", ["-c", "arbitrary"]))).toBe(false);
  });

  it("redacts secrets, paths, authorization, and complete environments", () => {
    const redacted = redactEdgeValue({
      authorization: "Bearer abc",
      credential: "device-secret",
      privateKey: "pem",
      canonicalPath: "/Users/alice/private",
      environment: { TOKEN: "value" },
      safe: "visible",
    });
    expect(redacted).toEqual({
      authorization: "[REDACTED]",
      credential: "[REDACTED]",
      privateKey: "[REDACTED]",
      canonicalPath: "[REDACTED]",
      environment: "[REDACTED]",
      safe: "visible",
    });
    const error = safeEdgeError(new Error("token=abc /Users/alice/private credential=xyz"));
    expect(error.message).not.toMatch(/abc|alice|xyz/);
  });
});

