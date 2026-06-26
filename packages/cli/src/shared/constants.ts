import { createRequire } from "node:module";
import type { PackageManager } from "./types.js";

const packageJson = createRequire(import.meta.url)("../../package.json") as { version: string };

export const supportedPackageManagers: PackageManager[] = ["pnpm", "npm", "bun"];
export const authDir = ".fentaris";
export const buildDir = ".fentaris/build";
export const remoteMcpUrl = "https://mcp.specification.website/mcp";
export const cliVersion = packageJson.version;
// Pinned to a known-good @fentaris/core release. The CLI and core are released
// together via changesets, so the CLI always embeds the version of core it was
// validated against. Users can override the range with `fentaris init --core-version`.
export const coreVersion = "2.0.0";
// Default range expression used for the generated package.json. A caret range
// lets users pick up compatible patches/minors of the pinned core.
export const defaultCoreRange = `^${coreVersion}`;
