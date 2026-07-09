# Page Style

Use the MCP-use inspired structure for Fentaris MDX pages.

## Standard Shape

````mdx
---
title: "CLI Usage"
description: "Run and inspect Fentaris from the command line."
---

Short intro paragraph.

## Quick Start

```bash theme={null}
fentaris dev
```

## Options

### `--offline`

Describe the option, when to use it, defaults, and constraints.

```bash theme={null}
fentaris check --offline
```

<Note>
  Include warnings or constraints that affect correctness.
</Note>

## Troubleshooting

### Command not found

Show the fix.

## Related Documentation

* [Quickstart](/getting-started/quickstart)
````

## Tone

- Be direct and operational.
- Prefer short paragraphs and specific examples.
- State defaults and limits near the option or config key they affect.
- Avoid vague claims such as "simple", "easy", "powerful", or "seamless" unless the page proves them.
- Use "Fentaris" for the product, `fentaris` for the CLI binary, and package names in backticks.

## Formatting

- Do not add a top-level `#` heading that repeats the frontmatter `title`; Mintlify renders the page title automatically.
- Do not add a leading blockquote that repeats the frontmatter `description`; Mintlify renders the description automatically under the page title.
- Use `## Quick Start` for runnable tasks.
- Use `###` headings for CLI flags, config keys, errors, and troubleshooting cases.
- Use bullet lists only when they improve scanning.
- Use `theme={null}` on fenced code blocks.
- Use `<Note>` for correctness constraints, `<Tip>` for workflow improvements, and `<Warning>` for risky operations.
- End reference and guide pages with `## Related Documentation` when there are adjacent pages.

## API Examples

- Use high-level helpers first in narrative docs: `fentaris(...)`, `mcp(...)`, `stdio(...)`, `streamableHttp(...)`, `group(...)`, `user(...)`, and `policy(...)`.
- Use class constructors only in a final `## Low-Level API` section or in a reference page dedicated to that class.
- Do not teach `new McpProxy(...)`, `new McpServer(...)`, or `new StdioTransport(...)` as the default path for new applications.
- When rewriting old examples, keep behavior equivalent but convert object construction to declarations.
