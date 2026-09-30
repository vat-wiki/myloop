# @myloop/app-sdk

Application-layer building blocks for myloop agents.

- `createAppAgent` assembles model client, input adapter, command host, logger, and sessions.
- `FileSessionStore` persists and lists snapshots.
- `composeSystem`, `loadAgentsInstructions`, and `loadAppSkills` compose runtime prompts.
- `createAppModelClient` and `createAppLogger` are available for apps that need custom assembly.
