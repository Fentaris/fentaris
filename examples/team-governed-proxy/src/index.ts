import {
  credentialJson,
  fentaris,
  group,
  jsonConsoleLogger,
  mcp,
  policy,
  streamableHttp,
  user,
} from "@fentaris/core";

const readerPolicy = policy("readers")
  .mcp("specification")
  .allow("*")
  .mcp("workspace")
  .allow("status");

const maintainerPolicy = policy("maintainers")
  .mcp("specification")
  .allow("*")
  .mcp("workspace")
  .allow("status")
  .mcp("workspace")
  .allow("release_notes");

const app = fentaris({
  logger: jsonConsoleLogger(),
  autoLog: true,
  groups: [
    group({
      id: "readers",
      users: [
        user("reader", {
          displayName: "Read-only teammate",
          apiKeys: [credentialJson("users.reader.apiKeys.0")],
        }),
      ],
      policy: readerPolicy,
    }),
    group({
      id: "maintainers",
      users: [
        user("maintainer", {
          displayName: "Maintainer",
          apiKeys: [credentialJson("users.maintainer.apiKeys.0")],
        }),
      ],
      policy: maintainerPolicy,
    }),
  ],
  servers: [
    mcp("specification", {
      displayName: "Public MCP Specification",
      transport: streamableHttp({
        url: "https://mcp.specification.website/mcp",
      }),
    }),
  ],
});

app.local("workspace")
  .tool("status", { inputSchema: { type: "object", additionalProperties: false } }, (ctx) => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "ready",
        subject: ctx.subject?.id ?? "anonymous",
        groups: ctx.subject?.groups.map((member) => member.id) ?? [],
      }),
    }],
  }))
  .tool("release_notes", { inputSchema: { type: "object", additionalProperties: false } }, () => ({
    content: [{
      type: "text",
      text: "Release notes are visible to maintainers only.",
    }],
  }));

app.use((ctx, next) => {
  ctx.log.setTag("subject", ctx.subject?.id ?? "anonymous");
  ctx.log.setTag("groups", ctx.subject?.groups.map((member) => member.id).join(",") ?? "");
  return next();
});

await app.start();
