# pi-computer-use

![pi-computer-use](./assets/img.jpg)

Codex-style computer use for Pi on macOS with AX-first semantic targeting, semantic state updates, and image fallback when semantic coverage is weak.

## Latest Release

[**v0.1.6**](https://github.com/injaneity/pi-computer-use/releases/tag/v0.1.6) makes computer use safer and more predictable by preferring background-safe Accessibility actions before falling back to normal foreground keyboard or mouse control.

Install:
- GitHub release: `pi install git:github.com/injaneity/pi-computer-use#v0.1.6`.
- npm package: `npm install @injaneity/pi-computer-use@0.1.6`.

What changed:
- Added targeted text replacement with `set_text({ ref, text })`, so agents can edit a known field instead of relying on whichever app is focused.
- Added stealth/default reporting on every action, so users can see when an action stayed background-safe and when it needed normal foreground input.
- Added target capability hints to screenshots, so agents can see whether an element can be pressed, focused, or edited directly.
- Added per-action execution details to batched actions, so longer workflows are easier to debug without extra screenshots.
- Added stealth-compatible coverage to benchmarks while keeping the existing AX-first checks intact.

Validation snapshot for `v0.1.6`:
- Manual action QA: default `PASS=6 FAIL=0 SKIP=5`; stealth `PASS=4 FAIL=0 SKIP=6`.
- Benchmark: `executed=20 passed=20 failed=0 skipped=14`.
- AX-first metrics stayed clean: `axOnlyRatio=1.0`, `axExecutionRatio=1.0`, and `targetingAxOnlyRatio=1.0`.
- Stealth-compatible execution is now tracked at `0.65`; primitive and batch coverage both pass at `1.0`.

> For setup, development, benchmarks, and contribution workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Features

- Public tools: `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`, `type_text`, `set_text`, `wait`, `computer_actions`
- AX target refs in tool results, e.g. `@e1`, with capabilities like `canSetValue`, `canPress`, and `canFocus`
- Ref-first actions such as `click({ ref: "@eN" })` and `set_text({ ref: "@eN", text })` before coordinate/focus fallbacks
- Batched actions via `computer_actions`, returning one post-action semantic state update plus per-action execution metadata
- Execution metadata reports the selected implementation variant: `stealth` for background-safe AX paths, `default` for focus/raw-event fallbacks
- Full pointer/keyboard primitive coverage for common GUI flows: click, double-click, move, drag, scroll, keypress, text insert, and AX text replacement
- Semantic-first turn updates with image attachment fallback only when needed
- AX-first execution with optional strict AX-only mode via `PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`
- Stealth mode is the widest safe subset: AX/background-safe operations run, while foreground focus, raw keyboard/pointer events, and cursor takeover are blocked
- Browser-aware targeting, including isolated browser window preference when appropriate
- Non-intrusive helper behavior where possible instead of global cursor takeover
- Official benchmark harness in `benchmarks/` with baseline comparison and regression checks

## Setup

### Install

The package is published on npm as `@injaneity/pi-computer-use`.

#### Pi

```bash
pi install git:github.com/injaneity/pi-computer-use#v0.1.6
# project-local
pi install -l git:github.com/injaneity/pi-computer-use#v0.1.6
# local checkout
pi install /absolute/path/to/pi-computer-use
```

#### npm

```bash
npm install @injaneity/pi-computer-use
# pinned version
npm install @injaneity/pi-computer-use@0.1.6
```

Use the GitHub release tag for `pi install`. Use npm when you want the package directly through the npm registry.

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
# build both release prebuilts
node scripts/build-native.mjs --arch all
# or build directly to the installed helper path
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

Local helper builds are ad-hoc codesigned by default. For a release build with a stable Apple Developer identity, use a Developer ID Application certificate:

```bash
node scripts/build-native.mjs --arch all \
  --sign-identity "Developer ID Application: Your Team (TEAMID)" \
  --hardened-runtime \
  --timestamp
```

The helper is signed with the stable identifier `com.injaneity.pi-computer-use.bridge` by default. You can override it with `--sign-identifier` or `PI_COMPUTER_USE_CODESIGN_IDENTIFIER`, but release builds should keep it stable so macOS permissions remain tied to the same helper identity across updates.

Unsigned or ad-hoc signed helpers can work for local development, but macOS treats them as local binaries. Developer ID signing gives the helper a trusted publisher identity, enables notarization, reduces Gatekeeper/TCC friction, and makes permission prompts easier for users to trust. It does not remove the need for the user to grant Screen Recording and Accessibility.

### Remove

```bash
pi remove git:github.com/injaneity/pi-computer-use#v0.1.6
# or remove the npm package from a JS project
npm remove @injaneity/pi-computer-use
```
