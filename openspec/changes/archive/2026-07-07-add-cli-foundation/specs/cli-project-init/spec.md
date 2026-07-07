## ADDED Requirements

### Requirement: Project name resolution
The CLI SHALL accept `fentaris init [project-name]` and SHALL prompt for a project name when the positional project name is omitted.

#### Scenario: Project name provided
- **WHEN** a developer runs `fentaris init my-app`
- **THEN** the CLI uses `my-app` as the target project directory without asking for the name

#### Scenario: Project name omitted
- **WHEN** a developer runs `fentaris init`
- **THEN** the CLI asks for the project name before creating files

### Requirement: Empty target directory enforcement
The CLI SHALL refuse to initialize into an existing non-empty target directory with a clear error.

#### Scenario: Target directory already contains files
- **WHEN** a developer runs `fentaris init my-app` and `my-app` exists with files
- **THEN** the CLI exits without modifying the directory and explains that Fentaris can only initialize into a new or empty directory

### Requirement: Package manager selection
The CLI SHALL detect available package managers and SHALL ask the developer which one to use when more than one supported package manager is available.

#### Scenario: Multiple package managers available
- **WHEN** `pnpm`, `npm`, and `bun` are available during `fentaris init`
- **THEN** the CLI prompts the developer to choose one before writing package-manager-specific template files

#### Scenario: Single package manager available
- **WHEN** only one supported package manager is available during `fentaris init`
- **THEN** the CLI selects it without prompting

### Requirement: Default project template
The CLI SHALL create a default TypeScript Fentaris project that can run a proxy immediately after dependencies are installed.

#### Scenario: Template files are generated
- **WHEN** `fentaris init my-app` succeeds
- **THEN** the project contains `package.json`, `tsconfig.json`, a Fentaris project config, `src/index.ts`, `.env.example`, `.gitignore`, and local `.fentaris` project directories as needed

### Requirement: Demo proxy content
The generated default template SHALL include a working Fentaris proxy example with one stdio MCP upstream, one unauthenticated HTTP MCP upstream at `https://mcp.specification.website/mcp`, two users, one group, policy configuration, and a rate-limit example.

#### Scenario: Developer reads generated entrypoint
- **WHEN** a developer opens the generated `src/index.ts`
- **THEN** the file shows how to configure MCP upstreams, users, groups, permissions, rate limiting, and proxy startup in one coherent example

### Requirement: Demo permissions
The generated template SHALL demonstrate a low-permission user path and a full-permission user outside the limited group.

#### Scenario: Template auth model is generated
- **WHEN** `fentaris init my-app` succeeds
- **THEN** the generated proxy configuration includes one user with limited permissions and another user outside that limited group with full permissions

### Requirement: Git initialization
The CLI SHALL initialize a git repository and write a `.gitignore` for generated projects.

#### Scenario: Init completes
- **WHEN** `fentaris init my-app` succeeds
- **THEN** `my-app` is a git repository and generated local secrets, build output, dependencies, and env files are ignored

### Requirement: Dependency installation
The CLI SHALL install dependencies using the selected package manager unless the developer opts out through a supported non-interactive option.

#### Scenario: Dependencies install successfully
- **WHEN** `fentaris init my-app` reaches the install step
- **THEN** the CLI runs the selected package manager install command and reports the result in the terminal summary

### Requirement: Doctor after init
The CLI SHALL run `fentaris doctor` after project creation and dependency installation, reporting doctor findings as warnings unless a critical issue prevents the project from running.

#### Scenario: Doctor reports warning
- **WHEN** Docker is not installed during `fentaris init`
- **THEN** the CLI reports a warning but still completes project initialization

### Requirement: First-run terminal output
The CLI SHALL present init progress with colored, ordered sections, status markers, and concise next steps.

#### Scenario: Init succeeds
- **WHEN** `fentaris init my-app` completes
- **THEN** the CLI prints that setup is complete and shows how to run `cd my-app` and `fentaris dev`
