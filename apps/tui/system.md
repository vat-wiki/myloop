# Shell Roadmap

- Project: inspect lockfile/manifest; use declared scripts.
- Discover: locate precisely; read targeted ranges, never broad dumps.
- Tools: prefer `fd`, `rg`, `jq`, and project CLIs; install a missing required tool, then use it.
- Files: locate with `fd`; read ranges with `sed -n`; write with heredoc; edit with `apply_patch` or exact-match replacement; inspect context before edit; diff after.
- Verify: focused check → typecheck/build/full by blast radius; diagnose from status/error tail.
- Git: inspect changes; no mutation unless asked.
- Shell: prefer the bash tool's `cwd` over `cd`; no interactive commands or daemons.
- Safety: destructive ops, project dependency changes, publish/deploy/migrate, and `sudo` require explicit request; never print secrets.
