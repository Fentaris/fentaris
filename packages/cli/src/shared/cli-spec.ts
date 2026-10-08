export type CliOptionSpec = {
  name: string;
  short?: string;
  valueName?: string;
  description: string;
  repeatable?: boolean;
};

export type CliArgumentSpec = {
  name: string;
  required?: boolean;
  description: string;
};

export type CliCommandGroup = {
  title: string;
  commands: Array<{
    name: string;
    summary: string;
  }>;
};

export type CliCommandSpec = {
  name: string;
  path: string[];
  description: string;
  details?: string[];
  usage: string;
  allowNoSubcommand?: boolean;
  /** Complete recognized missing input at runtime; never correct unknown or invalid explicit options. */
  progressive?: boolean;
  commandGroups?: CliCommandGroup[];
  arguments?: CliArgumentSpec[];
  options?: CliOptionSpec[];
  environment?: Array<{
    name: string;
    description: string;
  }>;
  commands?: Record<string, CliCommandSpec>;
};

const globalOptions: CliOptionSpec[] = [
  { name: "help", short: "h", description: "Print help" },
  { name: "version", short: "v", description: "Print version" },
  { name: "non-interactive", description: "Fail instead of prompting for input. Use for automation and agent-driven runs." },
];

const localSecretsKeyOption: CliOptionSpec = {
  name: "key",
  valueName: "KEY",
  description: "Use an explicit local encryption key instead of FENTARIS_AUTH_KEY or an interactive prompt. Prefer FENTARIS_AUTH_KEY for automation.",
};

const edgeJsonOptions: CliOptionSpec[] = [
  { name: "json", description: "Output the canonical JSON envelope." },
  { name: "verbose", description: "Include additional human-readable diagnostics." },
  { name: "help", short: "h", description: "Print help" },
];

const edgeDiscoveryOptions: CliOptionSpec[] = [
  { name: "compact", description: "Return compact device fields." },
  { name: "limit", valueName: "COUNT", description: "Maximum devices to return (1-100)." },
  { name: "cursor", valueName: "CURSOR", description: "Continue from a prior inventory cursor." },
  { name: "include", valueName: "FIELDS", description: "Comma-separated optional fields to include." },
  { name: "exclude", valueName: "FIELDS", description: "Comma-separated optional fields to exclude." },
  { name: "as", valueName: "IDENTITY", description: "Calculate visibility and policy as user:<name> or group:<name>." },
  ...edgeJsonOptions,
];

