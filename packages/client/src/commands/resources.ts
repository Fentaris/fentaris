import { writeFile } from "node:fs/promises";
import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import { ClientError, type NextAction } from "../errors.js";
import { stringOption, type CommandContext } from "../framework.js";
import { table, truncate, type CommandResult } from "../output.js";
import { paginate, quote, usingSession, withCursor } from "./shared.js";

const RESOURCE_PREFIX = "fentaris://resources/";
const TEMPLATE_PREFIX = "fentaris://resource-templates/";

/** Proxied URIs are fentaris://resources/<server>/<encoded upstream URI>. */
export function resourceServer(uri: string, prefix = RESOURCE_PREFIX): string | null {
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const separator = rest.indexOf("/");
  return separator > 0 ? decodeURIComponent(rest.slice(0, separator)) : null;
}

export function resourcesList(context: CommandContext): Promise<CommandResult> {
  const server = stringOption(context.options, "mcp");
  return usingSession(context, async (session) => {
    const resources: Resource[] = [];
    let cursor: string | undefined;
    do {
      const page = await session.client.listResources(cursor ? { cursor } : undefined, session.options);
      resources.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
    const visible = server ? resources.filter((resource) => resourceServer(resource.uri) === server) : resources;
    const { page, pagination } = paginate(context, visible, 50);
    const nextActions: NextAction[] = [];
    if (page[0]) nextActions.push({ description: "Read this resource", command: `frs resources read ${quote(page[0].uri)}` });
    if (pagination.nextCursor) nextActions.push({ description: "Show the next page", command: withCursor(`frs resources list${server ? ` --mcp ${quote(server)}` : ""} --limit ${pagination.limit}`, pagination.nextCursor) });
    return {
      data: { resources: page.map((resource) => ({ ...resource, server: resourceServer(resource.uri) })) },
      pagination,
      nextActions,
      human: () => page.length ? table(page.map((resource) => [resource.uri, truncate(resource.title ?? resource.name, 40), resource.mimeType ?? ""]), ["URI", "NAME", "TYPE"]) : "No resources are visible to this identity.",
    };
  });
}

export function resourcesTemplates(context: CommandContext): Promise<CommandResult> {
  const server = stringOption(context.options, "mcp");
  return usingSession(context, async (session) => {
    const templates: ResourceTemplate[] = [];
    let cursor: string | undefined;
    do {
      const page = await session.client.listResourceTemplates(cursor ? { cursor } : undefined, session.options);
      templates.push(...page.resourceTemplates);
      cursor = page.nextCursor;
    } while (cursor);
    const visible = server ? templates.filter((template) => resourceServer(template.uriTemplate, TEMPLATE_PREFIX) === server) : templates;
    const { page, pagination } = paginate(context, visible, 50);
    return {
      data: { resourceTemplates: page.map((template) => ({ ...template, server: resourceServer(template.uriTemplate, TEMPLATE_PREFIX) })) },
      pagination,
      nextActions: pagination.nextCursor ? [{ description: "Show the next page", command: withCursor(`frs resources templates${server ? ` --mcp ${quote(server)}` : ""} --limit ${pagination.limit}`, pagination.nextCursor) }] : [],
      human: () => page.length ? table(page.map((template) => [template.uriTemplate, truncate(template.title ?? template.name, 40)]), ["URI TEMPLATE", "NAME"]) : "No resource templates are visible to this identity.",
    };
  });
}

export function resourcesRead(context: CommandContext): Promise<CommandResult> {
  const uri = context.args[0]!;
  const outputFile = stringOption(context.options, "output-file");
  return usingSession(context, async (session) => {
    const { contents } = await session.client.readResource({ uri }, session.options);
    if (outputFile) {
      if (contents.length !== 1) throw new ClientError("INVALID_ARGUMENTS", `The resource has ${contents.length} content items; --output-file needs exactly one. Use --json to inspect them.`);
      const item = contents[0]!;
      const bytes = "blob" in item ? Buffer.from(item.blob, "base64") : Buffer.from(item.text, "utf8");
      await writeFile(outputFile, bytes);
      return { data: { uri, outputFile, mimeType: item.mimeType ?? null, bytes: bytes.length }, human: () => `Wrote ${bytes.length} bytes${item.mimeType ? ` (${item.mimeType})` : ""} to ${outputFile}.` };
    }
    if (context.global.json) return { data: { uri, contents } };
    const blobs = contents.filter((item) => "blob" in item);
    if (blobs.length) {
      if (context.runtime.stdoutIsTTY || contents.length !== 1) {
        throw new ClientError("INVALID_ARGUMENTS", "The resource contains binary data, which is not written to a terminal.", { uri }, [{ description: "Save the contents to a file", command: `frs resources read ${quote(uri)} --output-file <PATH>` }]);
      }
      context.runtime.writeBytes(Buffer.from((blobs[0] as { blob: string }).blob, "base64"));
      return { data: { uri, contents }, written: true };
    }
    return { data: { uri, contents }, human: () => contents.map((item) => ("text" in item ? item.text : "")).join("\n") };
  });
}
