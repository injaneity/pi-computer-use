---
name: computer-use
description: Interact with macOS GUI windows using semantic screenshots, clicks, typing, and waits. Use this when the task requires operating a visible app window.
---

# Computer Use

Use these tools when shell/file tools are not enough and you need to operate a macOS app window directly.

## Core workflow

1. **Call `screenshot` first** to pick the target window and get current UI state.
2. Use coordinates from the **latest screenshot** for `click`.
3. To switch apps/windows, call `screenshot(app, windowTitle)` again.
4. For text input, usually:
   - click the field to focus it
   - call `type_text({ text })`
5. Every successful action returns a **fresh screenshot**. Use that newest image for your next step.

## Practical rules

- All action tools operate on the **current controlled window**.
- For browsers, prefer a **separate window** for agent work, not a new tab in the user's current window.
- In strict AX mode, do not bootstrap a new browser window; use an already-open dedicated browser window instead.
- Coordinates are **window-relative screenshot pixels** (top-left origin).
- `captureId` is optional. If provided and stale, refresh with `screenshot`.
- `wait({ ms })` pauses and then returns a fresh screenshot for polling/loading states.
- Accessibility permission is mandatory for actions.
- Screen Recording permission is mandatory for screenshots and model vision context.
- Public tool surface is `screenshot`, `click`, `type_text`, `wait`.
- Default mode has built-in screenshot/vision grounding and is AX-first with fallback when a control cannot be completed semantically.
- Opt-in stealth mode (`PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`) blocks fallback paths and stays AX-only.
- In stealth mode, operation must stay background-safe: no second screen or virtual display, no foreground activation, and no physical cursor takeover.

## When errors happen

If an action reports stale state, target mismatch, or missing target/window, call `screenshot` again to refresh and continue.
