# Docs Architecture

Use this structure for the public Mintlify documentation.

## Navigation

- `index.mdx`: landing page and shortest path into the docs.
- `getting-started/`: first-run path for new users.
- `concepts/`: conceptual model and mental maps.
- `guides/`: task-based workflows.
- `reference/`: precise CLI, config, API, env var, and type documentation.
- `reference-auto/`: generated TypeDoc output.
- `troubleshooting.mdx`: symptom-to-fix pages.

## Placement Rules

- Put "how do I do X?" content in `guides/`.
- Put "what is X?" content in `concepts/`.
- Put exact flags, options, defaults, schemas, and type facts in `reference/`.
- Put install, first project, and first client connection in `getting-started/`.
- Keep generated API docs under `reference-auto/`; do not hand-edit generated output unless the generator requires a wrapper file.

## Page Names

- Use short kebab-case file names.
- Prefer nouns for reference pages: `cli`, `config-file`, `environment-variables`.
- Prefer task names for guides: `multiple-servers`, `telegram-approval`, `production-hardening`.
