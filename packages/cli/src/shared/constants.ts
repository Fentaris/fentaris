import { createRequire } from "node:module";
import type { PackageManager } from "./types.js";

const packageJson = createRequire(import.meta.url)("../../package.json") as { version: string };

export const supportedPackageManagers: PackageManager[] = ["pnpm", "npm", "bun"];
export const authDir = ".fentaris";
export const buildDir = ".fentaris/build";
export const remoteMcpUrl = "https://mcp.specification.website/mcp";
export const cliVersion = packageJson.version;
