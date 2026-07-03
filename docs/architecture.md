# Architecture

`pi-computer-use` gives Pi agents a small, inspectable interface for macOS GUI control.

The core loop is:

```text
choose window → observe → search/expand/inspect → act → refresh state
```

The agent does not receive an unbounded accessibility tree or raw screenshot dump by default. It receives a folded outline plus a short running note, and can ask for more local detail when needed.

## Layers

| Layer | Role |
| --- | --- |
| Pi extension | Registers the public tools and schemas. |
| TypeScript bridge | Manages state, refs, browser/CDP support, notes, outline folding, and tool results. |
| Native macOS helper | Performs AX inspection, window capture, input dispatch, permission probes, and helper-side action verification. |
| macOS permissions | Accessibility and Screen Recording remain enforced by the OS. |

## Observation

`observe` asks the helper for one atomic look at a window. A look includes:

- window identity and pairing metadata
- AX-derived UI structure
- optional image evidence
- text boxes when OCR/vision is needed
- timing and capture metadata

The bridge converts that look into a folded outline. Every visible outline node gets a stable tool ref such as `@e12` for the current state. Large subtrees are summarized until the agent calls `expand_ui` or `search_ui`.

## Acting

`act` performs one action transaction. The helper owns the actual input decision:

1. resolve the target ref or coordinate
2. ground it to AX or coordinates
3. preflight permissions and target state
4. execute the action
5. verify what happened when possible
6. return `worked`, `didnt`, or `unknown` with evidence

Refs from `observe`, `search_ui`, and `expand_ui` are preferred. Coordinate actions are available as fallback, but they are tied to the latest observed window image.

## Running note

The bridge maintains a short disposable note per window. It summarizes the latest useful UI state and recent action outcomes so the next tool result has continuity without replaying the whole outline.

The note is derived state. If it is wrong or stale, another look replaces it.

## Browser support

Browser windows can be controlled through the same desktop tools. When CDP is enabled, browser-specific tools can also navigate, evaluate JavaScript, and inspect browser contexts directly.

## Design constraints

- Prefer platform semantics over image-only guessing.
- Keep the default observation compact.
- Expand locally instead of dumping entire trees.
- Let the helper own action execution and verification.
- Keep stale refs and coordinates scoped to the state that produced them.
- Avoid compatibility shims for removed public tools.
