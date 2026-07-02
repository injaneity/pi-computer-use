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

The setup flow registers the helper with TCC before opening System
Settings, so `pi-computer-use.app` is already listed in both panes — enable
its toggle and choose **Recheck**. Recheck restarts the helper on purpose:
macOS caches permission answers per process, so a helper that started
before the grant would keep reporting "missing" forever.

Older versions used other helper identities such as `bridge`, Terminal, Ghostty, node, Codex, or `PiComputerUseBridge.app`. Those are not current. Grant access to `pi-computer-use.app`.

To see exactly which identity macOS is charging for a permission check:

```bash
log stream --debug --predicate 'subsystem == "com.apple.TCC" AND eventMessage BEGINSWITH "AttributionChain"'
```

## Permission status says granted but capture is black / AX is empty

`checkPermissions` reports two Screen Recording signals: the TCC database
boolean (`screenRecordingPreflight`) and a live ScreenCaptureKit probe
(authoritative). When the preflight reads granted but the live probe fails,
the grant row belongs to a different identity than the running helper —
usually because the helper was re-signed or updated (TCC keys grant rows to
the code signature), or because it is not running as the canonical app (see
next section). Re-toggle the grant in System Settings, or reset and
re-grant:

```bash
tccutil reset Accessibility com.injaneity.pi-computer-use
tccutil reset ScreenCapture com.injaneity.pi-computer-use
```

An empty AX tree with Accessibility "granted" is the per-process cache
again: the grant landed after the helper started. Recheck (which restarts
the helper) or restart Pi.

## Permission source says "caller"

`checkPermissions` returns `source.attribution`:

- `helper-app` — the canonical installed app, launched via LaunchServices.
  Grants belong to `pi-computer-use.app`. This is the normal case.
- `caller` — the bridge is running as a plain binary (dev build, spawned
  from a terminal). Its permission checks are answered with the *launching
  app's* grants (your terminal), and any grant made now attaches to that
  identity, not the helper. Restart Pi so the installed app is used.

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