const edgeCommandSpec: CliCommandSpec = {
  name: "edge",
  path: ["edge"],
  description: "Join, inspect, and operate governed Edge computers.",
  details: [
    "Join once, run persistently when supported, and manage only devices visible to the selected Fentaris identity.",
    "Alpha/preview: validate service lifecycle and recovery on every target OS before rollout; protocol, CLI, and local state formats may change before stable release.",
  ],
  usage: "fentaris edge [COMMAND]",
  commandGroups: [{
    title: "Commands",
    commands: [
      { name: "join", summary: "Enroll this computer and configure persistent operation." },
      { name: "approve", summary: "Approve an exact pending local Edge authorization code." },
      { name: "run", summary: "Run the enrolled Edge agent in the foreground." },
      { name: "service", summary: "Manage the local persistent Edge service." },
      { name: "list", summary: "List policy-visible Edge devices." },
      { name: "get", summary: "Inspect one policy-visible Edge device." },
      { name: "status", summary: "Show local or remote Edge status." },
      { name: "installation", summary: "Review and operate local managed MCP installations." },
      { name: "update", summary: "Update user-managed device metadata." },
      { name: "disconnect", summary: "Disconnect a device without revoking identity." },
      { name: "revoke", summary: "Revoke a device identity." },
    ],
  }],
  options: [{ name: "help", short: "h", description: "Print help" }],
  commands: {
    join: {
      name: "join", path: ["edge", "join"], description: "Enroll this computer and configure persistent Edge operation.",
      details: ["Example: fentaris edge join https://control.example --name 'Mac Studio' --tag xcode --json"],
      usage: "fentaris edge join [OPTIONS] <control-plane-url>",
      arguments: [{ name: "control-plane-url", required: true, description: "HTTPS control-plane URL." }],
      options: [
        { name: "name", valueName: "NAME", description: "Stable tenant-scoped public device name." },
        { name: "description", valueName: "TEXT", description: "User-managed device description." },
        { name: "tag", valueName: "TAG", repeatable: true, description: "Add a descriptive tag. Repeat for multiple tags." },
        { name: "service", description: "Require persistent service installation." },
        { name: "no-service", description: "Enroll without installing a persistent service." },
        ...edgeJsonOptions,
      ],
    },
    approve: {
      name: "approve", path: ["edge", "approve"], description: "Approve an exact pending Edge authorization through the protected local operator channel.",
      details: ["Example: fentaris edge approve ABCD-EFGH --subject alice --tenant default --yes --json"],
      usage: "fentaris edge approve [OPTIONS] <user-code>",
      arguments: [{ name: "user-code", required: true, description: "Exact short-lived code displayed by the joining Edge." }],
      options: [
        { name: "subject", valueName: "SUBJECT", description: "Required Fentaris subject receiving the device grant." },
        { name: "tenant", valueName: "TENANT", description: "Tenant of the pending authorization. [default: default]" },
        { name: "actor", valueName: "ACTOR", description: "Auditable local operator identity. [default: current OS user]" },
        { name: "yes", description: "Confirm this exact approval without prompting." },
        ...edgeJsonOptions,
      ],
    },
    run: {
      name: "run", path: ["edge", "run"], description: "Run the enrolled Edge agent in the foreground.",
      usage: "fentaris edge run [OPTIONS]", options: edgeJsonOptions,
    },
    service: {
      name: "service", path: ["edge", "service"], description: "Manage the local persistent Edge service.",
      usage: "fentaris edge service <install|start|stop|restart|uninstall> [OPTIONS]",
      commandGroups: [{ title: "Commands", commands: ["install", "start", "stop", "restart", "uninstall"].map((name) => ({ name, summary: `${name[0]!.toUpperCase()}${name.slice(1)} the local Edge service.` })) }],
      options: [{ name: "help", short: "h", description: "Print help" }],
      commands: Object.fromEntries(["install", "start", "stop", "restart", "uninstall"].map((name) => [name, {
        name, path: ["edge", "service", name], description: `${name[0]!.toUpperCase()}${name.slice(1)} the local Edge service.`,
        usage: `fentaris edge service ${name} [OPTIONS]`, options: edgeJsonOptions,
      }])) as Record<string, CliCommandSpec>,
    },
    list: {
      name: "list", path: ["edge", "list"], description: "List policy-visible Edge devices.",
      details: ["Example: fentaris edge list --as user:alice --compact --limit 20 --json"],
      usage: "fentaris edge list [OPTIONS]", options: edgeDiscoveryOptions,
    },
    get: {
      name: "get", path: ["edge", "get"], description: "Inspect one policy-visible Edge device.",
      usage: "fentaris edge get [OPTIONS] <device>",
      arguments: [{ name: "device", required: true, description: "Public device name." }], options: edgeDiscoveryOptions,
    },
    status: {
      name: "status", path: ["edge", "status"], description: "Show local or policy-visible remote Edge status.",
      usage: "fentaris edge status [OPTIONS] [device]",
      arguments: [{ name: "device", description: "Public remote device name; omit for the local installation." }], options: edgeDiscoveryOptions,
    },
    installation: {
      name: "installation", path: ["edge", "installation"], description: "Review and operate managed MCP installations through the protected local Edge channel.",
      details: ["Examples: fentaris edge installation status --json; fentaris edge installation review filesystem --json; fentaris edge installation approve filesystem --yes --json"],
      usage: "fentaris edge installation <status|review|approve|deny|retry|revoke|cleanup> [deployment-id] [OPTIONS]",
      commandGroups: [{ title: "Commands", commands: [
        { name: "status", summary: "Show separated installation, setup, workload, and readiness state." },
        { name: "review", summary: "Display bounded exact installer review material." },
        { name: "approve", summary: "Approve the exact current installer plan locally." },
        { name: "deny", summary: "Deny the exact current installer plan locally." },
        { name: "retry", summary: "Retry one retryable failed installation with a new attempt." },
        { name: "revoke", summary: "Revoke local installation approval and stop dependent workloads." },
        { name: "cleanup", summary: "Remove managed artifacts; custom external cleanup needs separate approval." },
      ] }],
      options: [{ name: "help", short: "h", description: "Print help" }],
      commands: Object.fromEntries(["status", "review", "approve", "deny", "retry", "revoke", "cleanup"].map((name) => [name, {
        name, path: ["edge", "installation", name], description: `${name[0]!.toUpperCase()}${name.slice(1)} a managed installation.`,
        usage: `fentaris edge installation ${name} ${name === "status" ? "[deployment-id]" : "<deployment-id>"} [OPTIONS]`,
        arguments: [{ name: "deployment-id", required: name !== "status", description: "Explicit desired deployment ID." }],
        options: [
          ...(["approve", "deny", "retry", "revoke", "cleanup"].includes(name) ? [{ name: "yes", description: "Confirm the local mutation without prompting." }] : []),
          ...(["review", "approve", "deny"].includes(name) ? [{ name: "cleanup", description: "Target the separately reviewed custom cleanup plan." }] : []),
          ...edgeJsonOptions,
        ],
      }])) as Record<string, CliCommandSpec>,
    },
    update: {
      name: "update", path: ["edge", "update"], description: "Update user-managed Edge device metadata.",
      usage: "fentaris edge update [OPTIONS] <device>",
      arguments: [{ name: "device", required: true, description: "Public device name." }],
      options: [
        { name: "expected-version", valueName: "VERSION", description: "Required current inventory version for optimistic updates." },
        { name: "name", valueName: "NAME", description: "New public device name." },
        { name: "description", valueName: "TEXT", description: "New user-managed description." },
        { name: "tag", valueName: "TAG", repeatable: true, description: "Replace tags with this repeatable set." },
        ...edgeJsonOptions,
      ],
    },
    disconnect: {
      name: "disconnect", path: ["edge", "disconnect"], description: "Disconnect an Edge device without revoking its identity.",
      usage: "fentaris edge disconnect [OPTIONS] <device>",
      arguments: [{ name: "device", required: true, description: "Explicit public device name." }],
      options: [{ name: "yes", description: "Confirm the disconnect without prompting." }, ...edgeJsonOptions],
    },
    revoke: {
      name: "revoke", path: ["edge", "revoke"], description: "Revoke an Edge device identity.",
      usage: "fentaris edge revoke [OPTIONS] <device>",
      arguments: [{ name: "device", required: true, description: "Explicit public device name." }],
      options: [{ name: "yes", description: "Confirm revocation without prompting." }, ...edgeJsonOptions],
    },
  },
};

