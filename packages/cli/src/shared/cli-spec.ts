export type CliOptionSpec = {
  name: string;
  short?: string;
  valueName?: string;
  description: string;
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
      ],
    },
  ],
  options: globalOptions,
  environment: [{ name: "FENTARIS_AUTH_KEY", description: "Encryption key used by the local secrets backend." }],
  commands: {
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
      commandGroups: [
        {
          title: "Commands",
          commands: [{ name: "api-key", summary: "Manage API keys for local user identity." }],
        },
      ],
      options: [{ name: "help", short: "h", description: "Print help" }],
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
              usage: "fentaris auth api-key add [OPTIONS] <user-id>",
              arguments: [{ name: "user-id", required: true, description: "User id resolved when the API key is presented." }],
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
            { name: "list", summary: "List required and stored credentials." },
            { name: "unset", summary: "Remove a local credential value." },
            { name: "manifest", summary: "Generate or check the secrets manifest." },
            { name: "doctor", summary: "Run secret-specific diagnostics." },
          ],
        },
      ],
      options: [{ name: "help", short: "h", description: "Print help" }],
      commands: {
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
  },
};
