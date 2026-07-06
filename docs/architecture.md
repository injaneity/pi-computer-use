# Architecture

`pi-computer-use` gives Pi agents a small, inspectable interface for macOS GUI control.

The core loop is:

```text
find roots → observe root → search/expand/inspect → act → refresh state
```

A root is a top-level controllable UI surface. The platform seam guarantees only the split between ordinary windows and transients; specific root kinds such as sheet, dialog, popover, or menu are best-effort presentation hints and never drive shared behavior. Public root refs use `@rN`; element refs inside the current observation still use `@eN`.

## Layers

| Layer | Role |
| --- | --- |
| Pi extension | Registers the public tools and schemas. |
| TypeScript bridge | Manages state, refs, browser/CDP support, notes, outline folding, and tool results. |
| Platform backend | Exposes a generic root/observe/act contract to shared orchestration. |
| Native macOS helper | Performs AX inspection, root enumeration, window capture, input dispatch, permission probes, and helper-side action verification. |
| macOS permissions | Accessibility and Screen Recording remain enforced by the OS. |

## Observation

`observe` asks the backend for one atomic look at a root. A look includes:

- platform-neutral root identity and facts
- platform accessibility API-derived UI structure (AX on macOS, UIA on Windows)
- optional image evidence for image-bearing roots
- text boxes when OCR/vision is needed
- timing and capture metadata

The bridge converts that look into a folded outline. Every visible outline node gets a stable tool ref such as `@e12` for the current state. Large subtrees are summarized until the agent calls `expand_ui` or `search_ui`.

Transient roots may be semantic-only when the OS does not expose a capturable window image. Coordinate actions clearly reject those looks; use semantic `@e` refs instead.

Modality is a platform-reported fact. On macOS, the backend folds AX modal state, attached-sheet presence, and AX dialog/sheet/modal role vocabulary into `isModal`; shared scoring and displacement consume only that fact.

## Acting

`act` performs one action transaction. The backend/helper owns the actual input decision:

1. resolve the target ref or coordinate
2. ground it to AX or coordinates
3. preflight permissions and target state
4. execute the action
5. verify what happened when possible
6. return `worked`, `didnt`, or `unknown` with evidence and any shallow `rootDelta`

Refs from `observe`, `search_ui`, and `expand_ui` are preferred. Coordinate actions are available as fallback, but they are tied to the latest observed image-bearing root. If a root appears in a delta, agent guidance is uniform across platforms: observe it.

`deltaSource` is a free-form diagnostic string naming the backend's delta mechanism. It is not part of the behavioral contract; shared code only treats its presence as evidence that the backend already awaited UI quiescence.

## Running note

The bridge maintains a short disposable note per root. It summarizes the latest useful UI state and recent action outcomes so the next tool result has continuity without replaying the whole outline.

The note is derived state. If it is wrong or stale, another look replaces it.

## Browser support

Browser roots can be controlled through the same desktop tools. When CDP is enabled, browser-specific tools can also navigate, evaluate JavaScript, and inspect browser contexts directly.

## Design constraints

- Prefer platform semantics over image-only guessing.
- Keep the default observation compact.
- Expand locally instead of dumping entire trees.
- Let the backend/helper own action execution and verification.
- Keep the seam platform-neutral: platform mechanisms belong in backend internals or free-form diagnostics, not shared contract types.
- Keep stale refs and coordinates scoped to the state that produced them.
- Avoid compatibility shims for removed public tools.
