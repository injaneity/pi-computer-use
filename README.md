# pi-computer-use

Add Codex-style computer-use tools to Pi on macOS.

This package bundles:
- a Pi extension that adds screenshot, mouse, and keyboard tools
- a skill that teaches the agent how to use those tools reliably
- a native macOS helper used for screenshots and input dispatch

## What you get

Public tools:
- `screenshot`
- `click`
- `double_click`
- `move_mouse`
- `drag`
- `scroll`
- `type_text`
- `keypress`
- `wait`

## Requirements

- macOS 15+
- Pi / `@mariozechner/pi-coding-agent`
- Node.js 20.6+
- Accessibility and Screen Recording permission for the helper binary

## Install

### Global install

```bash
pi install npm:pi-computer-use
```

### Project-local install

```bash
pi install -l npm:pi-computer-use
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
- `type_text` prefers AX value setting before paste/raw key fallbacks

## Build the helper manually

If you need to build the helper yourself:

```bash
npm run build:native
```

You can also build to a custom output path:

```bash
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

## Remove

```bash
pi remove npm:pi-computer-use
```

## License

MIT
