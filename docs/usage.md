# Usage

`pi-computer-use` exposes tools for observing and acting on macOS UI roots.

The normal loop is:

1. Find a root or browser context.
2. Call `observe_ui` on that root.
3. Use `search_ui`, `expand_ui`, or `inspect_ui` if the target is not obvious.
4. Call `act_ui` with a current ref.

## Tools

| Tool | Purpose |
| --- | --- |
| `find_roots` | Find controllable desktop roots (`window`, `sheet`, `dialog`, `popover`, `menu`). |
| `list_contexts` | List desktop roots and CDP browser pages. |
| `observe_ui` | Capture one root look and return a folded UI outline plus running note. |
| `search_ui` | Search the current outline by text, role, action, or capability. |
| `expand_ui` | Show local outline context for one ref. |
| `inspect_ui` | Show fields, rects, actions, annotations, and evidence for one ref. |
| `act_ui` | Perform one action by ref or image coordinate. |
| `read_text` | Page through long text from a text-bearing ref or browser context. |
| `wait_for` | Wait for text or role to appear or disappear. |
| `launch_browser_context` | Start a managed CDP browser. |
| `navigate_browser` | Navigate a browser root or CDP context. |
| `evaluate_browser` | Run JavaScript in a CDP browser context. |

## Refs and state

`find_roots` returns root refs like `@r1`. `observe_ui`, `search_ui`, and `expand_ui` return outline refs like `@e12`.

Use current refs from the latest state. A ref can become stale after the UI changes, the root changes, or a new observation replaces the previous outline.

Some outline nodes are marked `pictureOnly`. These represent visual evidence without an AX element. They can help the agent understand what is visible, but semantic actions cannot target them by ref. Use coordinates only when there is no better semantic target and the latest look has an image.

## Observation modes

`observe_ui` supports three modes:

| Mode | Use when |
| --- | --- |
| `semantic` | AX structure is enough and you want the cheapest result. |
| `fused` | Default. Include visual evidence when it is useful. |
| `visual` | The app is custom drawn or AX is sparse. |

Images are optional. Sheet/dialog roots may be semantic-only; coordinate actions clearly reject image-less looks.

## Acting

Prefer refs:

```ts
act_ui({ action: "press", ref: "@e12" })
act_ui({ action: "setText", ref: "@e18", text: "hello" })
act_ui({ action: "scroll", ref: "@e7", scrollY: 400 })
act_ui({ action: "keypress", keys: ["Enter"] })
act_ui({ action: "wait", ms: 500 })
```

Coordinate fallback uses image pixels from the latest observed image-bearing root:

```ts
act_ui({ action: "click", x: 420, y: 300 })
```

`act_ui` returns an outcome of `worked`, `didnt`, or `unknown`, plus execution evidence and shallow root deltas when available.

## Browser use

For normal browser windows, use the same desktop flow:

```ts
find_roots({ app: "Helium", kind: "window" })
observe_ui({ root: "@r1", mode: "fused" })
act_ui({ action: "press", ref: "@e12" })
```

For CDP browser contexts:

```ts
launch_browser_context({ browser: "helium", url: "https://example.com" })
list_contexts()
navigate_browser({ contextId: "browser:...", url: "https://example.com" })
evaluate_browser({ contextId: "browser:...", expression: "document.title" })
```
