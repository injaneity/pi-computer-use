# Troubleshooting

## Helper app is missing

Install the helper from the package:

```bash
node scripts/setup-helper.mjs --runtime
```

Or rebuild it locally:

```bash
npm run build:native
node scripts/setup-helper.mjs --force
```

The helper app should exist at:

```text
/Applications/pi-computer-use.app
```

## macOS permissions fail

Grant these permissions to `/Applications/pi-computer-use.app`:

- Accessibility
- Screen Recording, shown as Screen and System Audio Recording on newer macOS versions

If access is still denied:

1. Start Pi interactively.
2. Let `pi-computer-use` open the permission pane.
3. Enable `pi-computer-use.app` in each missing permission pane.
4. If the app is not listed, click `+`, choose Applications, select `pi-computer-use.app`, then enable it.
5. Restart Pi if macOS asks.

Older versions used other helper identities such as `bridge`, Terminal, Ghostty, node, Codex, or `PiComputerUseBridge.app`. Those are not current. Grant access to `pi-computer-use.app`.

## Non-interactive setup fails

macOS permission setup requires an interactive user session. Start Pi interactively, grant permissions, then retry the non-interactive workflow.

## Browser windows are refused

Check the active config:

```text
/computer-use
```

If `browser_use` is disabled, enable it in either config file:

```json
{
  "browser_use": true
}
```

## Strict AX mode blocks an action

Strict AX mode blocks raw pointer events, raw keyboard events, foreground focus fallback, and cursor takeover.

Use refs from the latest `observe` result. If the workflow needs raw events, disable strict AX mode.

## State or refs are stale

Refs and coordinates belong to the latest observed state. Call `observe` again and retry with the new `stateId`.

The bridge can sometimes reacquire stale AX refs by role, label, capability, and position, but this is not guaranteed.

## Coordinates are rejected

Coordinates are window-relative screenshot pixels from the latest observation. They are invalid if:

- the window changed size
- the target window changed
- a new observation was captured
- the coordinate is outside the captured bounds

Call `observe` again and retry.

## Capture fails

Check that:

- Screen Recording is granted.
- The target app has an open window.
- The window was not closed between `observe` and `act`.
- The app is running on macOS.

If the target is ambiguous, specify the app and window title:

```ts
observe({ app: "TextEdit", windowTitle: "Untitled" })
```

## Apple Events JavaScript is disabled

Some browser fallback paths require the browser setting "Allow JavaScript from Apple Events". If this is needed, the error message will say so. Enable the setting in the browser and retry.
