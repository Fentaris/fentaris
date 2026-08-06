import { describe, expect, it } from "vitest";
import {
  McpProxy,
  McpServer,
  Policy,
  StdioTransport,
  compileLaunchRecipe,
  computeRecipeDigest,
  edge,
  edgeInstallDirectoryName,
  edgeInstallPackageId,
  parseLaunchRecipe,
  serializeLaunchRecipe,
  validateEdgeInstallPlan,
  validateLaunchRecipe,
} from "../../src/index.js";
import type { EdgeNpmInstallPlan } from "../../src/index.js";

const plan = () => edge.npm({ package: "@modelcontextprotocol/server-filesystem", version: "2026.1.4", bin: "mcp-server-filesystem" });

describe("edge.npm install plans", () => {
  it("compiles a pinned, frozen, digest-bound plan", () => {
    const compiled = plan();
    expect(compiled).toMatchObject({
      version: 1,
      kind: "npm",
      package: "@modelcontextprotocol/server-filesystem",
      packageVersion: "2026.1.4",
      bin: "mcp-server-filesystem",
    });
    expect(compiled.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(edgeInstallPackageId(compiled)).toBe("@modelcontextprotocol/server-filesystem@2026.1.4");
  });

  it("defaults the bin to the unscoped package name", () => {
    expect(edge.npm({ package: "@scope/server-x", version: "1.0.0" }).bin).toBe("server-x");
  });

  it("rejects ranges, dist-tags, and other inexact versions", () => {
    for (const version of ["^1.2.3", "~1.2.3", "1.x", "latest", "next", "1.2", ""]) {
      expect(() => edge.npm({ package: "server", version })).toThrow(TypeError);
    }
  });

  it("rejects unsafe package names and bin values", () => {
    expect(() => edge.npm({ package: "../evil", version: "1.0.0" })).toThrow(TypeError);
    expect(() => edge.npm({ package: "Server", version: "1.0.0" })).toThrow(TypeError);
    expect(() => edge.npm({ package: "server", version: "1.0.0", bin: "../../bin/sh" })).toThrow(TypeError);
    expect(() => edge.npm({ package: "server", version: "1.0.0", bin: "sub/dir" })).toThrow(TypeError);
  });

  it("rejects malformed integrity digests and non-https registries", () => {
    expect(() => edge.npm({ package: "server", version: "1.0.0", integrity: "md5-abc" })).toThrow(TypeError);
    expect(() => edge.npm({ package: "server", version: "1.0.0", registryUrl: "http://registry.example.com" })).toThrow(TypeError);
    expect(edge.npm({ package: "server", version: "1.0.0", registryUrl: "http://localhost:4873" }).registryUrl)
      .toBe("http://localhost:4873");
  });

  it("derives a filesystem-safe, digest-suffixed install directory name", () => {
    const name = edgeInstallDirectoryName(plan());
    expect(name).toMatch(/^@modelcontextprotocol_server-filesystem@2026\.1\.4-[0-9a-f]{12}$/);
  });

  it("validates control-plane plans and rejects digest tampering", () => {
    const compiled = plan();
    expect(validateEdgeInstallPlan(JSON.parse(JSON.stringify(compiled)))).toEqual(compiled);
    expect(() => validateEdgeInstallPlan({ ...compiled, digest: "sha256:0" })).toThrow(/digest mismatch/);
    expect(() => validateEdgeInstallPlan({ ...compiled, packageVersion: "9.9.9" })).toThrow(/digest mismatch/);
    expect(() => validateEdgeInstallPlan({ ...compiled, kind: "brew" })).toThrow(/unsupported install plan kind/);
    expect(() => validateEdgeInstallPlan({ ...compiled, version: 2 })).toThrow(/unsupported install plan version/);
    expect(() => validateEdgeInstallPlan("nope")).toThrow(/not an object/);
  });
});

describe("launch recipes with managed installs", () => {
  it("carries the plan and covers it with the recipe digest", () => {
    const recipe = compileLaunchRecipe({
      command: "mcp-server-filesystem",
      args: ["--root", "/tmp"],
      install: plan(),
    });
    expect(recipe.install).toEqual(plan());
    const other = compileLaunchRecipe({
      command: "mcp-server-filesystem",
      args: ["--root", "/tmp"],
      install: edge.npm({ package: "@modelcontextprotocol/server-filesystem", version: "2026.1.5", bin: "mcp-server-filesystem" }),
    });
    expect(other.digest).not.toBe(recipe.digest);
  });

  it("accepts an inline install declaration and compiles it", () => {
    const recipe = compileLaunchRecipe({
      command: "server-x",
      install: { package: "@scope/server-x", version: "1.0.0" },
    });
    expect(recipe.install).toEqual(edge.npm({ package: "@scope/server-x", version: "1.0.0" }));
  });

  it("keeps the digest of recipes without an install plan unchanged", () => {
    const payload = {
      version: 1,
      command: "server",
      args: ["--flag"],
      env: { MODE: "test" },
      setupFieldRefs: [],
    } as const;
    const recipe = compileLaunchRecipe({ command: "server", args: ["--flag"], env: { MODE: "test" } });
    expect(recipe.install).toBeUndefined();
    expect(recipe.digest).toBe(computeRecipeDigest(payload));
  });

  it("requires a bare bin name as the command", () => {
    expect(() => compileLaunchRecipe({ command: "/usr/local/bin/server", install: plan() })).toThrow(/bare bin name/);
    expect(() => compileLaunchRecipe({ command: "dir\\server", install: plan() })).toThrow(/bare bin name/);
    expect(() => validateLaunchRecipe({
      version: 1,
      command: "bin/server",
      args: [],
      env: {},
      install: JSON.parse(JSON.stringify(plan())) as EdgeNpmInstallPlan,
    })).toThrow(/bare bin name/);
  });

  it("round-trips a managed-install recipe through serialization", () => {
    const recipe = compileLaunchRecipe({ command: "mcp-server-filesystem", install: plan() });
    const parsed = parseLaunchRecipe(serializeLaunchRecipe(recipe));
    expect(parsed).toEqual(recipe);
  });

  it("rejects an install plan carrying executable data", () => {
    expect(() => validateLaunchRecipe({
      version: 1,
      command: "server",
      args: [],
      env: {},
      install: { version: 1, kind: "npm", package: "server", packageVersion: "1.0.0", bin: "server", registryUrl: "javascript:alert(1)" },
    })).toThrow(/registryUrl/);
  });
});

describe("cloud rejection of managed installs", () => {
  it("refuses to launch a managed-install transport on the cloud target", async () => {
    const transport = new StdioTransport({ command: "mcp-server-filesystem", install: plan() });
    expect(transport.requiresManagedInstall()).toBe(true);
    const proxy = new McpProxy({
      policy: Policy.allowAll(),
      servers: [new McpServer({ name: "filesystem", transport })],
    });
    await expect(proxy.listTools()).rejects.toMatchObject({
      code: "EDGE_UNRESOLVED_RUNTIME_INPUT",
      message: expect.stringContaining("managed install"),
    });
  });
});
