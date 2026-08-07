import { edge, installedArtifact } from "@fentaris/core";

/**
 * Replace the example repository and commit with a reviewed installer and its
 * exact 40-character commit identity before assigning this recipe.
 */
export const pinnedCustomGitInstaller = edge.install.custom({
  source: {
    kind: "git",
    repository: "https://github.com/example/filesystem-mcp-installer.git",
    commit: "0123456789abcdef0123456789abcdef01234567",
  },
  entrypoint: "install.sh",
  interpreter: "sh",
  args: ["--managed-root"],
}, {
  permissions: {
    network: "source-only",
    requireNetworkIsolation: true,
    executables: ["sh"],
  },
  verification: [{ kind: "executable", target: "bin/filesystem-mcp" }],
  outputs: [{ name: "server", kind: "executable", path: "bin/filesystem-mcp" }],
  cleanup: { kind: "managed-directory" },
});

export const managedFilesystemCommand = installedArtifact(pinnedCustomGitInstaller, "server");

/** A desktop application remains a local prerequisite; Fentaris only detects it. */
export const desktopApplicationPrerequisite = edge.install.manual({
  requirement: "Example Desktop MCP 3.2",
  detect: { kind: "executable", target: "example-desktop-mcp", expectedVersion: "3.2.0" },
  nextAction: "Install Example Desktop MCP 3.2 from the approved vendor package, then retry locally.",
}, {
  outputs: [{ name: "server", kind: "executable", path: "example-desktop-mcp" }],
  cleanup: { kind: "manual" },
});
