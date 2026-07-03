# Architecture v2: Look, Fold, Check, Note

Status: approved design. Supersedes the observation/fusion pipeline of v0.3.x.
The permissions system (helper-app TCC identity, live probes, register-first,
restart-on-recheck, stable-cert signing) is **out of scope and unchanged**.

## The concept

> Look at the screen so the picture and the description agree. Show what you
> see as a foldable outline, throwing nothing away. Before clicking, check
> what's there; after, check it worked. Keep a running note of what you've
> seen, what's changed, and what you've never looked at. And decide nothing
> on the user's behalf.

Every mechanism below is forced by one of these five sentences. Anything the
sentences do not force is deleted, not kept.

Two programs, forced by macOS TCC (permissions attach to one signed app):

- **Helper** (`native/macos/bridge.swift`, runs as `pi-computer-use.app`):
  everything physical. Measures and acts. No judgment.
- **Extension** (`src/`, TypeScript): everything presentational. Folds,
  notes, renders. No physics.

The wire between them carries facts in one coordinate space, never
coordination.

---

## 1. Helper protocol 3

Observation commands (`screenshot`, `axSnapshotTree`, `visionTargets`,
`axListTargets`) are **replaced** by `look`. Input commands lose their
`captureWidth`/`captureHeight` parameters. `HELPER_PROTOCOL_VERSION = 3`
on both sides; the TS side hard-fails on mismatch (existing mechanism).

### 1.1 `look` — the atomic observation

Forced by: *"the picture and the description agree"* (same moment, same
window, same coordinates) and *"throwing nothing away"* (marked truncation,
existence-without-contents).

```jsonc
// request
{ "cmd": "look", "windowId": 123,
  "maxDimension": 900,             // optional
  "readText": "auto",              // "auto" | "always" | "never"
  "scopeRef": "elem_12" }          // optional: re-walk one subtree only

// response result
{ "lookId": "look_7",              // monotonic per helper process
  "capturedAt": 1234567890.123,
  "window": {
    "windowId": 123,
    "framePoints": { "x":0,"y":25,"w":1440,"h":875 },
    "scaleFactor": 2,
    "pairing": { "confidence": "exact" | "high" | "low", "score": 87.5 },
    "isModal": false, "sheetCount": 0, "role": "AXWindow", "subrole": "AXStandardWindow"
  },
  "image": { "jpegBase64": "...", "width": 900, "height": 547 },
  "outline": { /* Node, below */ },
  "timings": { "captureMs": 120, "describeMs": 240, "readTextMs": 310 }
}
```

```jsonc
// Node — every rect is in image pixels of THIS look's image
{ "ref": "elem_42",
  "role": "AXButton", "subrole": "", "identifier": "save-btn",
  "title": "Save", "description": "", "value": "",
  "actions": ["AXPress"],
  "canPress": true, "canFocus": true, "canSetValue": false,
  "canScroll": false, "canIncrement": false, "canDecrement": false,
  "isTextInput": false,
  "rect": { "x": 810, "y": 12, "w": 64, "h": 24 },
  "focused": true,                 // present only when true; drives focused-path unfolding
  "offscreen": true,               // present only when true; INFORMS, never deletes
  "pictureOnly": true,             // present only when true; node came from OCR
  "truncated": true,               // present only when true; children exist, not walked
  "scrollExtent": { "seen": 9, "total": 32 },  // scrollable containers only, when knowable
  "text": [ { "string": "Save", "confidence": 0.93,
              "rect": { "x": 812, "y": 14, "w": 40, "h": 16 } } ],
  "children": [ /* Node */ ]
}
```

Execution order inside one call — this order is an invariant:

