# pi-computer-use

`pi-computer-use` adds Codex-style screenshot/action computer-use tools to Pi on macOS.

## Public tools

- `screenshot`
- `click`
- `double_click`
- `move_mouse`
- `drag`
- `scroll`
- `type_text`
- `keypress`
- `wait`

## Notes

- Target platform: macOS 15+.
- Helper runtime path: `~/.pi/agent/helpers/pi-computer-use/bridge`.
- Permissions must be granted to the helper binary (Accessibility + Screen Recording).
- Non-intrusive mode is enabled:
  - input events are dispatched to target app PIDs instead of global cursor takeover
  - normal action flow avoids automatic activate/raise/unminimize behavior
  - minimized/unavailable windows can fail with actionable refresh errors instead of stealing focus
- AX-first input strategy is enabled where helpful:
  - `type_text` tries AX `setValue` on the focused element before paste/raw key fallbacks
  - `click` (left button) tries AX press-at-point first, then falls back to mouse-event click
- Screenshot recovery is built in:
  - on helper `screenshot_timeout` / `window_not_found`, runtime refreshes candidate windows and retries capture before failing

## Native helper

- Prebuilt signed helpers are expected at:
  - `prebuilt/macos/arm64/bridge`
  - `prebuilt/macos/x64/bridge`
- Dev fallback build:

```bash
npm run build:native
```
