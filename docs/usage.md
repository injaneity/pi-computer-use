# Usage

`pi-computer-use` exposes a small tool surface. The normal loop is:

1. Choose a window or context.
2. Observe the UI scene.
3. Search or expand if the target is not obvious.
4. Act by ref.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_apps` | List running macOS apps. |
| `list_windows` | List controllable windows and their refs. |
| `list_contexts` | List desktop windows and CDP browser contexts. |
| `observe` | Capture the current UI scene. |
| `search_ui` | Search the current scene by text, role, action, or source. |
| `expand_ui` | Show local context for one ref. |
| `inspect_ui` | Show provenance and evidence for one ref. |
| `act` | Perform one action by ref or coordinates. |
| `read_text` | Page through long text. |
| `wait_for` | Wait for text or role to appear or disappear. |
| `launch_browser_context` | Start a managed CDP browser. |
| `navigate_browser` | Navigate a browser window or CDP context. |
| `evaluate_browser` | Run JavaScript in a CDP browser context. |

## Desktop example

```ts
list_windows({ app: "TextEdit" })
observe({ window: "@w1", mode: "fused" })
search_ui({ text: "Replace", action: "press" })
act({ action: "press", ref: "@t1" })
```

Use `mode: "semantic"` when AX is enough and you want the cheapest observation. Use `mode: "fused"` when visual evidence may help. Use `mode: "visual"` when the UI is likely custom drawn.

## Refs

`observe` returns several ref types:

| Ref | Meaning |
| --- | --- |
| `@tN` | Scene target. Prefer this for actions. |
| `@uN` | Unknown visible region. Use when AX does not explain something visible. |
| `@eN` | Raw AX target. Useful for debugging or precise AX actions. |
| `@vN` | Raw visual text target. Coordinate based fallback. |
| `@wN` | Window ref from `list_windows`. |

Scene targets can combine AX semantics with visual evidence. For example, a text field can be associated with a visible label, or a button can be associated with OCR text inside its frame.

## Progressive disclosure

Start with `observe`. If the target is not visible in the compact result, search first:

```ts
search_ui({ text: "Email", action: "set" })
```

If you need local context:

```ts
expand_ui({ ref: "@t3", depth: 3 })
```

If you need evidence or coordinates:

```ts
inspect_ui({ ref: "@t3" })
```

Avoid asking for full trees. Expand one ref at a time.

## Acting

```ts
act({ action: "setText", ref: "@t2", text: "hello" })
act({ action: "press", ref: "@t4" })
act({ action: "scroll", ref: "@t8", scrollY: 400 })
act({ action: "keypress", keys: ["Enter"] })
act({ action: "wait", ms: 500 })
```

Coordinates are fallback only:

```ts
act({ action: "click", x: 420, y: 300 })
```

Coordinates are window-relative screenshot pixels from the latest observation.

## Browser use

For normal browser windows, use the same desktop flow:

```ts
list_windows({ app: "Helium" })
observe({ window: "@w1", mode: "fused" })
act({ action: "press", ref: "@t1" })
```

For CDP browser contexts:

```ts
launch_browser_context({ browser: "helium", url: "https://example.com" })
list_contexts()
navigate_browser({ contextId: "browser:...", url: "https://example.com" })
evaluate_browser({ contextId: "browser:...", expression: "document.title" })
```
