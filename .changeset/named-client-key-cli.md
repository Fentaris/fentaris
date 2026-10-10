---
"@fentaris/cli": major
---

BREAKING: replace auth api-key add/list/remove with auth keys create/list/revoke; remove raw --value arguments and scoped secret writes; replace secrets unset with secrets remove; and operate on project-vault references with metadata-only secret reads. Use hidden/stdin input, named key IDs, progressive missing-field completion, consistent JSON/noninteractive results, usage-aware removal, and explicit source bindings/unlock mechanisms. Legacy encrypted and environment-backed setups require explicit migration; original stores/keys remain available for rollback. The related tools-to-mcp namespace migration is owned by issue #297 and is not implemented by this Changeset.