1. Capture the image (existing ScreenCaptureKit path, CGWindow fallback).
2. Walk the AX tree breadth-first from the window element (or `scopeRef`).
   Global cap 2000 nodes; when a cap stops a walk mid-subtree, mark that
   node `truncated: true`. Record `offscreen` from visible-children
   membership **per attribute kind** (rows checked against `visibleRows`
   only, cells against `visibleCells`, etc.; a present-but-empty visible
   array means "children hidden", an absent attribute means "assume
   visible"). For scrollable containers, populate `scrollExtent` when row
   counts are knowable.
3. If reading text (`always`, or `auto` and the description is sparse over
   the image): run `VNRecognizeTextRequest` (.accurate, no language
   correction) on **the full-resolution capture from step 1** — never a
   second capture — then scale box coordinates to the downscaled image.
4. Attach each OCR box to the deepest node whose rect contains its center.
   A box no node explains becomes a `pictureOnly` child Node of the deepest
   container whose rect contains it (fallback: the window root). Its
   `title` is the OCR string; `actions` is empty; it has a `rect`.
5. Translate every rect into image pixels using the window frame and
   downscale factor. **No coordinate leaves the helper in screen points.**
6. Encode the image once, JPEG quality 0.8. No PNG.

`AXUIElement` handles for every non-`pictureOnly` node go into the existing
ref store; `ref` is the store key.

### 1.2 `act` — the atomic transaction

Forced by: *"before clicking, check what's there; after, check it worked"*
and *"decide nothing"*.

```jsonc
// request
{ "cmd": "act", "lookId": "look_7", "pid": 501,
  "target": { "ref": "elem_42" } | { "x": 810, "y": 24 },   // x,y in look_7 image pixels
  "action": "press" | "click" | "setText" | "typeText" | "keypress"
          | "scroll" | "drag" | "moveMouse",
  "params": { /* per action: button, clickCount, text, keys, scrollX/Y, path, delivery */ } }

// response result
{ "outcome": "worked" | "didnt" | "unknown",
  "performed": { "grounding": "description" | "coordinates",
                 "delivery": "ax" | "hid" | "pid",
                 "refound": true },       // present only when resolve re-found the element
  "evidence": { "value": "hello" },       // action-specific, when checkable
  "error": { "code": "occluded_target", "whatIsThere": { /* Node, no children */ } } }
```

Five steps, all in-process, in order:

1. **Resolve.** `target.ref` → live element from the ref store. If the OS
   reports it dead (`element_ref_invalid`), attempt exactly one structural
   re-find inside the same window (same role; same `identifier` if the
   stale node had one, else same normalized label; nearest to last rect);
   report `refound: true`. Otherwise fail `stale_ref` with the last known
   rect. `target.{x,y}` are translated from `lookId`'s image pixels using
   geometry recorded at look time; a `lookId` the helper no longer has
   fails `stale_look`.
2. **Ground.** Preference ladder: AX action (`AXPress`, setValue via AX) →
   node's **current** rect center (re-read the frame; for small nodes
   inside wide row parents, use the row ancestor's center-x — a tree walk,
   not a ratio heuristic) → raw point (only when the caller sent
   coordinates). Delivery policy narrows the ladder exactly as today
   (`ax_only` blocks coordinate grounding, `background` forces `pid`).
3. **Check what's there** (coordinate grounding only).
   `AXUIElementCopyElementAtPosition` at the target point, now. Pass if the
   hit element is the target, an ancestor, or a descendant. Fail
   `occluded_target` with `whatIsThere` (single Node, no children) if it is
   an unrelated element. If the hit-test returns junk (window-level element
   or error), proceed and cap the final outcome at `unknown` — degrade,
   never block on flaky hit-testing.
4. **Execute.** Existing event-posting code, unchanged (HID activation
   path, pid path, AX actions, UTF-16 text ranges for selection —
   `value.utf16.count`, not `value.count`).
5. **Check it worked.** Per action: `setText` → read the value back, compare
   (`worked`/`didnt`). `press`/`click` on a ref → element consumed OR
   focused window/sheet changed OR `AXValue`/`AXSelected` changed →
   `worked`; nothing observable → `unknown`. `scroll` on a ref → scroll
   position attribute moved. Coordinate targets without a ref → `unknown`
   unless a sheet/window change is observed. **Never report bare success.**