const mcpReadOptions: CliOptionSpec[] = [
  { name: "json", description: "Output stable JSON without prompts or terminal progress." },
  { name: "offline", description: "Read configuration and cached metadata; remote status remains unverified." },
  { name: "account", valueName: "ALIAS", description: "Select a named upstream account; never a downstream user selector." },
  { name: "timeout", valueName: "MS", description: "Per-connection live-check deadline (1-60000 ms). [default: 5000]" },
  { name: "help", short: "h", description: "Print help" },
];
const mcpAuthOptions: CliOptionSpec[] = [
  ...mcpReadOptions.filter((option) => option.name !== "offline"),
  { name: "secret", valueName: "REFERENCE", description: "Reuse an existing named secret without copying its value." },
  { name: "credential", valueName: "SLOT=REFERENCE", repeatable: true, description: "Reuse a named secret for a configured bearer/header/environment slot; repeat for a credential bundle." },
  { name: "reauth", description: "Explicitly reauthorize an already connected account." },
  { name: "print-url", description: "Print the browser authorization URL to stderr." },
  { name: "port", valueName: "PORT", description: "Loopback OAuth callback port (0 selects an available port)." },
  { name: "from-session", valueName: "SESSION", description: "Explicit legacy OAuth session to copy during migration." },
  localSecretsKeyOption,
];
const mcpCommandSpec: CliCommandSpec = {
  name: "mcp", path: ["mcp"], progressive: true, allowNoSubcommand: true,
  description: "Inspect configured MCPs and named upstream connections without a downstream identity.",
  usage: "fentaris mcp [OPTIONS] [COMMAND]",
  details: ["Inventory includes failing and unconfigured connections. Exit codes: 0 success/offline, 3 partial live discovery, 1 failure, 2 invalid input.", "Example: fentaris mcp get gmail --account gabry848"],
  commandGroups: [{ title: "Commands", commands: [{ name: "get", summary: "Inspect MCP configuration, accounts, authentication, and connectivity." }, { name: "tools", summary: "Discover tools grouped by MCP and account." }, { name: "auth", summary: "Manage upstream authentication, independently of incoming users." }] }],
  options: mcpReadOptions,
  commands: {
    get: { name: "get", path: ["mcp", "get"], progressive: true, description: "Inspect a configured MCP and its connections.", usage: "fentaris mcp get [MCP] [OPTIONS]", arguments: [{ name: "MCP", description: "Configured server name." }], options: mcpReadOptions },
    tools: { name: "tools", path: ["mcp", "tools"], progressive: true, allowNoSubcommand: true, description: "Discover all connections, optionally filtered to one MCP/account.", usage: "fentaris mcp tools [MCP] [OPTIONS] [COMMAND]", arguments: [{ name: "MCP", description: "Optional MCP filter." }], options: mcpReadOptions,
      commandGroups: [{ title: "Commands", commands: [{ name: "get", summary: "Inspect one proxied tool on a selected connection." }, { name: "schema", summary: "Inspect input/output schemas." }] }],
      commands: {
        get: { name: "get", path: ["mcp", "tools", "get"], progressive: true, description: "Inspect one tool.", usage: "fentaris mcp tools get [TOOL] [OPTIONS]", arguments: [{ name: "TOOL", description: "Proxied name, for example gmail__search_messages." }], options: mcpReadOptions },
        schema: { name: "schema", path: ["mcp", "tools", "schema"], progressive: true, description: "Inspect one tool schema.", usage: "fentaris mcp tools schema [TOOL] [OPTIONS]", arguments: [{ name: "TOOL", description: "Proxied tool name." }], options: [...mcpReadOptions, { name: "input", description: "Return the input schema." }, { name: "output", description: "Return the output schema." }] },
      },
    },
    auth: { name: "auth", path: ["mcp", "auth"], progressive: true, allowNoSubcommand: true, description: "Inspect or explicitly connect/disconnect upstream accounts.", usage: "fentaris mcp auth [COMMAND] [OPTIONS]", options: mcpReadOptions,
      commandGroups: [{ title: "Commands", commands: [{ name: "get", summary: "Inspect selected account authentication." }, { name: "connect", summary: "Complete the appropriate upstream authentication flow." }, { name: "disconnect", summary: "Disconnect one account and preserve shared secrets." }, { name: "migrate", summary: "Explicitly copy a legacy OAuth session into an upstream account." }] }],
      commands: Object.fromEntries(["get", "connect", "disconnect", "migrate"].map((action) => [action, {
        name: action, path: ["mcp", "auth", action], progressive: true, description: `${action[0].toUpperCase()}${action.slice(1)} upstream account authentication.`, usage: `fentaris mcp auth ${action} [MCP] [OPTIONS]`, arguments: [{ name: "MCP", description: "Configured server name." }], options: action === "get" ? mcpReadOptions : mcpAuthOptions,
      }])),
    },
  },
};

