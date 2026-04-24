# pi-computer-use

![pi-computer-use](./assets/img.jpg)

Codex-style computer use for Pi on macOS with AX-first semantic targeting, semantic state updates, and image fallback when semantic coverage is weak.

## Latest Release

See the [latest GitHub release](https://github.com/injaneity/pi-computer-use/releases/latest) for the current version, release name, value proposition, changelog, and validation snapshot.

Install:
- GitHub release: `pi install git:github.com/injaneity/pi-computer-use#v0.2.0`.
- npm package: `npm install @injaneity/pi-computer-use@0.2.0`.

> For setup, development, benchmarks, and contribution workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Features

- Public tools: `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`, `type_text`, `set_text`, `wait`, `computer_actions`
- AX target refs in tool results, e.g. `@e1`, with capabilities like `canSetValue`, `canPress`, and `canFocus`
- Ref-first actions such as `click({ ref: "@eN" })`, `scroll({ ref: "@eN" })`, and `set_text({ ref: "@eN", text })` before coordinate/focus fallbacks
- Batched actions via `computer_actions`, returning one post-action semantic state update plus per-action execution metadata
- Execution metadata reports the selected implementation variant: `stealth` for background-safe AX paths, `default` for focus/raw-event fallbacks
- Full pointer/keyboard primitive coverage for common GUI flows, with AX-first equivalents where available: click, double-click, scroll, semantic keypresses, move, drag, text insert, and AX text replacement
- Semantic-first turn updates with image attachment fallback only when needed
- AX-first execution with optional strict AX-only mode via `PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`
- Stealth mode is the widest safe subset: AX/background-safe operations run, while foreground focus, raw keyboard/pointer events, and cursor takeover are blocked
- Browser-aware targeting, including isolated browser window preference when appropriate
- User-visible config for browser control and stealth/strict AX execution
- Non-intrusive helper behavior where possible instead of global cursor takeover
- Official benchmark harness in `benchmarks/` with baseline comparison and regression checks

## Setup

### Install

The package is published on npm as `@injaneity/pi-computer-use`.

#### Pi

```bash
pi install git:github.com/injaneity/pi-computer-use#v0.2.0
# project-local
pi install -l git:github.com/injaneity/pi-computer-use#v0.2.0
# local checkout
pi install /absolute/path/to/pi-computer-use
```

#### npm

```bash
npm install @injaneity/pi-computer-use
# pinned version
npm install @injaneity/pi-computer-use@0.2.0
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

### Computer-use config

Optional JSON config files make browser control and stealth/strict AX mode visible and project-overridable:

```text
~/.pi/agent/extensions/pi-computer-use.json  # global
.pi/computer-use.json                        # project-local override
```

Example:

```json
{
  "browser_use": true,
  "stealth_mode": false
}
```

Defaults preserve existing behavior: browser use is enabled, and stealth mode is disabled. Set `browser_use` to `false` to refuse screenshots/actions against known browser apps. Set `stealth_mode` to `true` to require background-safe Accessibility paths and block foreground/raw pointer or keyboard fallbacks.

Environment overrides:

- `PI_COMPUTER_USE_BROWSER_USE=0|1`
- `PI_COMPUTER_USE_STEALTH_MODE=0|1`
- `PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1` force stealth mode on

Run `/computer-use` in Pi to show the effective config and config sources.

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
pi remove git:github.com/injaneity/pi-computer-use#v0.2.0
# or remove the npm package from a JS project
npm remove @injaneity/pi-computer-use
```
