import { afterEach, describe, expect, it } from "vitest";
import { run, startProxy, tempDirectory, testRuntime } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("compact discovery proxies", () => {
  it("keeps the same identifiers for list, search, schema, and call", async () => {
    const proxy = await startProxy(cleanup, { discovery: { mode: "compact" } });
    const runtime = testRuntime(await tempDirectory(cleanup), { env: { FENTARIS_URL: proxy.url, FENTARIS_API_KEY: "alice-key" } });

    const list = await run(runtime, "tools", "list", "--mcp", "demo", "--json");
    expect(list.json.data.mode).toBe("compact");
    expect(list.json.data.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["demo__echo", "demo__fail", "demo__guarded", "demo__slow"]);
    const search = await run(runtime, "tools", "search", "echo", "--json");
    expect(search.json.data.tools[0].name).toBe("demo__echo");
    const schema = await run(runtime, "tools", "schema", "demo__echo", "--input", "--json");
    expect(schema.json.data.inputSchema).toMatchObject({ required: ["text"] });

    const call = await run(runtime, "tools", "call", "demo__echo", "--arg", "text=compact", "--json");
    expect(call.json.data.content).toEqual([{ type: "text", text: "compact" }]);
    expect(proxy.upstream.calls.at(-1)).toMatchObject({ name: "echo", arguments: { text: "compact" } });
    const hidden = await run(runtime, "tools", "call", "demo__danger", "--json");
    expect(hidden.code).toBe(4);
    expect(hidden.json.error.code).toBe("POLICY_DENIED");
  });
});
