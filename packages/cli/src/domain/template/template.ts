import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FentarisAuth } from "@fentaris/core";
import { authDir, remoteMcpUrl } from "../../shared/constants.js";
import type { TemplateInput } from "../../shared/types.js";
import { writeCredentials } from "../auth/local-store.js";

export function renderTemplate(input: TemplateInput): { files: Record<string, string>; authKey: string; guestApiKey: string; adminApiKey: string } {
  return {
    authKey: input.authKey,
    guestApiKey: input.guestApiKey,
    adminApiKey: input.adminApiKey,
    files: {
      "README.md": renderReadme(input),
      "package.json": JSON.stringify(
        {
          name: input.projectName,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx src/index.ts",
            build: "tsc -p tsconfig.json",
            start: "node dist/index.js",
          },
          dependencies: {
            "@modelcontextprotocol/server-filesystem": "latest",
            "@fentaris/core": "latest",
            tsx: "latest",
          },
          devDependencies: {
            "@types/node": "latest",
            typescript: "latest",
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
          path: input.proxyPath,
          authDir,
        },
        null,
        2,
      ),
      ".env.example": [
        `FENTARIS_AUTH_KEY=${input.authKey}`,
        `FENTARIS_GUEST_API_KEY=${input.guestApiKey}`,
        `FENTARIS_ADMIN_API_KEY=${input.adminApiKey}`,
        `FENTARIS_PORT=${input.port}`,
        `FENTARIS_PATH=${input.proxyPath}`,
        "",
      ].join("\n"),
      ".gitignore": [
        "node_modules/",
        "dist/",
        ".env",
        ".env.*",
        "!.env.example",
        ".fentaris/",
        ".fentaris/build/",
        "*.log",
        "",
      ].join("\n"),
      "src/index.ts": renderEntrypoint(input),
      "demo-files/README.md": "# Fentaris demo files\n\nThis directory is intentionally scoped for the demo filesystem MCP server.\n",
    },
  };
}

export function renderEntrypoint(input: TemplateInput): string {
  return `import {
  MemoryRateLimitStore,
  SlidingWindowRateLimiter,
  credentialJson,
  fentaris,
  group,
  mcp,
  policy,
  rateLimitMiddleware,
  stdio,
  streamableHttp,
  user,
} from "@fentaris/core";

const port = Number(process.env.FENTARIS_PORT ?? ${input.port});
const proxyPath = process.env.FENTARIS_PATH ?? "${input.proxyPath}";

const guest = user("guest", {
  displayName: "Guest Demo User",
  apiKeys: [credentialJson("users.guest.apiKeys.0")],
});
const admin = user("admin", {
  displayName: "Admin Demo User",
  apiKeys: [credentialJson("users.admin.apiKeys.0")],
});

const limitedPolicy = policy("limited-demo")
  .mcp("demo-files")
  .allow("list_allowed_directories")
  .mcp("demo-files")
  .allow("list_directory")
  .mcp("specification")
  .allow("*");

const adminPolicy = policy("admin-full-access").mcp("*").allow("*");

const limiter = new SlidingWindowRateLimiter({
  store: new MemoryRateLimitStore(),
  maxPerWindow: 30,
  windowMs: 60_000,
});

const app = fentaris({
  port,
  path: proxyPath,
  groups: [
    group({ id: "limited", users: [guest], policy: limitedPolicy }),
    group({ id: "admins", users: [admin], policy: adminPolicy }),
  ],
  servers: [
    mcp("demo-files", {
      transport: stdio({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "./demo-files"],
      }),
    }),
    mcp("specification", {
      transport: streamableHttp({
        url: "${remoteMcpUrl}",
      }),
    }),
  ],
});

// Global middleware runs before requests are forwarded to upstream MCP servers.
app.use(rateLimitMiddleware({ limiter }));

app.mcp("demo-files").use((ctx, next) => {
  console.log(\`demo-files -> \${ctx.operation}\`);
  return next();
});

app.mcp("specification").on("tool:success", ({ ctx }) => {
  console.log(\`specification -> \${ctx.tool?.name ?? ctx.operation}\`);
});

await app.start(() => {
  console.log(\`Fentaris proxy listening at http://localhost:\${port}\${proxyPath}\`);
  console.log("Use x-fentaris-api-key with the generated guest or admin key.");
});
`;
}

export async function writeTemplate(targetDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

export async function initTemplateAuth(dir: string, key: string, guestApiKey: string, adminApiKey: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeCredentials(dir, key, {
    users: {
      guest: { apiKeys: [FentarisAuth.hashApiKey(guestApiKey)], credentials: {} },
      admin: { apiKeys: [FentarisAuth.hashApiKey(adminApiKey)], credentials: {} },
    },
    groups: { limited: {} },
    defaults: {},
  });
}

function renderReadme(input: TemplateInput): string {
  return `# ${input.projectName}

This project was generated by the Fentaris CLI. It starts a local MCP proxy with:

- API-key authentication backed by encrypted credentials in \`.fentaris/credentials.enc.json\`
- A limited \`guest\` user and an unrestricted \`admin\` user
- A local filesystem demo server mounted as \`demo-files\`
- A remote HTTP MCP server mounted as \`specification\`
- A sliding-window rate limiter installed as global middleware

## Quick start

\`\`\`sh
${input.packageManager} install
cp .env.example .env
${input.packageManager} dev
\`\`\`

The proxy listens on \`http://localhost:${input.port}${input.proxyPath}\` by default. Send requests with the \`x-fentaris-api-key\` header using one of the keys printed by \`fentaris init\`.

## Project files

- \`src/index.ts\` configures the proxy, users, policies, middleware, and upstream MCP servers.
- \`fentaris.json\` is used by \`fentaris check\`, \`fentaris dev\`, and \`fentaris build\`.
- \`.fentaris/credentials.enc.json\` stores encrypted local credentials and is intentionally ignored by git.
- \`demo-files\` is the sandboxed directory exposed by the demo filesystem server.

## Useful commands

\`\`\`sh
fentaris check --offline
fentaris secrets set github.token --user admin
fentaris build
\`\`\`
`;
}
