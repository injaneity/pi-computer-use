# pi-computer-use

**Demo:** [`pi-computer-use.mp4`](./assets/pi-computer-use.mp4)

![pi-computer-use](./assets/img.jpg)

Add Codex-style computer-use tools to Pi on macOS.

This package bundles:
- a Pi extension that adds semantic computer-use tools
- a skill that teaches the agent how to use those tools reliably
- a native macOS helper used for screenshots and AX dispatch

## What you get

Public tools:
- `screenshot`
- `click`
- `type_text`
- `wait`

## Requirements

- macOS 15+
- Pi / `@mariozechner/pi-coding-agent`
- Node.js 20.6+
- Accessibility and Screen Recording permission for the helper binary

## Install

`pi-computer-use` currently resolves to an unrelated package. Install this package from GitHub or a local checkout instead.

### Global install

```bash
pi install git:github.com/injaneity/pi-computer-use
```

### Project-local install

```bash
pi install -l git:github.com/injaneity/pi-computer-use
```

### Install from a local checkout

```bash
pi install /absolute/path/to/pi-computer-use
# or
pi install -l /absolute/path/to/pi-computer-use
```

This follows the standard Pi package install flow used by other Pi packages.

## What happens after install

- Pi loads the extension from `extensions/`
- Pi loads the skill from `skills/`
- the helper is installed to:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

The package tries to copy a bundled prebuilt helper during `postinstall`. If a matching prebuilt is not available, the runtime can build one locally on first use.

## First run

Start Pi in interactive mode and ask it to use the computer-use tools.

On first use, the package will guide you through granting:
- Accessibility
- Screen Recording

Accessibility is treated as mandatory for AX-first computer use. Screen Recording is required for window screenshots.

Grant both permissions to the helper at:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

## Example prompts

- `Use the computer-use tools to inspect the frontmost window.`
- `Take a screenshot of the current window and click the Continue button.`
- `Switch to Safari, open the current tab area, and report what you see.`

## Notes

- Target platform: macOS only
- `screenshot` should be called first to choose a target window
- Successful actions return a fresh screenshot for the next step
- The helper uses a non-intrusive strategy where possible instead of taking over your cursor globally
- Accessibility is mandatory: the runtime is being pushed toward AX-first/background-first behavior
- Public tool surface is semantic-only: `screenshot`, `click`, `type_text`, `wait`
- `click` is AX-only semantic press/focus, not pointer-event fallback
- `type_text` is AX value-setting only, not clipboard or raw key fallback
- Tool results include execution metadata so we can verify that actions stayed on AX paths
- The runtime remains on the current desktop/session only: no second screen or virtual display, no foreground activation, and no physical cursor takeover

## Build the helper manually

If you need to build the helper yourself:

```bash
node scripts/build-native.mjs
```

You can also build to a custom output path:

```bash
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

## Remove

```bash
pi remove git:github.com/injaneity/pi-computer-use
```

## License

MIT
