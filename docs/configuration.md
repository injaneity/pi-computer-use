# Configuration

`pi-computer-use` has a small configuration surface: browser control and strict AX execution.

## Config Files

Global config:

```text
~/.pi/agent/extensions/pi-computer-use.json
```

Project-local override:

```text
.pi/computer-use.json
```

Example:

```json
{
  "browser_use": true,
  "stealth_mode": false
}
```

Project-local config overrides global config. Environment variables override both files.

Run `/computer-use` in Pi to show the effective config and source status.

## Options

### `browser_use`

Default: `true`

When `false`, screenshots and actions against known browser apps are refused. This is useful when a project should avoid controlling browser windows.

Known browser families include Safari, Chrome/Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `stealth_mode`

Default: `false`

When `true`, the extension requires background-safe AX execution and blocks foreground focus, raw keyboard input, raw pointer input, and cursor takeover.

This mode is also referred to as strict AX mode.

## Environment Overrides

```bash
PI_COMPUTER_USE_BROWSER_USE=0
PI_COMPUTER_USE_BROWSER_USE=1
PI_COMPUTER_USE_STEALTH_MODE=0
PI_COMPUTER_USE_STEALTH_MODE=1
PI_COMPUTER_USE_STEALTH=1
PI_COMPUTER_USE_STRICT_AX=1
```

`PI_COMPUTER_USE_STEALTH=1` and `PI_COMPUTER_USE_STRICT_AX=1` force `stealth_mode` on.

## Recommended Defaults

For normal interactive use:

```json
{
  "browser_use": true,
  "stealth_mode": false
}
```

For background-safe operation:

```json
{
  "browser_use": true,
  "stealth_mode": true
}
```

In strict AX mode, open any dedicated browser window yourself before asking Pi to control it. Browser window bootstrap can require non-AX automation and may be refused.
