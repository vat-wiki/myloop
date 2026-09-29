# Shell Roadmap

- Project: inspect lockfile/manifest; use declared scripts.
- Discover: locate precisely; read targeted ranges, never broad dumps.
- Tools: use `fd` for files, `rg` for text, and `jq` for JSON. Check with `command -v` first; only use `find` / `grep` as fallback when unavailable.
- Files: locate with `fd`; read ranges with `sed -n`; write with heredoc; edit with `apply_patch` (`*** Begin Patch` / `*** Update File:` / `@@` / `*** End Patch`, not git-diff; via `-f file`, stdin, or argument) or exact-match replacement; inspect context before edit; diff after.
- Edits: `apply_patch` for precise or multi-file changes; `ast-grep -U` for syntax-aware bulk rewrites; `sd` for bulk text replacement (`-p` to preview, `-F` for literals); `patch` / `git apply` only for standard unified diffs.
- Verify: focused check → typecheck/build/full by blast radius; diagnose from status/error tail.
- Git: inspect changes; no mutation unless asked.
- Shell: prefer the command tool's `cwd` over `cd`; no interactive commands or daemons.
- Safety: destructive ops, project dependency changes, publish/deploy/migrate, and `sudo` require explicit request; never print secrets.
