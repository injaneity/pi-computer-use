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
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "jev_enabled": false,
  "jev_decide": true,
  "jev_backend": "auto",
  "jev_model": "typesafe-ai/jev",
  "jev_gateway_zdr": false,
  "jev_max_steps": 60
}
```

Run `/computer-use` in Pi to show the active config and its source. Run
`/computer-use jev on|off` or `/computer-use jev-decide on|off` to override the
jev switches for the current session.

## Options

### `browser_use`

Default: `true`

When `false`, the extension refuses known browser windows. This is useful for projects that should not control browsers.

Known browser families include Safari, Chrome and Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `managed_browser`

Default: `"chrome"`

Selects `"helium"` or `"chrome"` for `launch_browser`. The debugging port is always allocated internally and isn't part of the model-facing contract.

### `headless`

Default: `false`

When `true`, actions must remain in the background. Raw pointer events, raw keyboard events, foreground focus fallback, cursor takeover, and the agent cursor overlay are blocked. When `false` (the default), Pi prefers verified semantic activation when it is credible, preserves the focus established by editable clicks for dependent keyboard input, and may retry keyboard input in the foreground when a background attempt conclusively produced no value change. Ambiguous pointer actions are never replayed blindly.

### `cursor_overlay`

Default: `true`

When `true`, macOS pointer actions enqueue a click-through agent cursor animation to the native grounded point during non-headless background delivery. Foreground actions that control the physical cursor don't display the overlay. The overlay doesn't move the system pointer, accept input, or delay the action. Set it to `false` for invisible automation. `headless: true` always suppresses it regardless of this setting.

### `jev_enabled`

Default: `false`

Master switch for the jev browser layer (`jev_observe`, `jev_step`, `jev_run`).
It is off by default because jev decision-making needs an additional credential.
When `false`, the jev tools are not active: they contribute no prompt snippet
and cannot be called, and the base tools are unaffected. Enable it with
`jev_enabled: true`, `PI_COMPUTER_USE_JEV_ENABLED=1`, or `/computer-use jev on`
(which activates them immediately). See [Jev browser layer](./jev.md).

### `jev_decide`

Default: `true`

Controls jev decision-making. When `true` and a decision credential is set
(`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `VERCEL_API_KEY`, or
`TYPESAFE_AI_API_KEY` for the Vercel AI SDK backend; `TYPESAFE_API_KEY` for the
direct transport), `jev_step` can choose the operation and target itself (omit
`action` and pass `goal`) and `jev_run` can drive a bounded autonomous loop.
When `false`, the indexed action space and guarded execution remain available,
but the decision backend is refused and `jev_step` requires an explicit
`action`. The earlier `jev_policy` spelling is accepted as an alias.

### `jev_backend`

Default: `"auto"`

Selects the jev decision transport. `auto` prefers the Vercel AI SDK backend
(`experimental_evaluate` from `ai`) when `AI_GATEWAY_API_KEY`,
`VERCEL_OIDC_TOKEN`, `VERCEL_API_KEY`, or `TYPESAFE_AI_API_KEY` is set, then
falls back to the direct TypeSafe HTTP transport when `TYPESAFE_API_KEY` is set.
`"vercel"` forces the AI SDK backend and `"typesafe"` forces the direct
transport. See [Jev browser layer](./jev.md).

### `jev_model`

Default: unset

Overrides the decision model id. Backend defaults are `typesafe-ai/jev` for
Vercel AI Gateway and `jev-latest` for the direct TypeSafe providers.

### `jev_gateway_zdr`

Default: `false`

When `true`, Vercel AI Gateway evaluations request Zero Data Retention via
`providerOptions.gateway.zeroDataRetention`.

### `jev_max_steps`

Default: `60`

Action budget for one `jev_run`, clamped to `1`–`60` and also bounded by the
engine's own hard limit.

## Environment variables

```bash
PI_COMPUTER_USE_BROWSER_USE=0
PI_COMPUTER_USE_BROWSER_USE=1
PI_COMPUTER_USE_MANAGED_BROWSER=helium
PI_COMPUTER_USE_MANAGED_BROWSER=chrome
PI_COMPUTER_USE_CHROME_EXECUTABLE=/absolute/path/to/chrome
PI_COMPUTER_USE_HELIUM_EXECUTABLE=/absolute/path/to/helium
PI_COMPUTER_USE_HEADLESS=0
PI_COMPUTER_USE_HEADLESS=1
PI_COMPUTER_USE_CURSOR_OVERLAY=0
PI_COMPUTER_USE_CURSOR_OVERLAY=1
PI_COMPUTER_USE_JEV_ENABLED=0
PI_COMPUTER_USE_JEV_ENABLED=1
PI_COMPUTER_USE_JEV_DECIDE=0
PI_COMPUTER_USE_JEV_DECIDE=1
PI_COMPUTER_USE_JEV_BACKEND=auto
PI_COMPUTER_USE_JEV_BACKEND=typesafe
PI_COMPUTER_USE_JEV_BACKEND=vercel
PI_COMPUTER_USE_JEV_MODEL=typesafe-ai/jev
PI_COMPUTER_USE_JEV_GATEWAY_ZDR=1
PI_COMPUTER_USE_JEV_MAX_STEPS=20
PI_COMPUTER_USE_DELIVERY_POLICY=default
PI_COMPUTER_USE_DELIVERY_POLICY=foreground
PI_COMPUTER_USE_CDP_PORT=9222
```

`PI_COMPUTER_USE_HEADLESS=1` prohibits foreground fallback. `PI_COMPUTER_USE_DELIVERY_POLICY` is a debugging input; normal policy belongs in configuration rather than individual model calls.

`PI_COMPUTER_USE_JEV_ENABLED` and `PI_COMPUTER_USE_JEV_DECIDE` override the jev
switches; `PI_COMPUTER_USE_JEV_POLICY` is accepted as an alias for the latter.
`PI_COMPUTER_USE_JEV_BACKEND`, `PI_COMPUTER_USE_JEV_MODEL`, and
`PI_COMPUTER_USE_JEV_GATEWAY_ZDR` select and configure the decision transport.
Jev credentials (`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `VERCEL_API_KEY`,
`TYPESAFE_AI_API_KEY`, `TYPESAFE_API_KEY`, `TEXT_MODEL_API_KEY`, and their
optional model/endpoint variables) are read from the environment only and are
never written to configuration files. See [Jev browser layer](./jev.md).

`launch_browser` searches common platform install locations and `PATH`. Use `PI_COMPUTER_USE_CHROME_EXECUTABLE` or `PI_COMPUTER_USE_HELIUM_EXECUTABLE` for an AppImage, portable install, or any non-standard location. An explicit override is authoritative and must name an executable file.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

Use a dedicated, non-default profile with `--user-data-dir=<directory>`. Chrome 136 and later ignore remote-debugging switches for the default data directory as a security measure. `launch_browser` already creates a temporary, separate CDP profile and binds discovery to a randomly allocated loopback port.

When CDP is active, discovered pages participate in the same root and state system as desktop UI. `launch_browser` configures CDP automatically and returns an observed page state. `navigate_browser` and `evaluate_browser` accept only CDP browser-page states; native browser windows continue to use the normal desktop observe/act tools.

With the variable unset, CDP is inactive.
