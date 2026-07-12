Simpler diff-first computer use with parallel tasks, a ghost cursor, and more reliable batched actions.

## Features

- Added a configurable native ghost cursor so agents can show pointer movement without taking over the user's physical cursor.
- Added diff-first resulting views with stable references, explicit full-view fallbacks, and immutable resource-keyed state.
- Added parallel native transports and resource-keyed scheduling so independent roots can progress concurrently.
- Consolidated action preparation, execution, verification, and batching behind one agent-facing contract.

## Changelog

- added the macOS ghost cursor overlay with headless-safe configuration and native cursor ownership.
- refactored observation state into focused action, state, and view modules while removing superseded compatibility paths.
- added diff-first resulting views and authoritative post-action reconciliation for exact text entry.
- improved web and coordinate action reliability by foregrounding only when pointer focus is required.
- aligned strict headless behavior across macOS and Windows with accessibility-only initial actions.
- added runtime, architecture-invariant, platform, packaging, and Cubench regression coverage.

> "Time is an illusion. Lunchtime doubly so."
