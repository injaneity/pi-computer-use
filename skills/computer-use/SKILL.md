---
name: computer-use
description: Interact with macOS GUI windows using semantic screenshots, clicks, typing, and waits. Use this when the task requires operating a visible app window.
---

# Computer Use

Use these tools when shell/file tools are not enough and you need to operate a macOS app window directly.

## Core workflow

1. **Call `screenshot` first** to pick the target window and get current UI state.
2. If the latest screenshot includes AX target refs, use those first for `click`. Use coordinates from the **latest screenshot** only when no suitable AX target is available.
3. To switch apps/windows, call `screenshot(app, windowTitle)` again.
4. For text input, usually:
   - click the field to focus it
   - call `type_text({ text })`
5. Use `keypress({ keys })` for Enter, Tab, Escape, arrows, deletion, and shortcuts.
6. Use `computer_actions({ actions })` to batch obvious actions like click + type + Enter when no intermediate screenshot is needed.
7. Every successful action returns the **latest semantic state**. If AX targets are missing, sparse, or ambiguous, an image is attached for vision fallback.

## Practical rules

- All action tools operate on the **current controlled window**.
- For browsers, prefer a **separate window** for agent work, not a new tab in the user's current window.
- In strict AX mode, do not bootstrap a new browser window; use an already-open dedicated browser window instead.
- `screenshot` may include compact AX targets like `@e1`; prefer `click({ ref: "@e1" })` whenever a listed target matches what you want.
- Coordinates are **window-relative screenshot pixels** (top-left origin).
- `captureId` is optional. If provided and stale, refresh with `screenshot`.
- `type_text` inserts text at the current cursor/selection. Use `set_text` only when you need to replace the focused AX text value.
- `scroll`, `move_mouse`, `drag`, `double_click`, and coordinate clicks use screenshot-relative coordinates from the latest screenshot.
- For shortcut sequences, use chord strings like `keypress({ keys: ["Command+L", "Enter"] })`; reserve `["Command", "L"]` for a single chord call.
- `computer_actions` executes one to twenty actions and returns one state update plus per-action execution metadata. Do not batch if the next action depends on seeing an intermediate result.
- `wait({ ms })` pauses and then returns the latest semantic state for polling/loading states.
- Accessibility permission is mandatory for actions.
- Screen Recording permission is mandatory for screenshots and model vision context.
- Public tool surface is `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`, `type_text`, `set_text`, `wait`, `computer_actions`.
- Default mode has built-in screenshot/vision grounding and is AX-first with fallback when a control cannot be completed semantically.
- Opt-in stealth mode (`PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`) blocks fallback paths and stays AX-only.
- In stealth mode, operation must stay background-safe: no second screen or virtual display, no foreground activation, and no physical cursor takeover.

## When errors happen

If an action reports stale state, target mismatch, or missing target/window, call `screenshot` again to refresh and continue.
