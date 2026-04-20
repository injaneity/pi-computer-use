---
name: computer-use
description: Interact with macOS GUI windows using screenshots, clicks, double-clicks, mouse movement, dragging, scrolling, typing, keypresses, and waits. Use this when the task requires operating a visible app window.
---

# Computer Use

Use these tools when shell/file tools are not enough and you need to operate a macOS app window directly.

## Core workflow

1. **Call `screenshot` first** to pick the target window and get current UI state.
2. Use coordinates from the **latest screenshot** for `click`, `double_click`, `move_mouse`, `drag`, and `scroll`.
3. To switch apps/windows, call `screenshot(app, windowTitle)` again.
4. For text input, usually:
   - click the field to focus it
   - call `type_text({ text })`
5. Every successful action returns a **fresh screenshot**. Use that newest image for your next step.

## Practical rules

- All action tools operate on the **current controlled window**.
- Coordinates are **window-relative screenshot pixels** (top-left origin).
- `captureId` is optional. If provided and stale, refresh with `screenshot`.
- `keypress` uses key arrays such as `['CMD','L']`, `['SHIFT','TAB']`, `['ENTER']`.
- `wait({ ms })` pauses and then returns a fresh screenshot for polling/loading states.
- Runtime is AX-first where possible (for example some typing/click paths), with coordinate-event fallback when AX is unavailable.

## When errors happen

If an action reports stale state, target mismatch, or missing target/window, call `screenshot` again to refresh and continue.