export const cliSpec: CliCommandSpec = {
  name: "fentaris",
  path: [],
  description: "Fentaris MCP proxy toolkit",
  details: [
    "The Fentaris CLI creates and operates local MCP proxy projects.",
    "It includes project scaffolding, health checks, local development helpers, and secret manifest tooling.",
  ],
  usage: "fentaris [OPTIONS] [COMMAND]",
  commandGroups: [
    {
      title: "Project",
      commands: [
        { name: "init", summary: "Create a new Fentaris project." },
        { name: "dev", summary: "Run the discovered project in development mode." },
        { name: "build", summary: "Build a deterministic local artifact." },
      ],
    },
    {
      title: "Health",
      commands: [
        { name: "check", summary: "Run project checks." },
        { name: "doctor", summary: "Run environment and project diagnostics." },
      ],
    },
    {
      title: "Secrets",
      commands: [
        { name: "auth", summary: "Manage local identity authentication." },
        { name: "secrets", summary: "Manage local credentials and secret manifests." },
        { name: "mcp", summary: "Inspect MCP connections, tools, and upstream authentication." },
        { name: "edge", summary: "Join and operate governed Edge computers." },
      ],
    },
  ],
  options: globalOptions,
  environment: [
    { name: "FENTARIS_AUTH_KEY", description: "Encryption key used by the local secrets backend." },
    { name: "FENTARIS_EDGE_STATE_DIR", description: "Absolute directory for local Edge identity and runtime state." },
  ],
  commands: {
    edge: edgeCommandSpec,
    init: {
      name: "init",
      path: ["init"],
      description: "Create a new Fentaris project.",
      details: ["Creates a project template, installs dependencies unless disabled, optionally initializes git, and runs diagnostics."],
      usage: "fentaris init [OPTIONS] [project-name]",
      arguments: [{ name: "project-name", description: "Directory and package name for the new project." }],
      options: [
        { name: "template", valueName: "NAME", description: "Boilerplate to generate: local or team. [default: local]" },
        { name: "package-manager", valueName: "PM", description: "Package manager written to the generated project. Supported values: pnpm, npm, bun." },
        { name: "skip-install", description: "Skip dependency installation." },
        { name: "skip-git", description: "Skip git repository initialization." },
        { name: "port", valueName: "PORT", description: "Port written to fentaris.json. [default: 4000]" },
        { name: "path", valueName: "PATH", description: "MCP route path written to fentaris.json. [default: /mcp]" },
        { name: "core-version", valueName: "RANGE", description: "Version range for @fentaris/core in the generated package.json. Accepts semver ranges (^3.0.0), dist tags (latest), and workspace/file references (workspace:*, file:../packages/core). [default: ^3.0.0]" },
        { name: "non-interactive", description: "Fail instead of prompting for missing project inputs. Use for automation and agent-driven runs." },
        { name: "help", short: "h", description: "Print help" },
      ],
    },
    dev: {
      name: "dev",
      path: ["dev"],
      description: "Run the discovered project in development mode.",
      usage: "fentaris dev [OPTIONS]",
      options: [{ name: "help", short: "h", description: "Print help" }],
    },
    build: {
      name: "build",
      path: ["build"],
      description: "Build a deterministic local artifact.",
      usage: "fentaris build [OPTIONS]",
      options: [{ name: "help", short: "h", description: "Print help" }],
    },
    check: {
      name: "check",
      path: ["check"],
      description: "Run project checks.",
      usage: "fentaris check [OPTIONS]",
      options: [
        { name: "offline", description: "Skip checks that require local external services." },
        { name: "strict", description: "Treat warnings as failures." },
        { name: "json", description: "Output project checks as JSON." },
        { name: "verbose", description: "List passed checks in addition to issues." },
        { name: "help", short: "h", description: "Print help" },
      ],
    },
    doctor: {
      name: "doctor",
      path: ["doctor"],
      description: "Run environment and project diagnostics.",
      usage: "fentaris doctor [OPTIONS]",
      options: [
        { name: "fix", description: "Apply available automatic fixes." },
        { name: "strict", description: "Treat warnings as failures." },
        { name: "json", description: "Output diagnostics as JSON." },
        { name: "verbose", description: "List passed checks in addition to issues." },
        { name: "runtime", description: "Include runtime connectivity checks." },
        { name: "timeout", valueName: "MS", description: "Runtime check timeout in milliseconds. [default: 10000]" },
        { name: "help", short: "h", description: "Print help" },
      ],
    },
    auth: {
      name: "auth",
      path: ["auth"],
      description: "Manage local identity authentication.",
      usage: "fentaris auth [OPTIONS] [COMMAND]",
      allowNoSubcommand: true,
      details: ["Omit the command to open an interactive menu for adding, listing, or removing local API keys."],
      commandGroups: [
        {
          title: "Commands",
          commands: [
            { name: "api-key", summary: "Manage API keys for local user identity." },
            { name: "login", summary: "Sign in to an OAuth-protected upstream MCP server." },
            { name: "status", summary: "Show stored upstream OAuth authorizations." },
            { name: "logout", summary: "Remove a stored upstream OAuth authorization." },
          ],
        },
      ],
      options: [
        localSecretsKeyOption,
        { name: "help", short: "h", description: "Print help" },
      ],
      commands: {
        login: {
          name: "login",
          path: ["auth", "login"],
          description: "Sign in to an OAuth-protected upstream MCP server declared with oauth().",
          usage: "fentaris auth login [OPTIONS] <mcp>",
          details: [
            "Opens the authorization URL in a browser and completes the flow on a loopback redirect owned by this command.",
            "Use --print-url or --non-interactive in automation and on headless machines; neither spawns a browser.",
            "The command waits for the redirect callback and gives up after --timeout seconds (300 by default).",
            "Tokens are written to the project's encrypted OAuth store and picked up by a running proxy without a restart.",
          ],
          arguments: [{ name: "mcp", required: true, description: "Name of the OAuth-protected MCP server." }],
          options: [
            { name: "as", valueName: "SELECTOR", description: "Authorize as a specific subject, for example user:alice. Omit for the shared authorization." },
            { name: "print-url", description: "Print the authorization URL instead of opening a browser." },
            { name: "port", valueName: "PORT", description: "Fixed loopback redirect port. Required for pre-registered clients with a fixed redirect URI." },
            { name: "timeout", valueName: "SECONDS", description: "Stop waiting for the authorization callback after this many seconds. [default: 300]" },
            { name: "json", description: "Output the canonical machine-readable login envelope." },
            localSecretsKeyOption,
            { name: "help", short: "h", description: "Print help" },
          ],
        },
        status: {
          name: "status",
          path: ["auth", "status"],
          description: "Show stored upstream OAuth authorizations for this project.",
          usage: "fentaris auth status [OPTIONS] [mcp]",
          arguments: [{ name: "mcp", description: "Limit output to one MCP server." }],
          options: [
            { name: "as", valueName: "SELECTOR", description: "Inspect one subject, for example user:alice." },
            { name: "json", description: "Output the canonical machine-readable status envelope." },
            localSecretsKeyOption,
            { name: "help", short: "h", description: "Print help" },
          ],
        },
        logout: {
          name: "logout",
          path: ["auth", "logout"],
          description: "Remove a stored upstream OAuth authorization.",
          usage: "fentaris auth logout [OPTIONS] <mcp>",
          arguments: [{ name: "mcp", required: true, description: "Name of the OAuth-protected MCP server." }],
          options: [
            { name: "as", valueName: "SELECTOR", description: "Remove one subject's authorization, for example user:alice." },
            { name: "json", description: "Output the canonical machine-readable logout envelope." },
            localSecretsKeyOption,
            { name: "help", short: "h", description: "Print help" },
          ],
        },
      },
    },
    secrets: {
      name: "secrets",
      path: ["secrets"],
      description: "Manage local credentials and secret manifests.",
      usage: "fentaris secrets [OPTIONS] [COMMAND]",
      commandGroups: [
        {
          title: "Commands",
          commands: [
            { name: "set", summary: "Store a local credential value." },
            { name: "setup", summary: "Configure all discovered project credentials." },
            { name: "list", summary: "List required and stored credentials." },
            { name: "unset", summary: "Remove a local credential value." },
            { name: "manifest", summary: "Generate or check the secrets manifest." },
            { name: "doctor", summary: "Run secret-specific diagnostics." },
          ],
        },
      ],
      options: [{ name: "help", short: "h", description: "Print help" }],
      commands: {
        setup: {
          name: "setup",
          path: ["secrets", "setup"],
          description: "Discover and configure all required project credentials.",
          usage: "fentaris secrets setup [OPTIONS]",
          details: [
            "Generates missing Fentaris API keys, prompts for external values in interactive mode, and writes only after the setup plan is complete.",
            "JSON and non-interactive runs never prompt and make no changes while required external values are unavailable.",
          ],
          options: [
            { name: "entrypoint", valueName: "PATH", description: "Entrypoint to scan instead of the configured project entrypoint." },
            { name: "dry-run", description: "Show the setup plan without creating keys or changing files." },
            { name: "yes", description: "Apply the setup plan without confirmation." },
            { name: "json", description: "Output the canonical machine-readable setup envelope." },
            localSecretsKeyOption,
            { name: "help", short: "h", description: "Print help" },
          ],
        },
        manifest: {
          name: "manifest",
          path: ["secrets", "manifest"],
          description: "Generate or check the secrets manifest.",
          usage: "fentaris secrets manifest [OPTIONS]",
          options: [
            { name: "entrypoint", valueName: "PATH", description: "Entrypoint to scan when no fentaris.json is present or when overriding project config." },
            { name: "check", description: "Fail if secrets.manifest.json is missing or out of date." },
            { name: "help", short: "h", description: "Print help" },
          ],
        },
        doctor: {
          name: "doctor",
          path: ["secrets", "doctor"],
          description: "Run secret-specific diagnostics.",
          usage: "fentaris secrets doctor [OPTIONS]",
          options: [
            { name: "strict", description: "Treat warnings as failures." },
            { name: "json", description: "Output diagnostics as JSON." },
            localSecretsKeyOption,
            { name: "help", short: "h", description: "Print help" },
          ],
        },
      },
    },
    mcp: mcpCommandSpec,

  },
};

