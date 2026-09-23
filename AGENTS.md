# Repository Guidelines

## Project Structure & Module Organization

`mycoder` is a TypeScript SDK for agent sessions, model calls, extension hooks, and a built-in terminal tool. Source code lives in `src/`:

- `src/agent/` — public agent abstractions, `SingleAgent`, `CompositeAgent`, and user-input normalization.
- `src/runtime/` — runtime loop, message model, model-client contract, context compaction, events, extensions, and PTY execution.
- `src/clients/` — protocol adapters for Anthropic and OpenAI-compatible APIs.
- `src/skills/` — declarative system-prompt composition.

Tests mirror source behavior in `tests/`. Public entry points and package exports are defined in `package.json`, with the main export in `src/index.ts`. Generated output belongs in `dist/`; do not commit unrelated build artifacts.

## Build, Test, and Development Commands

- `npm install` — install dependencies.
- `npm run build` — compile TypeScript into `dist/`.
- `npm run typecheck` — run the strict TypeScript compiler without emitting files.
- `npm test` — run the Vitest suite once.

## Coding Style & Naming Conventions

Use TypeScript with strict compiler settings, two-space indentation, named exports, and explicit type-only imports (`import type`). Follow `NodeNext` module resolution and use `.js` extensions in relative imports. Prefer clear domain names such as `AgentRuntime`, `ModelClient`, `AgentExtension`, and `UserInputAdapter`; keep functions small and avoid adding abstractions that are not exercised by runtime behavior or tests.

No formatter or linter is configured. Run `npm run typecheck` before submitting changes.

## Testing Guidelines

Vitest is the test framework. Place tests under `tests/` using `<module>.test.ts` or `<component>.test.ts`, mirroring the source path when practical. Cover runtime state transitions, extension ordering, client request/response mapping, input validation, and context-compaction invariants. Run focused tests during iteration and the full `npm test` suite before submitting.

## Commit & Pull Request Guidelines

No repository Git history is available in this workspace, so no established commit convention can be verified. Use concise, imperative commit subjects such as `Add input validation` or `Fix context compaction`.

Pull requests should include:

- A short summary of the behavioral change and rationale.
- Linked issues or tasks when applicable.
- Tests for new behavior and bug fixes.
- Output from `npm run typecheck` and `npm test`.
- Breaking API changes called out explicitly.

## Security & Configuration Tips

Never commit API keys or provider credentials. Model clients typically receive `apiKey` from environment variables. Keep local-file input opt-in and preserve existing size, media-type, and URL restrictions.
