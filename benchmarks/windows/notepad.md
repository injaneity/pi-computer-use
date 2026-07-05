# Manual Acceptance: Windows Notepad on root-forest tools

Run on a Windows machine with `windows-bridge.exe` installed or buildable.

## Setup

```powershell
node scripts/setup-helper.mjs --platform windows --allow-build
notepad
```

## Checks

1. **Find roots**
   - Use the public root listing/find flow (`find` / root discovery), not legacy `list_windows`.
   - Expected: a Notepad root with an `@r` ref, `kind: window`, exact pairing, non-zero `framePoints`, real `scaleFactor`, and `isFocused` matching the foreground window.

2. **Observe Notepad**
   - Observe the Notepad `@r` root.
   - Expected: `lookId`, `window.rootRef`, `window.kind`, outline nodes with `@e` refs, and an image for the window root.

3. **Grounding rungs**
   - `setText` on the editor `@e` ref: expect `worked` or `unknown` with `evidence.value`.
   - `typeText` on the editor: expect raw input unless `policy: ax_only` is used.
   - `keypress` (`Ctrl+A`, `Delete`, `Enter`): expect SendInput behavior; `ax_only` must fail.
   - `click`/`press` a semantic ref and then a coordinate in the latest image-bearing look.
   - `scroll` a scrollable ref or coordinate if available.

4. **Policy and stale state**
   - Reuse an old `lookId` after enough new observes to evict it: expect `stale_look` and no execution.
   - Use an invalid `@e` ref: expect `stale_ref`.
   - Coordinate act against an outline-only root: expect `coordinate_unavailable_for_root`.

5. **Root deltas**
   - Right-click in Notepad: expect a `menu` root to appear and an act result with `performed.deltaSource` plus a menu `rootDelta`.
   - Open Save As / confirmation dialog: expect a `dialog` root delta.
   - Close the dialog/menu: expect `closed` delta.

6. **DPI**
   - On a display scaled above 100%, verify `scaleFactor` equals approximately `GetDpiForWindow/96` and coordinate clicks land correctly.

7. **Elevated window**
   - Target an elevated app from non-elevated Pi: expect a clear error, not a permission prompt loop.

Record: Windows version, display scale, helper diagnostics protocol version, root refs, look IDs, and all act results including `rootDelta`.
