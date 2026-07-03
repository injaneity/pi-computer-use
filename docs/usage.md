# Usage

`pi-computer-use` exposes tools for observing and acting on macOS app windows.

The normal loop is:

1. Choose a window or browser context.
2. Call `observe`.
3. Use `search_ui`, `expand_ui`, or `inspect_ui` if the target is not obvious.
4. Call `act` with a current ref.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_apps` | List running macOS apps. |
| `list_windows` | List controllable desktop windows. |
| `list_contexts` | List desktop windows and CDP browser pages. |
| `observe` | Capture one look and return a folded UI outline plus running note. |
| `search_ui` | Search the current outline by text, role, action, or capability. |
| `expand_ui` | Show local outline context for one ref. |
| `inspect_ui` | Show fields, rects, actions, annotations, and evidence for one ref. |
| `act` | Perform one action by ref or image coordinate. |
| `read_text` | Page through long text from a text-bearing ref or browser context. |
| `wait_for` | Wait for text or role to appear or disappear. |
| `launch_browser_context` | Start a managed CDP browser. |
| `navigate_browser` | Navigate a browser window or CDP context. |
| `evaluate_browser` | Run JavaScript in a CDP browser context. |

## Refs and state

`observe`, `search_ui`, and `expand_ui` return outline refs like `@e12`.

Use current refs from the latest state. A ref can become stale after the UI changes, the window changes, or a new observation replaces the previous outline.

Some outline nodes are marked `pictureOnly`. These represent visual evidence without an AX element. They can help the agent understand what is visible, but AX-only actions cannot target them by ref. Use coordinates only when there is no better semantic target.

## Observation modes

`observe` supports three modes:

| Mode | Use when |
| --- | --- |
| `semantic` | AX structure is enough and you want the cheapest result. |
| `fused` | Default. Include visual evidence when it is useful. |
| `visual` | The app is custom drawn or AX is sparse. |

Images are optional. Use `image: "never"` for text-only results, `image: "always"` when visual inspection matters, and `image: "auto"` for the default behavior.

## Acting

Prefer refs:

```ts
act({ action: "press", ref: "@e12" })
act({ action: "setText", ref: "@e18", text: "hello" })
act({ action: "scroll", ref: "@e7", scrollY: 400 })
act({ action: "keypress", keys: ["Enter"] })
act({ action: "wait", ms: 500 })
```

Coordinate fallback uses image pixels from the latest observed window:

```ts
act({ action: "click", x: 420, y: 300 })
```

`act` returns an outcome of `worked`, `didnt`, or `unknown`, plus execution evidence when available.

## Browser use

For normal browser windows, use the same desktop flow:

```ts
list_windows({ app: "Helium" })
observe({ window: "@w1", mode: "fused" })
act({ action: "press", ref: "@e12" })
```

For CDP browser contexts:

```ts
launch_browser_context({ browser: "helium", url: "https://example.com" })
list_contexts()
navigate_browser({ contextId: "browser:...", url: "https://example.com" })
evaluate_browser({ contextId: "browser:...", expression: "document.title" })
```
