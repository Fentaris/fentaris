import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import {
  authDir,
  coreVersion,
  defaultCoreRange,
  generatedNodeTypesRange,
  generatedTsxRange,
  generatedTypeScriptRange,
  remoteMcpUrl,
} from "../../shared/constants.js";
import type { TemplateInput } from "../../shared/types.js";

export function renderTemplate(input: TemplateInput): { files: Record<string, string> } {
  const coreRange = resolveCoreRange(input.coreVersionRange);
  const template = input.template ?? "local";
  return {
    files: {
      "README.md": renderReadme(input, coreRange, template),
      "package.json": JSON.stringify(
        {
          name: input.projectName,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx watch --env-file-if-exists=.env src/index.ts",
            typecheck: "tsc -p tsconfig.json --noEmit",
            build: "tsc -p tsconfig.json",
            start: "node --env-file-if-exists=.env dist/index.js",
          },
          dependencies: {
            "@fentaris/core": coreRange,
            tsx: generatedTsxRange,
          },
          devDependencies: {
            "@types/node": generatedNodeTypesRange,
            typescript: generatedTypeScriptRange,
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            types: ["node"],
            outDir: "dist",
            rootDir: "src",
          },
          include: ["src"],
        },
        null,
        2,
      ),
      "fentaris.json": JSON.stringify(
        {
          name: input.projectName,
          packageManager: input.packageManager,
          entrypoint: "src/index.ts",
          port: input.port,
          host: "127.0.0.1",
          path: input.proxyPath,
          authDir,
          edge: {
            controlPlane: {
              enabled: false,
              mode: "local",
              stateDir: "edge-control-plane",
            },
          },
        },
        null,
        2,
      ),
      ".gitignore": [
        "node_modules/",
        "dist/",
        ".env",
        ".env.*",
        ".fentaris/*",
        "!.fentaris/secrets.manifest.json",
        ".fentaris/build/",
        "*.log",
        "",
      ].join("\n"),
      ...(input.packageManager === "pnpm"
        ? {
            "pnpm-workspace.yaml": [
              "packages: []",
              "allowBuilds:",
              "  esbuild: true",
              "",
            ].join("\n"),
          }
        : {}),
      ".fentaris/secrets.manifest.json": JSON.stringify({
        version: 1,
        references: [],
        ...(template === "team" ? { apiKeys: [{ userId: "teammate", source: { type: "local" }, count: 1 }] } : {}),
      }, null, 2),
      "src/index.ts": renderEntrypoint(template),
    },
  };
}

export function renderEntrypoint(template: "local" | "team" = "local"): string {
  return `import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
${renderConfig(template)}

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return typeof invoked === "string" && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
}

if (isEntrypoint()) {
  await fentaris(fentarisConfig).start();
}
`;
}

function renderConfig(template: "local" | "team"): string {
  if (template === "team") {
    return `import { credentialJson, fentaris, group, mcp, policy, streamableHttp, user, type McpProxyOptions } from "@fentaris/core";

const teammates = policy("teammates")
  .mcp("specification")
  .allow("search");

export const fentarisConfig = {
  groups: [
    group({
      id: "teammates",
      users: [user("teammate", { apiKeys: [credentialJson("users.teammate.apiKeys.0")] })],
      policy: teammates,
    }),
  ],
  servers: [
    mcp("specification", {
      transport: streamableHttp({ url: "${remoteMcpUrl}" }),
    }),
  ],
} satisfies McpProxyOptions;
`;
  }

  return `import { Policy, fentaris, mcp, streamableHttp, type McpProxyOptions } from "@fentaris/core";

// Keep this small and directly editable while exploring Fentaris locally.
export const fentarisConfig = {
  policy: Policy.allowAll(),
  servers: [mcp("specification", {
    transport: streamableHttp({ url: "${remoteMcpUrl}" }),
  })],
} satisfies McpProxyOptions;
`;
}

export async function writeTemplate(targetDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

function renderReadme(input: TemplateInput, coreRange: string, template: "local" | "team"): string {
  const runScript = input.packageManager === "npm" ? "npm run" : input.packageManager;
  const governance = template === "team"
    ? `This team template fails closed: the \`teammates\` group can use only \`specification__search\`. Edit the group, user, and explicit tool allow-list in \`src/index.ts\`.

Create a random local API key manually (the generated project contains no key):

\`\`\`sh
fentaris auth api-key add teammate --generate --non-interactive
\`\`\`

Save the printed client key once and send it as \`x-fentaris-api-key\`. Never commit the client key or \`.env\`.
`
    : `The generated \`Policy.allowAll()\` policy is for local development only. Edit the inspectable configuration in \`src/index.ts\` before sharing or exposing the proxy.
`;
  return `# ${input.projectName}

This ${template} boilerplate was generated by the Fentaris CLI. It mounts the public MCP specification server as \`specification\`.

## Quick start

\`\`\`sh
${input.packageManager} install
${runScript} dev
\`\`\`

\`fentaris dev\` starts the project with \`tsx watch\` and automatically restarts the proxy when its TypeScript source files change. The proxy listens on \`http://127.0.0.1:${input.port}${input.proxyPath}\` by default.

${governance}

The generated project pins \`@fentaris/core\` to \`${coreRange}\` (currently \`^${coreVersion}\` by default). Run \`${input.packageManager} outdated @fentaris/core\` to check for compatible updates, then \`${input.packageManager} update @fentaris/core\` to install them.

## Project files

- \`src/index.ts\` exports the inspectable configuration used by runtime and CLI discovery, and starts the proxy only when executed directly.
- \`fentaris.json\` configures the project entrypoint, port, path, and CLI defaults.
- \`.fentaris/secrets.manifest.json\` lists required credential references (schema only, safe to commit).

## Useful commands

\`\`\`sh
${runScript} typecheck
${runScript} build
fentaris tools list
fentaris doctor
fentaris check --offline
fentaris build
\`\`\`
`;
}

function resolveCoreRange(value: string | undefined): string {
  const candidate = (value ?? defaultCoreRange).trim();
  if (!candidate) {
    throw new Error("@fentaris/core version range is required.");
  }

  if (candidate === "latest" || candidate === "next" || candidate === "beta" || candidate === "canary") {
    return candidate;
  }

  if (candidate.startsWith("workspace:") || candidate.startsWith("file:") || candidate.startsWith("link:") || candidate.startsWith("portal:")) {
    return candidate;
  }

  if (candidate.startsWith("npm:") || candidate.startsWith("git:") || candidate.startsWith("github:") || candidate.startsWith("http:") || candidate.startsWith("https:")) {
    return candidate;
  }

  if (candidate.startsWith("git+ssh:") || candidate.startsWith("git+http:") || candidate.startsWith("git+https:")) {
    return candidate;
  }

  if (isValidSemverRange(candidate)) {
    return candidate;
  }

  throw new Error(
    `Invalid --core-version value '${candidate}'. Use a semver range (e.g. ^3.0.0, ~3.0.0, 3.0.0), a dist tag (latest, next), or a workspace/file reference.`,
  );
}

function isValidSemverRange(value: string): boolean {
  return semver.validRange(value) !== null;
}
