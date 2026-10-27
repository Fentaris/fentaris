import { openCatalog, type Catalog } from "../catalog.js";
import { resolveConnection } from "../connection.js";
import { ClientError } from "../errors.js";
import { integerOption, stringOption, type CommandContext } from "../framework.js";
import type { Pagination } from "../output.js";
import { withSession, type Session } from "../session.js";

export const MAX_LIMIT = 500;

export async function usingSession<T>(context: CommandContext, run: (session: Session) => Promise<T>): Promise<T> {
  const connection = await resolveConnection(context.runtime, context.global);
  return withSession(context.runtime, connection, context.global, run);
}

export function usingCatalog<T>(context: CommandContext, run: (catalog: Catalog, session: Session) => Promise<T>): Promise<T> {
  return usingSession(context, async (session) => run(await openCatalog(session), session));
}

/** Client-side pagination with an opaque cursor that encodes the offset. */
export function paginate<T>(context: CommandContext, items: T[], defaultLimit: number): { page: T[]; pagination: Pagination } {
  const limit = integerOption(context.options, "limit", defaultLimit, MAX_LIMIT);
  const cursor = stringOption(context.options, "cursor") ?? null;
  let offset = 0;
  if (cursor !== null) {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^o:\d+$/.test(decoded)) throw new ClientError("INVALID_ARGUMENTS", "--cursor is not a cursor returned by a previous page.");
    offset = Number(decoded.slice(2));
  }
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return { page, pagination: { limit, cursor, nextCursor: next < items.length ? Buffer.from(`o:${next}`).toString("base64url") : null, total: items.length } };
}

/** Repeat the current command with a different cursor for next actions. */
export function withCursor(command: string, nextCursor: string): string {
  return `${command} --cursor ${nextCursor}`;
}

export function argumentPairs(pairs: string[], parseJson: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new ClientError("INVALID_ARGUMENTS", `--arg "${pair}" must use key=value.`);
    const key = pair.slice(0, separator);
    if (key in result) throw new ClientError("INVALID_ARGUMENTS", `--arg "${key}" was given more than once.`);
    const value = pair.slice(separator + 1);
    result[key] = parseJson ? parseLoose(value) : value;
  }
  return result;
}

function parseLoose(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

export function quote(value: string): string {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
