# Architecture

`pi-computer-use` is scene-first.

The agent does not work directly from a full AX tree or a screenshot. It receives a compact scene projection that combines semantic AX data, visual evidence, normalized geometry, and unknown visible regions.

## Data sources

| Source | Role |
| --- | --- |
| macOS AX | Semantic hierarchy, roles, labels, actions, focus, values. |
| AX visible subsets | Native visibility hints such as visible children, rows, columns, and cells. |
| Window capture metadata | Coordinate mapping from screen points to screenshot pixels. |
| Vision/OCR | Visual text evidence and unexplained visible regions. |
| CDP | Optional browser navigation, evaluation, and browser context inspection. |

## Scene refs

| Ref | Meaning |
| --- | --- |
| `@tN` | Scene target. Prefer this for actions. |
| `@uN` | Unknown visible region. AX did not explain this visual area. |
| `@eN` | Raw AX target. |
| `@vN` | Raw visual text target. |
| `@wN` | Window ref. |

`@t` refs route to their semantic backing target. If visual evidence is available, the scene target records it but does not merge it destructively into AX.

## Association

The scene projection creates typed edges between AX and visual observations. Current edge types include:

- `visual_evidence_for`
- `labels`

Associations use normalized geometry, text similarity, AX actionability, and role-specific label placement. Unknown visual regions are created when visible text cannot be explained by AX.

## Public surface

The public API is small:

```text
observe
search_ui
expand_ui
inspect_ui
act
```

This keeps model context small. The full internal state remains structured and queryable, but the agent sees only the projection it needs.

## Design constraints

- Do not make screenshots the source of truth.
- Do not make ranked targets the source of truth.
- Do not expose a full tree by default.
- Prefer native platform semantics when available.
- Add public tools only when they represent a real user-facing operation.
