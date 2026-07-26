Linux computer use, safer native actions, and tighter state and output boundaries.

## Features

- Added Linux desktop support through AT-SPI2, with X11 window discovery, capture, focus, and guarded XTEST input.
- Added native Linux x64 and arm64 helpers to npm and GitHub release artifacts.
- Added Linux-aware managed browser discovery with explicit Chrome and Helium executable overrides.
- Added pull-request CI for Linux x64 tests, linting, formatting, and builds, plus native arm64 builds.

## Changelog

- added background-first semantic Linux observation, action, text reading, waiting, and progressive disclosure.
- added X11 window correlation, background capture, coordinate grounding, and foreground-only physical input fallback.
- documented the semantic-only native Wayland boundary and read-only portal capability diagnostics.
- improved post-action handling when an action closes its source root before a successor observation can be captured.
- hardened root identity resolution, bounded tool output, JSON-safe wait details, serialized native boundaries, and macOS helper installation.
- tightened the macOS ghost cursor lifecycle so it remains background-only and does not linger while idle.
- updated build dependencies and GitHub Actions while removing unused bridge symbols.

> "The future is already here — it's just not evenly distributed."
