# Configuration

Configuration controls browser access and strict AX execution.

## Files

Global config:

```text
~/.pi/agent/extensions/pi-computer-use.json
```

Project config:

```text
.pi/computer-use.json
```

Project config overrides global config. Environment variables override both.

Example:

```json
{
  "browser_use": true,
  "stealth_mode": false
}
```

Run `/computer-use` in Pi to show the active config and its source.

## Options

### `browser_use`

Default: `true`

When `false`, the extension refuses known browser windows. This is useful for projects that should not control browsers.

Known browser families include Safari, Chrome and Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `stealth_mode`

Default: `false`

When `true`, actions must use background-safe AX paths. Raw pointer events, raw keyboard events, foreground focus fallback, and cursor takeover are blocked.

This is also called strict AX mode.

## Environment variables

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

`PI_COMPUTER_USE_STEALTH=1` and `PI_COMPUTER_USE_STRICT_AX=1` force strict AX mode.

`PI_COMPUTER_USE_HELPER_VARIANT` defaults to `auto`. macOS 14 and newer use the modern ScreenCaptureKit helper. macOS 12 and 13 use the legacy CGWindow and `screencapture` helper. Override this only for testing.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

When CDP is active:

- `navigate_browser` uses CDP navigation when possible.
- Browser console messages are attached to relevant tool results.
- The desktop scene tools still work for browser windows.

With the variable unset, CDP is inactive.
