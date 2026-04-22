> Latest release: **v0.1.3** — added semantic AX target refs via `click({ ref: "@eN" })`, switched to semantic-first turn updates with image fallback only when needed, added an official benchmark harness in `benchmarks/`, and improved benchmarked performance from `axOnlyRatio 0.5 → 1.0` (**+100%**) and `avgLatencyMs 11194 → 404` (**-10790ms / -96.4%**).

# pi-computer-use

![pi-computer-use](./assets/img.jpg)

Codex-style computer use for Pi on macOS with AX-first semantic targeting, semantic state updates, and image fallback when semantic coverage is weak.

> For setup, development, benchmarks, and contribution workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Features

- Public tools: `screenshot`, `click`, `type_text`, `wait`
- AX target refs in tool results, e.g. `@e1`, for semantic targeting
- `click({ ref: "@eN" })` support alongside coordinate clicks
- Semantic-first turn updates with image attachment fallback only when needed
- AX-first execution with optional strict AX-only mode via `PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`
- Browser-aware targeting, including isolated browser window preference when appropriate
- Non-intrusive helper behavior where possible instead of global cursor takeover
- Official benchmark harness in `benchmarks/` with baseline comparison and regression checks

## Setup

### Install

The package is published on npm as `@injaneity/pi-computer-use`.

#### Pi

```bash
pi install @injaneity/pi-computer-use
# pinned version
pi install @injaneity/pi-computer-use@0.1.3
# project-local
pi install -l @injaneity/pi-computer-use
```

#### npm

```bash
npm install @injaneity/pi-computer-use
# pinned version
npm install @injaneity/pi-computer-use@0.1.3
```

#### GitHub release tag fallback

```bash
pi install git:github.com/injaneity/pi-computer-use#v0.1.3
# project-local
pi install -l git:github.com/injaneity/pi-computer-use#v0.1.3
# local checkout
pi install /absolute/path/to/pi-computer-use
```

Use the GitHub tag fallback if you want to install directly from the release tag.

### First run

Start Pi in interactive mode. On session start, the extension checks whether computer-use is ready and guides you through setup if permissions are missing.

Grant both permissions to the helper at:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required permissions:
- Accessibility
- Screen Recording

### Local development

If you want to work on a local checkout:

```bash
npm install
# optional: build the helper into the installed helper path
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

To run the checkout in Pi without loading another installed copy at the same time:

```bash
pi --no-extensions -e .
```

For benchmark and contribution workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md) and `benchmarks/README.md`.

### Helper build

If you need to build the helper manually:

```bash
node scripts/build-native.mjs
# or build directly to the installed helper path
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

### Remove

```bash
pi remove @injaneity/pi-computer-use
# or if installed from a git tag
pi remove git:github.com/injaneity/pi-computer-use#v0.1.3
```
