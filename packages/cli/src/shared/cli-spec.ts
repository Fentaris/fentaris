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
  details: ["Join once, run persistently when supported, and manage only devices visible to the selected Fentaris identity."],
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
        { name: "tools", summary: "Discover effective MCP tools for configured accounts." },
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
        { name: "package-manager", valueName: "PM", description: "Package manager written to the generated project. Supported values: pnpm, npm, bun." },
        { name: "skip-install", description: "Skip dependency installation." },
        { name: "skip-git", description: "Skip git repository initialization." },
        { name: "port", valueName: "PORT", description: "Port written to fentaris.json. [default: 4000]" },
        { name: "path", valueName: "PATH", description: "MCP route path written to fentaris.json. [default: /mcp]" },
        { name: "core-version", valueName: "RANGE", description: "Version range for @fentaris/core in the generated package.json. Accepts semver ranges (^3.0.0), dist tags (latest), and workspace/file references (workspace:*, file:../packages/core). [default: ^3.0.0]" },
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
          commands: [{ name: "api-key", summary: "Manage API keys for local user identity." }],
        },
      ],
      options: [
        localSecretsKeyOption,
        { name: "help", short: "h", description: "Print help" },
      ],
      commands: {
        "api-key": {
          name: "api-key",
          path: ["auth", "api-key"],
          description: "Manage API keys for local user identity.",
          usage: "fentaris auth api-key [OPTIONS] [COMMAND]",
          details: ["API keys authenticate clients through the x-fentaris-api-key header and resolve them to Fentaris users."],
          commandGroups: [
            {
              title: "Commands",
              commands: [
                { name: "add", summary: "Store a local API key for a user." },
                { name: "list", summary: "List local API-key counts by user." },
                { name: "remove", summary: "Remove a local API key from a user." },
              ],
            },
          ],
          options: [{ name: "help", short: "h", description: "Print help" }],
          commands: {
            add: {
              name: "add",
              path: ["auth", "api-key", "add"],
              description: "Store a local API key for a user.",
              usage: "fentaris auth api-key add [OPTIONS] [user-id]",
              details: ["Omit the user id or API-key value to use the guided setup with user selection, key generation or entry, a redacted review, and confirmation before writing."],
              arguments: [{ name: "user-id", description: "User id resolved when the API key is presented. If omitted, an interactive prompt is used." }],
              options: [
                { name: "value", valueName: "VALUE", description: "API key value. Prefer --value-stdin to avoid exposing keys in process arguments." },
                { name: "value-stdin", description: "Read the API key value from stdin instead of process arguments or an interactive prompt." },
                { name: "generate", description: "Generate a new API key and print it once." },
                localSecretsKeyOption,
                { name: "help", short: "h", description: "Print help" },
              ],
            },
            list: {
              name: "list",
              path: ["auth", "api-key", "list"],
              description: "List local API-key counts by user.",
              usage: "fentaris auth api-key list [OPTIONS]",
              options: [
                { name: "user", valueName: "ID", description: "Only list keys for one user id." },
                { name: "json", description: "Output API-key references as JSON." },
                localSecretsKeyOption,
                { name: "help", short: "h", description: "Print help" },
              ],
            },
            remove: {
              name: "remove",
              path: ["auth", "api-key", "remove"],
              description: "Remove a local API key from a user.",
              usage: "fentaris auth api-key remove [OPTIONS] <user-id>",
              arguments: [{ name: "user-id", required: true, description: "User id to remove the API key from." }],
              options: [
                { name: "value", valueName: "VALUE", description: "API key value to remove. Prefer --value-stdin to avoid exposing keys in process arguments." },
                { name: "value-stdin", description: "Read the API key value from stdin instead of process arguments or an interactive prompt." },
                localSecretsKeyOption,
                { name: "help", short: "h", description: "Print help" },
              ],
            },
          },
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
        set: {
          name: "set",
          path: ["secrets", "set"],
          description: "Store a local credential value.",
          usage: "fentaris secrets set [OPTIONS] [reference]",
          details: [
            "Omit reference or --value to use a guided setup with manifest reference selection, scope selection, a redacted review, and confirmation before writing.",
          ],
          arguments: [{ name: "reference", description: "Secret reference to store, for example github.token. If omitted, an interactive prompt is used." }],
          options: [
            { name: "user", valueName: "ID", description: "Store the credential for a user scope." },
            { name: "group", valueName: "ID", description: "Store the credential for a group scope." },
            { name: "value", valueName: "VALUE", description: "Credential value. Prefer --value-stdin to avoid exposing secrets in process arguments." },
            { name: "value-stdin", description: "Read the credential value from stdin instead of process arguments or an interactive prompt." },
            localSecretsKeyOption,
            { name: "help", short: "h", description: "Print help" },
          ],
        },
        list: {
          name: "list",
          path: ["secrets", "list"],
          description: "List required and stored credentials.",
          usage: "fentaris secrets list [OPTIONS]",
          options: [
            { name: "json", description: "Output credentials as JSON." },
            localSecretsKeyOption,
            { name: "help", short: "h", description: "Print help" },
          ],
        },
        unset: {
          name: "unset",
          path: ["secrets", "unset"],
          description: "Remove a local credential value.",
          usage: "fentaris secrets unset [OPTIONS] <reference>",
          arguments: [{ name: "reference", required: true, description: "Secret reference to remove." }],
          options: [
            { name: "user", valueName: "ID", description: "Remove the credential from a user scope." },
            { name: "group", valueName: "ID", description: "Remove the credential from a group scope." },
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
    tools: {
      name: "tools",
      path: ["tools"],
      description: "Discover effective MCP tools for configured accounts.",
      usage: "fentaris tools [OPTIONS] [COMMAND]",
      commandGroups: [
        {
          title: "Commands",
          commands: [
            { name: "list", summary: "List effective tools." },
            { name: "search", summary: "Search effective tools." },
            { name: "get", summary: "Inspect one tool." },
            { name: "schema", summary: "Inspect one tool schema." },
            { name: "auth", summary: "Inspect tool account authentication." },
          ],
        },
      ],
      options: [{ name: "help", short: "h", description: "Print help" }],
      commands: {
        list: {
          name: "list",
          path: ["tools", "list"],
          description: "List effective MCP tools.",
          usage: "fentaris tools list [OPTIONS]",
          options: toolDiscoveryOptions(),
        },
        search: {
          name: "search",
          path: ["tools", "search"],
          description: "Search effective MCP tools.",
          usage: "fentaris tools search [OPTIONS] <query>",
          arguments: [{ name: "query", required: true, description: "Search query." }],
          options: toolDiscoveryOptions(),
        },
        get: {
          name: "get",
          path: ["tools", "get"],
          description: "Inspect one effective MCP tool.",
          usage: "fentaris tools get [OPTIONS] <tool>",
          arguments: [{ name: "tool", required: true, description: "Proxied tool name, for example github__create_issue." }],
          options: toolDiscoveryOptions(),
        },
        schema: {
          name: "schema",
          path: ["tools", "schema"],
          description: "Inspect one effective MCP tool schema.",
          usage: "fentaris tools schema [OPTIONS] <tool>",
          arguments: [{ name: "tool", required: true, description: "Proxied tool name, for example github__create_issue." }],
          options: [
            ...toolDiscoveryOptions(),
            { name: "input", description: "Return the input schema." },
            { name: "output", description: "Return the output schema." },
          ],
        },
        auth: {
          name: "auth",
          path: ["tools", "auth"],
          description: "Inspect tool account authentication.",
          usage: "fentaris tools auth [OPTIONS] [COMMAND]",
          commandGroups: [
            {
              title: "Commands",
              commands: [
                { name: "list", summary: "List configured MCP account selectors." },
                { name: "status", summary: "Inspect one MCP account selector." },
                { name: "login", summary: "Start or describe login for one selector." },
              ],
            },
          ],
          options: [{ name: "help", short: "h", description: "Print help" }],
          commands: {
            list: {
              name: "list",
              path: ["tools", "auth", "list"],
              description: "List configured MCP account selectors.",
              usage: "fentaris tools auth list [OPTIONS]",
              options: [{ name: "json", description: "Output a JSON envelope." }, { name: "help", short: "h", description: "Print help" }],
            },
            status: {
              name: "status",
              path: ["tools", "auth", "status"],
              description: "Inspect one MCP account selector.",
              usage: "fentaris tools auth status --mcp <MCP> --as <SELECTOR> [OPTIONS]",
              options: authDiscoveryOptions(),
            },
            login: {
              name: "login",
              path: ["tools", "auth", "login"],
              description: "Start or describe login for one selector.",
              usage: "fentaris tools auth login --mcp <MCP> --as <SELECTOR> [OPTIONS]",
              options: authDiscoveryOptions(),
            },
          },
        },
      },
    },
  },
};

function toolDiscoveryOptions(): CliOptionSpec[] {
  return [
    { name: "json", description: "Output a JSON envelope." },
    { name: "compact", description: "Return compact metadata." },
    { name: "limit", valueName: "N", description: "Maximum number of tools to return. [default: 20]" },
    { name: "cursor", valueName: "CURSOR", description: "Pagination cursor from a prior response." },
    { name: "max-tokens", valueName: "N", description: "Best-effort output token budget." },
    { name: "mcp", valueName: "MCP", description: "Filter to one MCP server." },
    { name: "as", valueName: "SELECTOR", description: "Use a configured account selector such as user:alice or group:support." },
    { name: "include", valueName: "TEXT", description: "Only include tools matching text. Comma-separated values are accepted." },
    { name: "exclude", valueName: "TEXT", description: "Exclude tools matching text. Comma-separated values are accepted." },
    { name: "refresh", description: "Bypass cached discovery data where supported." },
    { name: "no-start", description: "Do not start stdio MCP servers for discovery." },
    { name: "help", short: "h", description: "Print help" },
  ];
}

function authDiscoveryOptions(): CliOptionSpec[] {
  return [
    { name: "mcp", valueName: "MCP", description: "Configured MCP server name." },
    { name: "as", valueName: "SELECTOR", description: "Configured account selector." },
    { name: "json", description: "Output a JSON envelope." },
    { name: "help", short: "h", description: "Print help" },
  ];
}