**Dialogs are never answered.** There is no auto-confirm logic anywhere in
either program.

### 1.3 Window pairing (`listWindows`)

Forced by: *"same window"* + *"decide nothing"* (a guess must be labeled).

AX windows × CGWindows scored jointly (title match + geometry distance,
current formula) as a best assignment — evaluate all pairings, not greedy
first-match. A pairing below the floor (score < 0) is **refused**: the AX
window is listed without `windowId` (interactable, not capturable). Every
window carries `pairing: { confidence, score }` where confidence is
`exact` (title equal + geometry within 2pt), `high` (score ≥ 50), `low`
(0 ≤ score < 50). `listApps` CGWindow-owner backfill stays.

### 1.4 Command inventory after this change

`look`, `act`, `hitTest` (standalone read-only hit-test, allowed in
stealth), `listApps`, `listWindows`, `getFrontmost`, `activateApp`,
`raiseWindow`, `setWindowFrame`, `focusedElement`, `axReadText`,
`axWaitFor`, `diagnostics`, `checkPermissions`, `registerPermissions`,
`openPermissionPane`, `shutdown`.

**Deleted** (rip out, do not stub): `screenshot`, `axSnapshotTree`,
`visionTargets`, `mouseClick`, `mouseMove`, `mouseDrag`, `scrollWheel`,
`keyPress`, `typeText`, `setValue`, `selectText`, `axClickElement`,
`axPerformActionElement`, `axFocusElement`, `axFocusAtPoint`,
`axClickAtPoint`, `axFindTextInput`, `axFocusTextInput` — all subsumed by
`look`/`act`/`focusedElement`. Delete their handlers, their helpers that
become unreferenced, and the dispatch cases. If a private function loses
its last caller, delete it too.

---

## 2. Extension

State: latest `look` per controlled window, the running note, browser/CDP
sessions, window-ref bookkeeping. Nothing else. All coordinate transform
code in TS is deleted — the helper owns geometry.

### 2.1 The running note

Forced by: *"keep a running note"*. A derived, disposable structure —
repaired by every look, never authoritative.

```ts
interface NoteRegion { key: string; label: string;
  status: "seen" | "changed" | "never-looked";
  detail?: string }                       // "32 rows, 9 seen" / "appeared after act"
interface WindowNote { windowRef: string; title: string;
  pairing: "exact"|"high"|"low"; lastLookId?: string;
  regions: NoteRegion[] }
```

Region keys = the window's top-level container nodes (role + identifier/
label). Rules, mechanical:

- A look marks every region it covered `seen` and rebuilds the region list
  from the outline's top level.
- An `act` marks the region containing its target `changed`; a sheet/window
  change marks the whole window `changed` and adds the new window as
  `never-looked`.
- `scrollExtent` (seen < total), `truncated` nodes, and refused pairings
  create `never-looked` entries with `detail`.
- A region key that fails to match across looks degrades to `changed`.
  Wrong note ⇒ at most one redundant look, never a wrong click.

### 2.2 Rendering

Forced by: *"foldable outline, throwing nothing away"*.

- `observe(window?, mode?)` → note + outline unfolded to budget: focused
  path, modals/sheets, `changed` and `never-looked`-adjacent regions
  unfolded; `seen` regions folded to one line. **Every folded node prints
  its counts**: `@e12 AXGroup "Sidebar" ▸ (14: 11 rows, 2 buttons,
  1 picture-only) [scrollable 9/32]`. When the render budget itself cuts
  the output, the rendered text MUST end with a receipt line stating how
  many nodes were not rendered and how to reach them — a silent cut is a
  deletion in disguise. No relevance scores anywhere; the
  app's structure is the order. Image attachment follows current
  auto/always/never logic; `mode: "semantic"|"visual"|"fused"` maps to
  `readText` never/always/auto.
