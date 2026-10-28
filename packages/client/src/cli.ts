import { authLogin, authLogout, authStatus } from "./commands/auth.js";
import { profileList, profileRemove, profileUse } from "./commands/profile.js";
import { promptsGet, promptsList } from "./commands/prompts.js";
import { resourcesList, resourcesRead, resourcesTemplates } from "./commands/resources.js";
import { toolsCall, toolsGet, toolsList, toolsSchema, toolsSearch } from "./commands/tools.js";
import type { CommandSpec, OptionSpec } from "./framework.js";

const mcp: OptionSpec = { name: "mcp", value: "SERVER", description: "Only include one MCP server (the prefix before \"__\")." };
const limit = (fallback: number): OptionSpec => ({ name: "limit", value: "COUNT", description: `Maximum results (1-500). [default: ${fallback}]` });
const cursor: OptionSpec = { name: "cursor", value: "CURSOR", description: "Continue from the nextCursor of a previous page." };

export const ROOT: CommandSpec = {
  name: "frs",
  path: [],
  summary: "Fentaris client",
  description: "Sign in to a Fentaris proxy and use the MCP tools, resources, and prompts it grants you.\nEvery operation runs through the proxy's policy, approval, credential, and audit pipeline.",
  usage: "frs <command> [options]",
  examples: ["frs auth login https://proxy.example/mcp", "frs tools search \"issue\" --json", "frs tools call github__create_issue --args '{\"title\":\"Bug\"}' --json"],
  children: [
    {
      name: "auth", path: ["auth"], summary: "Sign in to a proxy, inspect the session, or sign out.", usage: "frs auth <command> [options]",
      children: [
        {
          name: "login", path: ["auth", "login"], summary: "Sign in to a Fentaris proxy with OAuth or an API key.",
          description: "Sign in to a Fentaris proxy. Without --with-api-key the CLI uses OAuth 2.1 with PKCE, discovered from the proxy's protected resource metadata, and a loopback redirect on 127.0.0.1.",
          usage: "frs auth login [<url>] [options]",
          args: [{ name: "url", description: "Proxy MCP endpoint, for example https://proxy.example/mcp. Defaults to the selected profile's URL." }],
          options: [
            { name: "with-api-key", description: "Read a Fentaris API key from standard input instead of using OAuth." },
            { name: "api-key-header", value: "HEADER", description: "Request header for the API key. [default: x-fentaris-api-key]" },
            { name: "client-id", value: "ID", description: "OAuth client ID registered for the CLI; overrides the proxy hint." },
            { name: "scope", value: "SCOPES", description: "Space- or comma-separated OAuth scopes to request." },
            { name: "port", value: "PORT", description: "Fixed loopback callback port, for clients registered with a fixed redirect URI." },
            { name: "print-url", description: "Print the authorization URL instead of opening a browser." },
          ],
          examples: ["frs auth login https://proxy.example/mcp", "printf '%s' \"$KEY\" | frs auth login https://proxy.example/mcp --with-api-key", "frs auth login https://proxy.example/mcp --profile team --print-url"],
          run: authLogin,
        },
        { name: "status", path: ["auth", "status"], summary: "Show the active proxy, method, and a live credential check.", usage: "frs auth status [options]", examples: ["frs auth status --json"], run: authStatus },
        { name: "logout", path: ["auth", "logout"], summary: "Delete the stored credentials of a profile.", usage: "frs auth logout [options]", examples: ["frs auth logout --profile team"], run: authLogout },
      ],
    },
    {
      name: "tools", path: ["tools"], summary: "Discover, inspect, and call MCP tools.", usage: "frs tools <command> [options]",
      children: [
        { name: "list", path: ["tools", "list"], summary: "List the tools visible to you.", usage: "frs tools list [options]", options: [mcp, limit(50), cursor, { name: "compact", description: "Return only name, server, and a short description." }], examples: ["frs tools list --mcp github --limit 20 --json"], run: toolsList },
        { name: "search", path: ["tools", "search"], summary: "Search tools by name, title, or description.", usage: "frs tools search <query> [options]", args: [{ name: "query", required: true, description: "Short keywords, for example \"issue\"." }], options: [mcp, limit(10), cursor], examples: ["frs tools search \"create issue\" --json"], run: toolsSearch },
        { name: "get", path: ["tools", "get"], summary: "Show one tool and a summary of its arguments.", usage: "frs tools get <tool> [options]", args: [{ name: "tool", required: true, description: "Proxied tool name, for example github__create_issue." }], examples: ["frs tools get github__create_issue --json"], run: toolsGet },
        {
          name: "schema", path: ["tools", "schema"], summary: "Show a tool's input and/or output JSON schema.", usage: "frs tools schema <tool> [options]",
          args: [{ name: "tool", required: true, description: "Proxied tool name." }],
          options: [{ name: "input", description: "Return the input schema." }, { name: "output", description: "Return the output schema." }],
          examples: ["frs tools schema github__create_issue --input --json"], run: toolsSchema,
        },
        {
          name: "call", path: ["tools", "call"], summary: "Call a tool through the proxy.", usage: "frs tools call <tool> [options]",
          description: "Call a tool through the proxy. Policy, approvals, upstream credentials, rate limits, and audit apply. Approvals held by the proxy are awaited up to --timeout.",
          args: [{ name: "tool", required: true, description: "Proxied tool name, for example github__create_issue." }],
          options: [
            { name: "args", value: "JSON", description: "Arguments as a JSON object." },
            { name: "args-file", value: "PATH", description: "Read the JSON arguments from a file, or from stdin with \"-\"." },
            { name: "arg", value: "KEY=VALUE", repeatable: true, description: "One argument; the value is parsed as JSON when valid, otherwise kept as a string." },
            { name: "raw", description: "Print only the MCP call result as JSON." },
          ],
          examples: ["frs tools call github__create_issue --args '{\"title\":\"Bug\"}' --json", "frs tools call search__query --arg q=fentaris --arg limit=5", "jq -n '{title:\"Bug\"}' | frs tools call github__create_issue --args-file -"],
          run: toolsCall,
        },
      ],
    },
    {
      name: "resources", path: ["resources"], summary: "List and read MCP resources.", usage: "frs resources <command> [options]",
      children: [
        { name: "list", path: ["resources", "list"], summary: "List the resources visible to you.", usage: "frs resources list [options]", options: [mcp, limit(50), cursor], examples: ["frs resources list --mcp docs --json"], run: resourcesList },
        { name: "templates", path: ["resources", "templates"], summary: "List resource URI templates.", usage: "frs resources templates [options]", options: [mcp, limit(50), cursor], examples: ["frs resources templates --json"], run: resourcesTemplates },
        {
          name: "read", path: ["resources", "read"], summary: "Read one resource.", usage: "frs resources read <uri> [options]",
          args: [{ name: "uri", required: true, description: "Resource URI as returned by frs resources list." }],
          options: [{ name: "output-file", value: "PATH", description: "Write the decoded contents to a file (required for binary data in a terminal)." }],
          examples: ["frs resources read 'fentaris://resources/docs/file%3A%2F%2Freadme.md'", "frs resources read <uri> --output-file logo.png"], run: resourcesRead,
        },
      ],
    },
    {
      name: "prompts", path: ["prompts"], summary: "List and render MCP prompts.", usage: "frs prompts <command> [options]",
      children: [
        { name: "list", path: ["prompts", "list"], summary: "List the prompts visible to you.", usage: "frs prompts list [options]", options: [mcp, limit(50), cursor], examples: ["frs prompts list --json"], run: promptsList },
        {
          name: "get", path: ["prompts", "get"], summary: "Render one prompt with arguments.", usage: "frs prompts get <name> [options]",
          args: [{ name: "name", required: true, description: "Proxied prompt name, for example github__review." }],
          options: [{ name: "arg", value: "KEY=VALUE", repeatable: true, description: "Prompt argument (always a string)." }],
          examples: ["frs prompts get github__review --arg pr=12 --json"], run: promptsGet,
        },
      ],
    },
    {
      name: "profile", path: ["profile"], summary: "Manage saved proxy profiles.", usage: "frs profile <command> [options]",
      children: [
        { name: "list", path: ["profile", "list"], summary: "List saved profiles.", usage: "frs profile list [options]", examples: ["frs profile list --json"], run: profileList },
        { name: "use", path: ["profile", "use"], summary: "Make a profile the default.", usage: "frs profile use <name>", args: [{ name: "name", required: true, description: "Profile name." }], examples: ["frs profile use team"], run: profileUse },
        { name: "remove", path: ["profile", "remove"], summary: "Delete a profile and its stored credentials.", usage: "frs profile remove <name> [options]", args: [{ name: "name", required: true, description: "Profile name." }], options: [{ name: "yes", description: "Confirm without prompting." }], examples: ["frs profile remove team --yes"], run: profileRemove },
      ],
    },
  ],
};
