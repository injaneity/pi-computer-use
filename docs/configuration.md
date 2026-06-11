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
PI_COMPUTER_USE_HELPER_VARIANT=auto
PI_COMPUTER_USE_HELPER_VARIANT=modern
PI_COMPUTER_USE_HELPER_VARIANT=legacy
PI_COMPUTER_USE_CDP_PORT=9222
```

`PI_COMPUTER_USE_STEALTH=1` and `PI_COMPUTER_USE_STRICT_AX=1` force `stealth_mode` on. `PI_COMPUTER_USE_HELPER_VARIANT` is normally `auto`: macOS 14+ uses the modern ScreenCaptureKit helper, while macOS 12/13 uses the legacy CGWindow/screencapture helper. Override it only for testing or troubleshooting.

## Optional CDP Acceleration

`PI_COMPUTER_USE_CDP_PORT` opts in to a Chrome DevTools Protocol backend for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set the env var to the same port. When active:

- `navigate_browser` uses `Page.navigate` with an event-driven page-load wait instead of AppleScript and fixed settle delays, and does not change window focus.
- Recent browser console messages and uncaught exceptions are appended to tool results for the controlled browser window (`details.console`), which helps web debugging tasks.

The agent-facing tools are unchanged. With the env var unset (the default), the CDP backend is fully inert and all actions use the AX/CGEvent path. Tab matching uses the window title, the window's screen frame, and tab visibility; non-Chromium browsers always use the AX path.

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

In strict AX mode, open any dedicated browser window yourself before asking Pi to control it.
