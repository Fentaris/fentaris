import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { serverOf } from "../catalog.js";
import { ClientError } from "../errors.js";
import { listOption, stringOption, type CommandContext } from "../framework.js";
import { table, truncate, type CommandResult } from "../output.js";
import type { Session } from "../session.js";
import { argumentPairs, paginate, quote, usingSession, withCursor } from "./shared.js";

async function listPrompts(session: Session): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.client.listPrompts(cursor ? { cursor } : undefined, session.options);
    prompts.push(...page.prompts);
    cursor = page.nextCursor;
  } while (cursor);
  return prompts;
}

export function promptsList(context: CommandContext): Promise<CommandResult> {
  const server = stringOption(context.options, "mcp");
  return usingSession(context, async (session) => {
    const prompts = (await listPrompts(session)).filter((prompt) => !server || serverOf(prompt.name) === server);
    const { page, pagination } = paginate(context, prompts, 50);
    return {
      data: { prompts: page.map((prompt) => ({ ...prompt, server: serverOf(prompt.name) ?? null })) },
      pagination,
      nextActions: [
        ...(page[0] ? [{ description: "Get this prompt", command: `frs prompts get ${page[0].name}${(page[0].arguments ?? []).filter((arg) => arg.required).map((arg) => ` --arg ${arg.name}=<VALUE>`).join("")}` }] : []),
        ...(pagination.nextCursor ? [{ description: "Show the next page", command: withCursor(`frs prompts list${server ? ` --mcp ${quote(server)}` : ""} --limit ${pagination.limit}`, pagination.nextCursor) }] : []),
      ],
      human: () => page.length ? table(page.map((prompt) => [prompt.name, (prompt.arguments ?? []).map((arg) => `${arg.name}${arg.required ? "" : "?"}`).join(", "), truncate(prompt.description ?? prompt.title ?? "", 60)]), ["PROMPT", "ARGUMENTS", "DESCRIPTION"]) : "No prompts are visible to this identity.",
    };
  });
}

export function promptsGet(context: CommandContext): Promise<CommandResult> {
  const name = context.args[0]!;
  const args = argumentPairs(listOption(context.options, "arg"), false) as Record<string, string>;
  return usingSession(context, async (session) => {
    const prompt = (await listPrompts(session)).find((candidate) => candidate.name === name);
    if (!prompt) throw new ClientError("NOT_FOUND", `Prompt "${name}" is not visible to this identity.`, { prompt: name }, [{ description: "List visible prompts", command: "frs prompts list" }]);
    const missing = (prompt.arguments ?? []).filter((arg) => arg.required && !(arg.name in args)).map((arg) => arg.name);
    if (missing.length) throw new ClientError("INVALID_ARGUMENTS", `Missing required prompt argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`, { missing }, [{ description: "Supply the required arguments", command: `frs prompts get ${name}${missing.map((arg) => ` --arg ${arg}=<VALUE>`).join("")}` }]);
    const result = await session.client.getPrompt({ name, arguments: args }, session.options);
    return {
      data: { name, ...(result.description ? { description: result.description } : {}), messages: result.messages },
      human: () => [
        ...(result.description ? [result.description, ""] : []),
        ...result.messages.map((message) => `[${message.role}] ${message.content.type === "text" ? message.content.text : `<${message.content.type}>`}`),
      ].join("\n"),
    };
  });
}
