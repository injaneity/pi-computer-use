# pi-computer-use Manual QA Report

Date: 2026-04-20
Command run:

```bash
# foreground app-driving QA is opt-in
npx -y tsx scripts/manual-qa.ts --allow-foreground-qa
```

By default, `scripts/manual-qa.ts` now exits early unless `--allow-foreground-qa` (or `PI_COMPUTER_USE_ALLOW_FOREGROUND_QA=1`) is provided, to avoid stealing user focus while you work.

## Summary

- PASS: 16
- FAIL: 0
- SKIP: 4

## Passing checks

- Environment setup (opened TextEdit + Finder)
- User-context baseline captured (frontmost app + mouse snapshot for diagnostics)
- Missing target error (`click` before `screenshot`)
- `screenshot()` frontmost fallback
- Target switching (`screenshot(app)` across apps)
- User top-level view preserved during cross-app screenshot targeting
- Stale `captureId` validation
- Mouse actions with fresh screenshot refresh:
  - `move_mouse`
  - `click`
  - `double_click`
  - `scroll`
  - `click` with omitted `captureId`
- Drag validation error (`path.length >= 2`)
- `drag` success path
- `wait` returns fresh screenshot
- `keypress` shortcut normalization path
- `type_text` success + clipboard restore verification
- Minimized-window behavior under non-intrusive mode:
  - action is blocked with an actionable screenshot-refresh error
  - user-facing app remains in control
- Session reconstruction success (`reconstructStateFromBranch` + `wait`)
- Missing target after resume errors cleanly

## Skipped checks

These require physical/manual setup that was not guaranteed from the harness environment:

- Multi-display validation (non-primary + mixed DPI)
- Off-Space window validation
- Forcing typing fallback-path isolation (paste rejection/raw key fallback)
- Secure field leakage validation

## Key fixes implemented in this pass

1. **Non-intrusive input dispatch**
   - Mouse and keyboard events now target app PIDs (`CGEvent.postToPid`) instead of global HID posting.
   - This avoids commandeering the physical system cursor for standard actions.

2. **No forced focus restoration (strict background mode)**
   - Removed runtime focus-restoration logic that could itself steal focus.
   - Tool dispatch now avoids any automatic `activate/raise/unminimize` behavior in normal action flow.

3. **Removed intrusive post-action capture recovery**
   - Runtime no longer force-activates/raises windows just to recover screenshots after actions.
   - For minimized/unavailable windows in non-intrusive mode, tools return actionable errors instead of stealing focus.

4. **Helper timeout hardening**
   - Added timeouts to ScreenCaptureKit screenshot and window-bounds probes.
   - Prevents helper hangs (previously surfaced as helper SIGTERM after timeout kill).

5. **Ghost cursor state support**
   - Runtime now tracks virtual/ghost cursor coordinates in tool `details` for coordinate actions.
   - This decouples model-facing pointer state from physical cursor control.
