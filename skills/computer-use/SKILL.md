---
name: computer-use
description: Interact with macOS GUI windows using semantic screenshots, clicks, typing, and waits. Use this when the task requires operating a visible app window.
---

# Computer Use

Use these tools when shell/file tools are not enough and you need to operate a macOS app window directly.

## Core workflow

1. **Call `screenshot` first** to pick the target window and get current UI state.
2. If the latest screenshot includes AX target refs, use those first for `click`. Use coordinates from the **latest screenshot** only when no suitable AX target is available.
3. To discover/switch apps or windows, use `list_apps`, `list_windows`, then `screenshot({ window: "@w1" })` or pass `window` to action tools.
4. For text input, prefer `set_text({ ref: "@eN", text })` when the screenshot exposes a matching AX text target. Use click + `type_text({ text })` when you need insertion/cursor semantics.
5. Use `keypress({ keys })` for Enter, Tab, Escape, arrows, deletion, and shortcuts. Enter/Escape/Space try semantic AX actions first when possible.
6. Use `computer_actions({ actions })` to batch obvious actions like click + type + Enter when no intermediate screenshot is needed.
7. Every successful action returns the **latest semantic state**. If AX targets are missing, sparse, or ambiguous, an image is attached for vision fallback.

## Practical rules

- Action tools operate on the **current controlled window** by default, or an explicit `window` ref/id when provided.
- For browsers, prefer a **separate window** for agent work, not a new tab in the user's current window.
- In strict AX mode, do not bootstrap a new browser window; use an already-open dedicated browser window instead.
- `screenshot` may include compact AX targets like `@e1`; prefer refs for `click({ ref: "@e1" })` and `set_text({ ref: "@e1", text })` whenever a listed target matches what you want. For `set_text`, prefer targets marked `canSetValue`.
- Coordinates are **window-relative screenshot pixels** (top-left origin).
- `stateId` is optional. If provided and stale, refresh with `screenshot`.
- `type_text` inserts text at the current cursor/selection. Use `set_text` when you need to replace an AX text value; prefer a ref over relying on focus.
- `scroll` can use an AX ref marked `scroll` or screenshot-relative coordinates from the latest screenshot; refs are preferred in stealth mode. `drag` can use a ref marked `adjust` plus a path for sliders/steppers, otherwise it uses screenshot-relative path points. `move_mouse`, `double_click`, and coordinate clicks use screenshot-relative coordinates from the latest screenshot.
- For shortcut sequences, use chord strings like `keypress({ keys: ["Command+L", "Enter"] })`; reserve `["Command", "L"]` for a single chord call. In stealth mode, only keypresses with safe AX equivalents, such as focused Enter/Escape/Space actions, can run. In browser windows, `Command+L` tries to focus the address/search field via AX so the next `type_text` can replace it without raw keyboard input.
- `computer_actions` executes one to twenty actions and returns one state update plus per-action execution metadata, including whether each action used the `stealth` or `default` implementation variant. Do not batch if the next action depends on seeing an intermediate result.
- `wait({ ms })` pauses and then returns the latest semantic state for polling/loading states.
- Accessibility permission is mandatory for actions.
- Screen Recording permission is mandatory for screenshots and model vision context.
- Public tool surface is `list_apps`, `list_windows`, `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`, `type_text`, `set_text`, `wait`, `arrange_window`, `computer_actions`.
- Run `/computer-use` to show effective config. Config files are `~/.pi/agent/extensions/pi-computer-use.json` globally and `.pi/computer-use.json` per project.
- `browser_use=false` blocks control of known browser apps. `stealth_mode=true` requires background-safe AX execution.
- Default mode has built-in screenshot/vision grounding and is AX-first with fallback only when a control cannot be completed semantically.
- Opt-in stealth mode (`PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`) exposes the widest safe subset: AX/background-safe operations run, but non-AX fallbacks are blocked.
- In stealth mode, operation must stay background-safe: no second screen or virtual display, no foreground activation, no raw keyboard/pointer events, and no physical cursor takeover.

## When errors happen

If an action reports stale state, target mismatch, or missing target/window, call `screenshot` again to refresh and continue.
