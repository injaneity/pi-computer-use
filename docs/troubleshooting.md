# Troubleshooting

## The Helper Is Missing Or Not Executable

Reinstall the helper from the package:

```bash
node scripts/setup-helper.mjs --runtime
```

Or build it locally:

```bash
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

Confirm the helper exists:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

## macOS Permissions Still Fail

Grant both permissions to the helper:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required permissions:

- Accessibility
- Screen Recording

If macOS still denies access:

1. Remove the helper from the permission list instead of only toggling it off/on.
2. If there are multiple helper rows with the same name, remove all of them.
3. Start Pi again and let `pi-computer-use` request permission for the current helper. The setup flow opens the settings pane and copies the helper path to your clipboard.
4. Enable the newly added helper row.
5. If the helper is not added automatically, click `+`, press `Cmd+Shift+G`, paste the copied helper path, add the helper, then enable it.
6. Restart Pi or the Mac if macOS asks, then retry `screenshot`. The Recheck action reports which permission is still missing.

macOS can keep stale Screen Recording entries for an older ad-hoc-signed helper after the helper binary changes. The setup script preserves an existing executable helper by default to avoid changing its macOS permission identity unnecessarily. To intentionally replace it, run setup with `--force` or set `PI_COMPUTER_USE_FORCE_HELPER_INSTALL=1`.

## Non-Interactive Setup Fails

Permission setup requires an interactive Pi session because macOS permission panes are user-controlled.

Start Pi interactively, grant permissions, then retry the non-interactive workflow.

## A Browser Says JavaScript From Apple Events Is Disabled

Some browser automation paths require the browser's per-app **Allow JavaScript from Apple Events** setting. If a browser returns the related Apple Events error, the tool error includes a model-readable hint to ask the user to enable the setting in the browser's developer menu, then retry the browser action.

macOS/browser vendors do not provide a safe way for Pi to enable this setting automatically.

## Browser Windows Are Refused

Check the effective config:

```text
/computer-use
```

If `browser_use` is disabled, enable it in one of:

```text
~/.pi/agent/extensions/pi-computer-use.json
.pi/computer-use.json
```

Example:

```json
{
  "browser_use": true
}
```

## Strict AX Mode Blocks An Action

Strict AX mode blocks:

- raw pointer events
- raw keyboard events
- foreground focus fallbacks
- cursor takeover
- non-AX browser bootstrap

Use AX refs from the latest `screenshot`, open a dedicated browser window manually, or disable strict AX mode for workflows that require raw event fallback.

## Coordinates Are Rejected As Stale

Coordinates are valid only for the latest screenshot state. Call `screenshot` again and retry with the new `stateId`.

## An AX Ref Is Missing Or Stale

AX refs are scoped to the latest semantic state. Call `screenshot` or `wait` to refresh the target list.

The bridge attempts stale-ref recovery for compatible role, label, capability, and position matches, but not every stale ref can be safely recovered.

## Screenshot Or Window Capture Fails

Confirm:

- Screen Recording is granted.
- The target app has an open, controllable window.
- The window is not closed or hidden between `screenshot` and action.
- You are running on macOS.

If the target is ambiguous, call `screenshot` with both app and window title:

```ts
screenshot({ app: "TextEdit", windowTitle: "Untitled" })
```
