## 1. CLI Foundation

- [x] 1.1 Replace or wrap the current manual CLI parser with a structured command router that supports top-level commands and nested `secrets set`
- [x] 1.2 Add shared terminal UI helpers for colored section headings, pass/warn/fail markers, summaries, and next-step output
- [x] 1.3 Preserve existing `fentaris auth ...` behavior or map it to compatible internal auth/secrets operations
- [x] 1.4 Add shared process execution helpers for package-manager commands, git commands, and project scripts with testable dry-run seams

## 2. Project Template

- [x] 2.1 Add the default TypeScript project template files for `package.json`, `tsconfig.json`, Fentaris project config, `.env.example`, `.gitignore`, and `src/index.ts`
- [x] 2.2 Implement template rendering for project name, selected package manager, local port/path, and generated demo auth values
- [x] 2.3 Generate a proxy example with one stdio MCP upstream scoped to a safe demo directory and one HTTP MCP upstream at `https://mcp.specification.website/mcp`
- [x] 2.4 Generate demo users, one limited group, policy rules, full-permission user behavior, and a rate-limit example in the entrypoint
- [x] 2.5 Initialize local Fentaris auth files through existing `FentarisAuth.local`-compatible encrypted credential storage

## 3. Init Command

- [x] 3.1 Implement `fentaris init [project-name]` project name resolution and prompt when omitted
- [x] 3.2 Implement empty target directory validation with a clear non-destructive error for non-empty directories
- [x] 3.3 Implement package-manager detection and prompt only when multiple supported managers are available
- [x] 3.4 Write the rendered default template into the target project directory
- [x] 3.5 Install dependencies with the selected package manager and report install results
- [x] 3.6 Initialize a git repository in the generated project and verify `.gitignore` excludes dependencies, env files, build output, and local secrets
- [x] 3.7 Run the doctor checks after install and include warnings in the init summary without failing on non-critical issues
- [x] 3.8 Print final setup output with `cd <project>` and `fentaris dev` next steps

## 4. Health Commands

- [x] 4.1 Implement project discovery for project-scoped commands from the current directory or ancestors
- [x] 4.2 Implement `fentaris doctor` environment checks for Node version, package managers, git, Docker warning readiness, ports, and CLI writable directories
- [x] 4.3 Implement `fentaris doctor --fix` with one approval prompt per supported fix in deterministic order
- [x] 4.4 Implement `fentaris check` static project validation for config, expected files, package metadata, auth references, and proxy entrypoint
- [x] 4.5 Implement MCP connectivity and tool discovery checks for `fentaris check` where enabled
- [x] 4.6 Implement `fentaris check --offline` and `fentaris check --strict`
- [x] 4.7 Ensure health commands report mixed pass/warn/fail results with clear grouped output and exit codes

## 5. Runtime Commands

- [x] 5.1 Implement `fentaris dev` to run the discovered Fentaris project locally through the selected package manager or configured entrypoint
- [x] 5.2 Add clear failure behavior for `fentaris dev` outside a Fentaris project
- [x] 5.3 Implement `fentaris build` to validate the project and write a deterministic local artifact under `.fentaris/build`
- [x] 5.4 Print build output directory and runtime entrypoint after a successful build
- [x] 5.5 Add placeholder behavior for `fentaris deploy` that clearly reports deploy is not available yet and points to `fentaris build`

## 6. Secrets Command

- [x] 6.1 Implement `fentaris secrets set <reference>` with secure value prompting and default credential storage
- [x] 6.2 Add `--user` and `--group` support for subject-scoped credentials
- [x] 6.3 Ensure all secret command output redacts raw values
- [x] 6.4 Verify `fentaris secrets set` writes storage compatible with `FentarisAuth.local` credential resolution

## 7. Tests and Documentation

- [x] 7.1 Add unit tests for command routing, project name resolution, target directory validation, and package-manager selection
- [x] 7.2 Add template snapshot or fixture tests for generated files and `.gitignore`
- [x] 7.3 Add tests for doctor/check result classification, fix prompting, offline mode, strict mode, and exit codes
- [x] 7.4 Add tests for `dev`, `build`, deploy placeholder behavior, and project discovery from nested directories
- [x] 7.5 Add tests for `secrets set` redaction and FentarisAuth-compatible storage
- [x] 7.6 Update getting-started docs so `fentaris init` and `fentaris dev` become the recommended quickstart path
- [x] 7.7 Run package build, typecheck, lint, and relevant CLI/core tests
