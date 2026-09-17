### Patch Changes

- 3dae736: Allow group-scoped policies to grant access to the built-in `fentaris__auth_status` and `fentaris__auth_login` tools for interactive OAuth servers.
- f8655c5: Refresh stored authorization-code tokens from headless and stdio exposures even when no OAuth redirect URL is configured.