- `expand_ui(ref, depth?)` → unfold from cache; if the node is `truncated`
  or its region is `changed`, issue `look(scopeRef)` first.
- `search_ui(text?, role?, action?)` → walks the **full cached outline**
  (it never went to the model, so it cannot be stale relative to the
  lookId) and returns matches with ancestor paths:
  `sidebar ▸ AXRow "Documents" ▸ AXButton "rename"`.
- `inspect_ui(ref)` → one node, all fields, including annotations.
- `act(...)` → helper `act` pass-through; then `look(scopeRef=region)` to
  refresh; render verdict + evidence + updated note.
- `read_text`, `wait_for`, `list_apps`, `list_windows`, browser/CDP tools:
  unchanged.

Refs: one namespace. `@eN` = outline nodes (wire `ref` ↔ `@eN` mapping kept
per look, as today), `@wN` = windows. `pictureOnly` nodes are ordinary
nodes; under `ax_only` policy acting on them fails with a clear message.

### 2.3 Deleted from the extension (rip out, do not stub)

`SceneProjection`, `SceneTarget`, `SceneEdge`, `SceneAssociation`,
`buildSceneProjection`, `sceneAssociationScore`, `labelAssociationScore`,
`bestEdgesByVision`, `clusterVisionUnknowns`, `semanticSceneTarget`,
`visionSceneTarget`, `searchSceneTargets` (rewritten over the outline),
`sceneAxTargetsFromSemantic`, `parseVisionTargets`, `visionTargetByRef`,
`visionClickPoint`, `formatVisionTargetLabel`, `axCoordinateFallbackPoint`,
`screenPointToCapturePoint`, `screenFrameToCaptureFrame`, `frameCenter`,
`frameArea`, `intersectionArea` (unless the note needs one; prefer delete),
`coordinateStateSignature`, `verifiedCoordinateClick`,
`mouseClickAtCapturePoint`, `autoConfirmButton`, `reacquireAxTarget` (moved
into the helper's resolve step), `refreshAxTargets`, `axTreeRawForTarget`,
`semanticAxTree`, `helperVisionTargets`, `currentSemanticAxTargets`,
`currentVisionTargets`, `currentScene`, `@t/@u/@v` ref namespaces, and the
`grounding`/`coordinateVerification` trace fields (replaced by `performed`
and `outcome` from the helper). Types/imports/exports that lose their last
use go with them.

---

## 3. Invariants

Machine-checkable. Every migration step must keep all previously
established invariants green. Checks live in `scripts/check-invariants.mjs`
(node, zero new dependencies) and run via `npm run test:invariants`,
wired into `npm test`. Checks that need a live helper are guarded behind
`PI_CU_LIVE=1` (skipped in CI, run locally).

- **INV-1 (one moment):** static — the strings `visionTargets`,
  `axSnapshotTree`, `screenshot"` (as command names) do not appear in
  `src/` or as dispatch cases in `bridge.swift`. Live — a `look` response
  contains `image`, `outline`, and (with `readText:"always"`) at least one
  `text` annotation, with one `capturedAt`.
- **INV-2 (one space):** static — `captureWidth`/`captureHeight` appear
  nowhere in `src/`; `screenPointToCapturePoint`/`screenFrameToCaptureFrame`
  do not exist. Live — every `rect` in a `look` outline lies within
  `[0, image.width] × [0, image.height]`.
- **INV-3 (nothing thrown away):** static — no code path filters nodes out
  of the outline by visibility or interactivity (`sceneAxTargetsFromSemantic`
  absent). Live — for a look of a Finder window, node count in the outline
  ≥ node count with all folds expanded via `expand_ui` (folding is
  presentation-only); every folded render line contains a child count.
- **INV-4 (checked actions):** static — every `act` result type carries
  `outcome`; the string `autoConfirmButton` and `coordinateStateSignature`
  appear nowhere. Live — `act(setText)` on a TextEdit field returns
  `outcome: "worked"` with `evidence.value` equal to the text; `act` at a
  point covered by another window returns `occluded_target`.
- **INV-5 (labeled guesses):** static — `listWindows` result type requires
  `pairing`; `look` requires `window.pairing`. Live — two same-size
  untitled windows of one test app yield pairing `low` or a refused
  pairing, never silent `exact`.
- **INV-6 (the note):** static — note module exports no setter that code
  outside look/act result-handling can call (derived-only). Live — after
  `act`, the acted region reads `changed`; after the next `observe`, `seen`;
  a scrollable list with `scrollExtent.seen < total` yields a
  `never-looked` region.
- **INV-7 (no decisions below the tool boundary):** static — grep gate: no
  regex over button labels drives an automatic press anywhere
  (`/confirm|ok|continue|apply/i` tied to `press` is a build failure).
- **INV-8 (dead code is deleted):** `npx tsc --noEmit` with
  `noUnusedLocals`+`noUnusedParameters` passes; `grep` for every identifier
  in the §1.4/§2.3 deletion lists returns nothing in `src/` and
  `native/macos/`.

## 4. Coding principles (binding for all implementation work)

1. Does this need to exist? If not, skip it.
2. Does the standard library do it? Use that.
3. Does the native platform do it? Use that.
4. Is there already an installed dependency? Use that.
5. Can it be one line? Make it one line.
6. Only then write the minimum code that works.

Plus the refactor mandate: **refactor, never patch.** Replacing a mechanism
means deleting the old one in the same change — handlers, helpers, types,
imports, docs. No compatibility shims beyond the protocol-version check, no
`_old` suffixes, no commented-out code. A change that only adds is suspect.

## 5. Migration steps (each ships alone, invariants verified at each)

1. **Helper `look` + protocol 3 + pairing rework** (§1.1, §1.3). Delete the
   observation commands. Establish INV-1, INV-2 (helper side), INV-5.
2. **Extension switch-over** (§2.2 observation path): `observe`/`expand_ui`/
   `search_ui`/`inspect_ui` over the outline; delete §2.3 observation items.
   Establish INV-2 (TS side), INV-3.
3. **Helper `act` + extension pass-through** (§1.2): delete the input
   commands and TS dispatch/verification machinery. Establish INV-4, INV-7.
4. **The running note** (§2.1): derivation + rendering; retire salience
   heuristics. Establish INV-6.
5. **Budget fitting** against cubench; INV-8 sweep; remove any remaining
   transitional code.

Budgets (tunable, not principles): unfold ~2 levels/~150 nodes; walk cap
2000; JPEG q0.8 at 900px auto / 1600px explicit; OCR `auto` = current
sparse-description trigger; post-act scoped look = acted region only.

### Fitted budgets

Measured with `node scripts/cubench.mjs` against Finder, Safari, System
Settings, Ghostty, and Code on 2026-07-03.

- Render unfold: depth 2 / 150 nodes for `observe` and `expand_ui`; observed
  output was 1.1k-3.3k estimated tokens, so one cap is enough and avoids a
  wider expansion path.
- Helper walk cap: 2000 nodes; Safari reached the cap but still returned in
  952ms, while smaller windows stayed below it, so the cap protects worst
  cases without slowing ordinary looks.
- Image encoding: JPEG q0.8 at 900px auto / 1600px explicit; measured images
  were 27-120KB at 900px and 56-258KB at 1600px, so the existing sizes keep
  visual recovery cheap.
- OCR auto trigger: current sparse-description trigger; the sampled windows
  returned useful outlines without forcing OCR everywhere.
- Post-act refresh: `look(scopeRef=acted region)` for ref actions, full look
  for coordinate-only actions; ref actions get the intended scoped budget,
  while coordinate actions have no region to scope.
