import { describe, expect, it } from "vitest";
import {
  INSTALLATION_RECIPE_VERSION,
  IN_MEMORY_INSTALLATION_ADAPTER_WARNING,
  InMemoryInstallationApprovalStore,
  InMemoryInstallationArtifactStore,
  InMemoryInstallationAttemptStore,
  InMemoryInstallationLifecycleStore,
  InMemoryInstallationMutationLock,
  canonicalizeInstallationValue,
  edge,
  installationApprovalDigest,
  installedArtifact,
  normalizeInstallationReadiness,
  parseInstallationRecipe,
  serializeInstallationRecipe,
  validateInstallationRecipe,
  type InstallationDigest,
  type InstallationRecipe,
} from "../../src/index.js";

const digest = (character: string): InstallationDigest => `sha256:${character.repeat(64)}`;

function customRecipe() {
  return edge.install.custom({
    source: { kind: "git", repository: "https://example.com/acme/server.git", commit: "a".repeat(40) },
    entrypoint: "install.sh",
    interpreter: "sh",
    args: ["--managed"],
  }, {
    permissions: { network: "source-only", requireNetworkIsolation: true },
    verification: [{ kind: "executable", target: "bin/server", expectedVersion: "1.2.3" }],
    outputs: [{ name: "server", kind: "executable", path: "bin/server" }],
    cleanup: { kind: "managed-directory" },
  });
}

describe("managed installation contracts", () => {
  it("builds, canonicalizes, serializes, and validates a custom recipe", () => {
    const recipe = customRecipe();
    expect(recipe.version).toBe(INSTALLATION_RECIPE_VERSION);
    expect(recipe.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parseInstallationRecipe(serializeInstallationRecipe(recipe))).toEqual(recipe);
    expect(canonicalizeInstallationValue({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it("invalidates digest and approval identity for every effective-plan change", () => {
    const recipe = customRecipe();
    const tampered = structuredClone(recipe) as InstallationRecipe;
    (tampered.provider as { args: string[] }).args = ["--changed"];
    expect(() => validateInstallationRecipe(tampered)).toThrow(/digest mismatch/);
    expect(installationApprovalDigest(recipe, { network: "deny" })).not.toBe(installationApprovalDigest(recipe, { network: "allow" }));
  });

  it("rejects floating sources, authenticated URLs, escaping output, and elevation", () => {
    const recipe = structuredClone(customRecipe()) as InstallationRecipe;
    (recipe.provider as { source: { commit: string } }).source.commit = "main";
    expect(() => validateInstallationRecipe(recipe)).toThrow(/exact commit/);

    const authenticated = structuredClone(customRecipe()) as InstallationRecipe;
    (authenticated.provider as { source: { repository: string } }).source.repository = "https://token@example.com/repo.git";
    expect(() => validateInstallationRecipe(authenticated)).toThrow(/must not contain credentials/);

    const escaping = structuredClone(customRecipe()) as InstallationRecipe;
    (escaping.outputs as { path: string }[])[0]!.path = "../server";
    expect(() => validateInstallationRecipe(escaping)).toThrow(/managed root/);

    const elevated = structuredClone(customRecipe()) as unknown as { permissions: { elevation: boolean } };
    elevated.permissions.elevation = true;
    expect(() => validateInstallationRecipe(elevated)).toThrow(/permissions/);
  });

  it("builds every supported provider with immutable identity", () => {
    const common = {
      verification: [{ kind: "executable" as const, target: "bin/tool" }],
      outputs: [{ name: "tool", kind: "executable" as const, path: "bin/tool" }],
    };
    expect(edge.install.nodePackage({ package: "tool", version: "1.0.0", integrity: digest("1") }, common).provider.kind).toBe("node-package");
    expect(edge.install.python({ package: "tool", version: "1.0.0", hashes: [digest("2")] }, common).provider.kind).toBe("python");
    expect(edge.install.binary({ source: { kind: "archive", url: "https://example.com/tool.tgz", integrity: digest("3") } }, common).provider.kind).toBe("binary");
    expect(edge.install.container({ image: "example/tool", digest: digest("4") }, common).provider.kind).toBe("container");
    expect(edge.install.manual({ requirement: "Desktop Tool 1.0", detect: common.verification[0], nextAction: "Install Desktop Tool 1.0 locally." }, { outputs: common.outputs }).provider.kind).toBe("manual");
    expect(() => edge.install.nodePackage({ package: "tool", version: "latest", integrity: digest("1") }, common)).toThrow(/exact/);
  });

  it("creates only declared installed-artifact references and normalizes readiness", () => {
    const recipe = customRecipe();
    expect(installedArtifact(recipe, "server")).toEqual({
      __fentarisInstalledArtifact: true,
      installationDigest: recipe.digest,
      output: "server",
      kind: "executable",
    });
    expect(() => installedArtifact(recipe, "missing")).toThrow(/not declared/);
    expect(normalizeInstallationReadiness("ready")).toBe("ready");
    expect(normalizeInstallationReadiness("installing")).toBe("setup-required");
    expect(normalizeInstallationReadiness("failed")).toBe("blocked");
  });
});

describe("in-memory installation adapters", () => {
  it("store deterministic lifecycle, approval, attempts, and artifacts", async () => {
    const recipe = customRecipe();
    const attempts = new InMemoryInstallationAttemptStore();
    const approvals = new InMemoryInstallationApprovalStore();
    const lifecycle = new InMemoryInstallationLifecycleStore();
    const artifacts = new InMemoryInstallationArtifactStore();
    await attempts.put({ attemptId: "a1", recipeDigest: recipe.digest, state: "failed", startedAt: 1, finishedAt: 2, retryable: true });
    await approvals.put({ approvalDigest: recipe.digest, recipeDigest: recipe.digest, decision: "approved", decidedAt: 1 });
    await lifecycle.put({ deploymentId: "server", desiredVersion: 1, recipeDigest: recipe.digest, launchDigest: "sha256:launch", state: "checking", readiness: "setup-required", observedAt: 1 });
    await artifacts.put({ recipeDigest: recipe.digest, root: "/managed/redacted", outputs: { server: "bin/server" }, verifiedAt: 2, active: true, references: 1 });
    expect((await attempts.list(recipe.digest))[0]?.attemptId).toBe("a1");
    expect((await approvals.get(recipe.digest))?.decision).toBe("approved");
    expect((await lifecycle.list())[0]?.deploymentId).toBe("server");
    expect((await artifacts.get(recipe.digest))?.active).toBe(true);
    expect(IN_MEMORY_INSTALLATION_ADAPTER_WARNING).toMatch(/single-process/);
  });

  it("serializes concurrent mutations per installation root", async () => {
    const lock = new InMemoryInstallationMutationLock();
    const order: number[] = [];
    await Promise.all([
      lock.runExclusive("root", async () => { order.push(1); await Promise.resolve(); order.push(2); }),
      lock.runExclusive("root", async () => { order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