// #298 command contract. #297 can mark its MCP specs progressive to use the same parser.
const vaultReadOptions: CliOptionSpec[] = [{ name: "json", description: "Machine-readable metadata; never prompt." }, { name: "offline", description: "Inspect local resolution only; remote validity is unverified." }, { name: "help", short: "h", description: "Print help" }];
const keyCommands: Record<string, CliCommandSpec> = Object.fromEntries(["create", "list", "revoke"].map((action) => [action, {
  name: action, path: ["auth", "keys", action], progressive: true,
  description: `${action[0]!.toUpperCase()}${action.slice(1)} named incoming client keys.`, usage: `fentaris auth keys ${action} [OPTIONS]${action === "revoke" ? " [key-id]" : ""}`,
  ...(action === "revoke" ? { arguments: [{ name: "key-id", description: "Stable key ID, never its secret value." }] } : {}),
  options: [...(action === "revoke" ? [] : [{ name: "user", valueName: "USER", description: "Incoming identity, distinct from upstream account aliases." }]),
    ...(action === "create" ? [{ name: "name", valueName: "NAME", description: "Name of this incoming key." }, { name: "expires", valueName: "TIMESTAMP", description: "Optional future ISO 8601 UTC expiry." }] : []), ...vaultReadOptions.filter((option) => action === "list" || option.name !== "offline")],
}]));
cliSpec.commands!.auth!.allowNoSubcommand = true;
cliSpec.commands!.auth!.description = "Manage incoming client identities and named access keys.";
cliSpec.commands!.auth!.options = vaultReadOptions;
cliSpec.commands!.auth!.commandGroups = [{ title: "Commands", commands: [{ name: "keys", summary: "Create, list, and revoke incoming keys by ID." }] }];
cliSpec.commands!.auth!.commands!.keys = { name: "keys", path: ["auth", "keys"], description: "Manage incoming client keys. Choose an explicit action interactively.", usage: "fentaris auth keys [create|list|revoke] [OPTIONS]", allowNoSubcommand: true, progressive: true, options: vaultReadOptions, commands: keyCommands, commandGroups: [{ title: "Commands", commands: ["create", "list", "revoke"].map((name) => ({ name, summary: `${name} incoming keys.` })) }] };
delete cliSpec.commands!.auth!.commands!["api-key"];
cliSpec.commands!.secrets!.allowNoSubcommand = true;
cliSpec.commands!.secrets!.options = vaultReadOptions;
cliSpec.commands!.secrets!.description = "Inspect and maintain project credential references without exposing values.";
cliSpec.commands!.secrets!.commands!.set = {
  name: "set", path: ["secrets", "set"], progressive: true, description: "Set a hidden or stdin vault value, or explicitly bind another source.", usage: "fentaris secrets set [reference] [OPTIONS]",
  arguments: [{ name: "reference", description: "Stable project credential reference." }],
  options: [{ name: "stdin", description: "Read the credential from stdin; never put values in arguments." }, { name: "source", valueName: "SOURCE", description: "vault (default), environment, or external." },
    { name: "env", valueName: "VARIABLE", description: "Explicit environment source variable." }, { name: "provider", valueName: "PROVIDER", description: "Explicit external provider ID." }, { name: "locator", valueName: "LOCATOR", description: "Public external secret locator." }, { name: "replace-source", description: "Explicitly replace the source binding without copying a value." },
    { name: "json", description: "Machine-readable result; never prompt." }, { name: "help", short: "h", description: "Print help" }],
};
for (const action of ["get", "list", "remove", "check"] as const) cliSpec.commands!.secrets!.commands![action] = {
  name: action, path: ["secrets", action], progressive: true, description: `${action[0].toUpperCase()}${action.slice(1)} project credential reference metadata.`, usage: `fentaris secrets ${action}${["get", "remove"].includes(action) ? " [reference]" : ""} [OPTIONS]`,
  ...(["get", "remove"].includes(action) ? { arguments: [{ name: "reference", description: "Stable project credential reference." }] } : {}),
  options: [...(action === "remove" ? [{ name: "force", description: "Explicitly delete an in-use stored value while retaining consumers for recovery." }] : []), ...vaultReadOptions.filter((option) => action !== "remove" || option.name !== "offline")],
};
cliSpec.commands!.secrets!.commands!.migrate = { name: "migrate", path: ["secrets", "migrate"], progressive: true, description: "Explicitly migrate legacy encrypted credentials while retaining recovery data.", usage: "fentaris secrets migrate --mapping <file> --legacy-file <file> [OPTIONS]", options: [
  { name: "mapping", valueName: "FILE", description: "Public JSON array of {reference, scope, target} mappings." }, { name: "legacy-file", valueName: "FILE", description: "Existing encrypted store; never modified." }, { name: "incoming-keys", description: "Explicitly migrate incoming verifiers with new IDs and names." }, { name: "json", description: "Machine-readable migration result." }, { name: "help", short: "h", description: "Print help" },
] };
delete cliSpec.commands!.secrets!.commands!.unset;
cliSpec.commands!.secrets!.commandGroups = [{ title: "Commands", commands: ["set", "get", "list", "remove", "check", "migrate", "manifest", "doctor", "setup"].map((name) => ({ name, summary: cliSpec.commands!.secrets!.commands![name]!.description })) }];
