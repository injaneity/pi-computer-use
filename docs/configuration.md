# Configuration

Configuration controls browser access, strict accessibility execution, and the macOS agent cursor.

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
  "headless": false,
  "cursor_overlay": true
}
```

Run `/computer-use` in Pi to show the active config and its source.

## Options

### `browser_use`

Default: `true`

When `false`, the extension refuses known browser windows. This is useful for projects that should not control browsers.

Known browser families include Safari, Chrome and Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `headless`

Default: `false`

When `true`, actions must remain in the background. Raw pointer events, raw keyboard events, foreground focus fallback, cursor takeover, and the agent cursor overlay are blocked. When `false` (the default), Pi still attempts verified background delivery first and falls back to foreground only after a typed `foreground_required` result proves that the background attempt caused no action.

### `cursor_overlay`

Default: `true`

When `true`, macOS pointer actions enqueue a click-through agent cursor animation to the native grounded point for both accessibility and physical delivery. It doesn't move the system pointer, accept input, or delay the action. Set it to `false` for invisible automation. `headless: true` always suppresses it regardless of this setting.

## Environment variables

```bash
PI_COMPUTER_USE_BROWSER_USE=0
PI_COMPUTER_USE_BROWSER_USE=1
PI_COMPUTER_USE_HEADLESS=0
PI_COMPUTER_USE_HEADLESS=1
PI_COMPUTER_USE_CURSOR_OVERLAY=0
PI_COMPUTER_USE_CURSOR_OVERLAY=1
PI_COMPUTER_USE_DELIVERY_POLICY=default
PI_COMPUTER_USE_DELIVERY_POLICY=foreground
PI_COMPUTER_USE_CDP_PORT=9222
```

`PI_COMPUTER_USE_HEADLESS=1` prohibits foreground fallback. `PI_COMPUTER_USE_DELIVERY_POLICY` is a debugging input; normal callers should use `headless`.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

When CDP is active:

- `navigate_browser` uses CDP navigation when possible.
- Browser console messages are attached to relevant tool results.
- The desktop observe/act tools still work for browser windows.

With the variable unset, CDP is inactive.
