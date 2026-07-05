# Manual Acceptance: Windows Notepad on root-forest tools

Run on Windows with `windows-bridge.exe` installed or buildable.

## Setup

```powershell
node scripts/setup-helper.mjs --platform windows --allow-build
notepad
```

## Checks

1. **Find and observe roots**
   - Use the public root discovery flow, not legacy `list_windows`.
   - Expected: a Notepad `@r` root with `kind: window`, exact pairing, non-zero `framePoints`, real `scaleFactor`.
   - Observe it. Expected: `lookId`, `window.rootRef`, `window.kind`, image, and outline nodes with `@e` refs.

2. **Semantic grounding**
   - Open a Notepad dialog with real buttons, e.g. Save As or Find.
   - Click a button by `@e` ref.
   - Expected: `performed.grounding = "description"`, `performed.delivery = "ax"`; for InvokePattern buttons, `outcome = "worked"`.

3. **setText read-back**
   - In the Find dialog, `setText` the find text field by `@e` ref.
   - Expected: `performed.grounding = "description"`, `delivery = "ax"`, and `evidence.value` equals the value actually read back.

4. **Policy**
   - Repeat a pattern-grounded button click with `policy: ax_only`: expected to work.
   - Try coordinate click or `typeText` with `policy: ax_only`: expected `coordinate_blocked` and no execution.

5. **Live reads and waits**
   - After observing, change text in the UI by typing manually or via an action.
   - `readText` on the text ref should return the changed live text.
   - `waitFor` should detect text that appears after the last observe.

6. **Root deltas**
   - Right-click in Notepad: expect a `menu` root delta and `performed.deltaSource` (`win-poll` or `snapshot`).
   - Open a dialog: expect `dialog` appeared delta.
   - Close dialog/menu: expect closed delta.
   - Perform two acts after one look; the second act must not re-report the first act's root delta.

7. **Occlusion**
   - Cover a target control with another window and click the original `@e` ref.
   - Expected: `occluded_target` unless the preflight cannot determine the hit element, in which case outcome must be capped at `unknown`.

8. **DPI and elevation**
   - On a display scaled above 100%, verify `scaleFactor ~= GetDpiForWindow/96` and coordinate fallback lands correctly.
   - Target an elevated app from non-elevated Pi: expect a clear error, not a permission prompt loop.

Record Windows version, display scale, helper diagnostics protocol version, root refs, look IDs, and all act results including `rootDelta`.
