# pi-computer-use — Implementation Checklist for GPT-5.3-Codex

Use this checklist as the execution plan for implementing `pi-computer-use`.

## Working rules

- Follow `./pi-computer-use-implementation-plan.md` as the source of truth.
- Do **not** re-open product/API design unless implementation proves something impossible.
- Be faithful to **Codex computer-use semantics**.
- At the public tool layer, keep **Pi-style multiple focused tools**.
- Keep **AX internal only**. Do **not** expose AX trees, refs, or semantic inspection tools to the model.
- Prefer small, reviewable commits / checkpoints.
- When a phase is complete, verify acceptance criteria before moving on.

---

## Fixed public API

Implement exactly these public tools:

- `screenshot({ app?: string, windowTitle?: string })`
- `click({ x: number, y: number, button?: "left" | "right" | "wheel" | "back" | "forward", captureId?: string })`
- `double_click({ x: number, y: number, captureId?: string })`
- `move_mouse({ x: number, y: number, captureId?: string })`
- `drag({ path: Array<{ x: number; y: number }>, captureId?: string })`
- `scroll({ x: number, y: number, scrollX: number, scrollY: number, captureId?: string })`
- `type_text({ text: string })`
- `keypress({ keys: string[] })`
- `wait({ ms?: number })`

Do **not** expose:

- `computer_use` mega-tool
- `inspect_ui`
- `get_ax_tree`
- `ref` parameters
- any AX-specific public tool

---

## Fixed runtime behavior

These behaviors are mandatory:

- `screenshot()` selects or refreshes the **current controlled window**.
- All action tools act on the **current controlled window**.
- Every successful action tool returns a **fresh screenshot**.
- Coordinates are **window-relative screenshot pixels**.
- `captureId` is optional validation, not required.
- `type_text` acts on the **currently focused control** in the current target.
- Runtime should stay **non-intrusive** by default (no automatic activate/raise/unminimize in normal flow).
- If the target window is minimized/unavailable, tools should fail with actionable refresh/retarget errors instead of stealing focus.
- Prefer **AX-first** paths where possible, with coordinate-event fallback when AX is unavailable.
- Helper is the TCC permission target, not `pi`.
- Use one stable helper path:
  - `~/.pi/agent/helpers/pi-computer-use/bridge`
- Rebuild current target/capture state from previous tool results on resume/fork.

---

# Phase 0 — Create project skeleton

## Tasks

- [ ] Create package structure:
  - [ ] `package.json`
  - [ ] `extensions/computer-use.ts`
  - [ ] `src/bridge.ts`
  - [ ] `src/permissions.ts`
  - [ ] `native/macos/bridge.swift`
  - [ ] `scripts/setup-helper.mjs`
  - [ ] `scripts/build-native.mjs`
  - [ ] `skills/computer-use/SKILL.md`
  - [ ] `prebuilt/macos/arm64/`
  - [ ] `prebuilt/macos/x64/`
- [ ] Add minimal `package.json` with:
  - [ ] package name/version/keyword
  - [ ] `pi.extensions`
  - [ ] `pi.skills`
  - [ ] `postinstall`
  - [ ] `build:native`
  - [ ] required `peerDependencies`
- [ ] Add placeholder files with TODO headers so the repo is loadable.

## Acceptance criteria

- [ ] Package tree matches the reconstructed plan.
- [ ] Pi can discover the extension and skill paths without runtime syntax errors.

---

# Phase 1 — Register the public Pi tools

## Tasks

- [ ] Implement `extensions/computer-use.ts`.
- [ ] Register all 9 tools.
- [ ] Mark each tool `executionMode: "sequential"`.
- [ ] Add concise `description`, `promptSnippet`, and `promptGuidelines` for each tool.
- [ ] Add `session_start` handler to reconstruct state from previous tool results.
- [ ] Add `session_shutdown` handler to stop helper process.
- [ ] Add `prepareArguments()` where helpful:
  - [ ] `keypress` may normalize `"cmd+l"` -> `['CMD', 'L']`

## Acceptance criteria

- [ ] Tool names exactly match the fixed API.
- [ ] No public AX/inspection tool is registered.
- [ ] Extension loads without starting helper eagerly.

---

# Phase 2 — Define the TypeScript runtime state model

## Tasks

- [ ] In `src/bridge.ts`, define in-memory state for:
  - [ ] current target
  - [ ] current capture
  - [ ] helper child process
  - [ ] pending JSON-line requests
- [ ] Define persisted `details` shape for tool results.
- [ ] Implement state reconstruction from previous tool results.
- [ ] Ensure transient AX handles are **not** treated as durable across resume/fork.

## Acceptance criteria

- [ ] Current target/capture can be reconstructed from session history.
- [ ] If no current target exists, action tools fail with a clear error instructing the model to call `screenshot` first.

---

# Phase 3 — Implement helper setup and stable-path installation

## Tasks

- [ ] Implement `scripts/setup-helper.mjs`.
- [ ] Choose embedded helper based on architecture.
- [ ] Copy helper to stable path:
  - [ ] `~/.pi/agent/helpers/pi-computer-use/bridge`
- [ ] Overwrite only when helper contents changed.
- [ ] Ensure executable bit is set.
- [ ] Make setup callable from:
  - [ ] `postinstall`
  - [ ] first-use lazy bootstrap
- [ ] Implement `scripts/build-native.mjs` for dev fallback source build.
- [ ] Clearly separate release/prebuilt flow from dev/source-build flow.

## Acceptance criteria

- [ ] First-use logic works even if `postinstall` never ran.
- [ ] Helper path is stable across installs/updates.
- [ ] Dev fallback can build helper via `xcrun swiftc`.

---

# Phase 4 — Implement helper process lifecycle and JSON-lines RPC

## Tasks

- [ ] In `src/bridge.ts`, implement:
  - [ ] helper spawn
  - [ ] stdout line parsing
  - [ ] request `id` correlation
  - [ ] timeout handling
  - [ ] process restart if helper dies
  - [ ] `stopBridge()` cleanup
- [ ] Implement `ensureReady(ctx)`:
  - [ ] ensure helper exists
  - [ ] start helper if needed
  - [ ] check permissions
  - [ ] invoke permission bootstrap if needed
- [ ] Add internal mutex/serialization guard in addition to Pi sequential tool mode.

## Acceptance criteria

- [ ] Multiple sequential tool calls can share one long-lived helper process.
- [ ] Helper restart is transparent between tool calls.
- [ ] No eager helper start on extension load/session start.

---

# Phase 5 — Implement interactive permission bootstrap

## Tasks

- [ ] Implement `src/permissions.ts`.
- [ ] Add helper command support for:
  - [ ] `checkPermissions`
  - [ ] `openPermissionPane(accessibility)`
  - [ ] `openPermissionPane(screenRecording)`
- [ ] In interactive mode:
  - [ ] show a blocking Pi UI loop using `ctx.ui.select(...)`
  - [ ] open the appropriate Settings pane
  - [ ] recheck until granted or cancelled/aborted
- [ ] In non-interactive mode:
  - [ ] throw actionable missing-permission error
- [ ] Ensure user instructions name the **helper**, not `pi`.
- [ ] Include the stable helper path in the prompt text.

## Acceptance criteria

- [ ] Missing permissions block interactively until granted.
- [ ] Non-interactive contexts fail fast with the correct message.
- [ ] Permission checks are helper-based, not process-based on `pi`.

---

# Phase 6 — Implement native helper basics in Swift

## Tasks

- [ ] Implement helper stdin/stdout JSON-lines loop.
- [ ] Implement structured response and structured error format with echoed request `id`.
- [ ] Implement commands:
  - [ ] `checkPermissions`
  - [ ] `openPermissionPane`
  - [ ] `listApps`
  - [ ] `listWindows`
  - [ ] `getFrontmost`
  - [ ] `activateApp`
  - [ ] `raiseWindow`
  - [ ] `unminimizeWindow`
- [ ] Return enough window metadata for coordinate mapping:
  - [ ] title
  - [ ] `windowId`
  - [ ] `windowRef`
  - [ ] `framePoints`
  - [ ] `scaleFactor`
  - [ ] minimized / onscreen / main / focused flags

## Acceptance criteria

- [ ] TypeScript can discover apps/windows and resolve a live target.
- [ ] Helper can activate/raise/unminimize windows as needed.

---

# Phase 7 — Implement screenshots end-to-end

## Tasks

- [ ] In Swift helper, implement `screenshot(windowId)` using ScreenCaptureKit.
- [ ] Ensure image metadata includes width/height.
- [ ] If possible, disable/ignore shadows for clean coordinate mapping.
- [ ] In `src/bridge.ts`, implement:
  - [ ] target resolution for `screenshot({ app?, windowTitle? })`
  - [ ] current target update
  - [ ] image attachment result construction
  - [ ] `captureId` generation
  - [ ] current capture update
  - [ ] result `details` persistence
- [ ] Add fallback behavior:
  - [ ] if window capture fails because target is minimized/hidden/off-Space, try activate/raise/unminimize then retry

## Acceptance criteria

- [ ] `screenshot` can select a target and return an image attachment.
- [ ] `screenshot()` with no current target falls back to frontmost standard window.
- [ ] Result details include `captureId`, target metadata, dimensions, and scale factor.

---

# Phase 8 — Implement coordinate translation correctly

## Tasks

- [ ] In helper or TS runtime, define canonical conversion from screenshot pixels -> current screen points.
- [ ] Re-resolve live target frame at action time.
- [ ] Handle:
  - [ ] Retina displays
  - [ ] non-Retina displays
  - [ ] mixed-DPI multi-display setups
  - [ ] windows moved between screenshots
- [ ] Ensure all coordinate-based actions use the **same** conversion path.

## Acceptance criteria

- [ ] A coordinate from the latest screenshot maps to the intended on-screen location.
- [ ] Mapping remains correct after window moves or display changes, as long as the target window is still resolvable.

---

# Phase 9 — Implement mouse movement and clicks

## Tasks

- [ ] Implement helper command `mouseMove`.
- [ ] Implement helper command `mouseClick` with button + click count.
- [ ] In TS runtime, implement public tools:
  - [ ] `click`
  - [ ] `double_click`
  - [ ] `move_mouse`
- [ ] Add optional `captureId` validation.
- [ ] Add activate/raise/unminimize fallback when needed.
- [ ] After success, capture and return updated screenshot.
- [ ] If target missing, throw current-target error.
- [ ] If capture stale, throw stale-capture error.

## Acceptance criteria

- [ ] `click`, `double_click`, and `move_mouse` work against the current controlled window.
- [ ] Each successful call returns an updated screenshot.
- [ ] `double_click` is separate from `click`, not `clicks=2` in public schema.

---

# Phase 10 — Implement drag and scroll

## Tasks

- [ ] Implement helper `mouseDrag`.
- [ ] Implement helper `mouseScroll`.
- [ ] In TS runtime, implement public tools:
  - [ ] `drag`
  - [ ] `scroll`
- [ ] Validate drag path length >= 2.
- [ ] Validate optional `captureId`.
- [ ] For `scroll`, use `scrollX` / `scrollY` public fields.
- [ ] Treat scroll deltas as signed input deltas, not promised pixel-exact viewport movement.
- [ ] Return fresh screenshot after success.

## Acceptance criteria

- [ ] Drag works on coordinate-based/canvas-like UI.
- [ ] Scroll works at the requested point and returns updated screenshot.

---

# Phase 11 — Implement typing and keypresses

## Tasks

- [ ] Implement helper `focusedElement`.
- [ ] Implement helper `setValue` for standard text controls.
- [ ] Implement helper `keypress`.
- [ ] Implement helper clipboard helpers:
  - [ ] `getClipboard`
  - [ ] `setClipboard`
- [ ] In TS runtime, implement `type_text`:
  - [ ] use current controlled target only
  - [ ] inspect current focused element
  - [ ] try AX `setValue` when suitable
  - [ ] else preserve clipboard
  - [ ] set clipboard to desired text
  - [ ] paste via `keypress(['CMD', 'V'])`
  - [ ] if paste fails, fall back to raw key events
  - [ ] best-effort restore prior clipboard contents
  - [ ] return fresh screenshot
- [ ] Implement `keypress` public tool:
  - [ ] normalize keys array
  - [ ] activate target if needed
  - [ ] send shortcut
  - [ ] return fresh screenshot
- [ ] Never expose secure/password field values back to the model.

## Acceptance criteria

- [ ] `type_text` works after focusing a field with `click`.
- [ ] Clipboard is best-effort preserved/restored.
- [ ] Secure field contents are never leaked.
- [ ] `keypress` returns updated screenshot.

---

# Phase 12 — Implement wait

## Tasks

- [ ] Implement `wait({ ms? })` in TS runtime.
- [ ] Default `ms` to ~1000ms.
- [ ] Sleep, then capture and return updated screenshot.

## Acceptance criteria

- [ ] `wait` behaves like a lightweight polling step that returns a new screenshot.

---

# Phase 13 — Implement error model and result details consistently

## Tasks

- [ ] Ensure all operational failures throw actionable errors.
- [ ] Standardize stale-capture error text.
- [ ] Standardize missing-target error text.
- [ ] Standardize missing-permission error text.
- [ ] Standardize current-target-gone error text.
- [ ] Ensure all successful tools return a consistent `details` shape.
- [ ] Ensure all successful tools return:
  - [ ] one short text summary
  - [ ] one image attachment
  - [ ] structured details
- [ ] For failure cases that may have changed UI state, ensure error text tells the model to call `screenshot` again.

## Acceptance criteria

- [ ] Tool success/failure behavior is consistent across all 9 public tools.
- [ ] Error messages are actionable and model-friendly.

---

# Phase 14 — Implement session reconstruction

## Tasks

- [ ] On `session_start`, scan prior branch entries for latest computer-use tool result.
- [ ] Rebuild:
  - [ ] current target
  - [ ] current capture
- [ ] Do **not** attempt to persist AX element refs as durable state.
- [ ] Ensure stale remembered targets fail gracefully if app/window is gone.

## Acceptance criteria

- [ ] Resume/fork sessions retain the last controlled window logically.
- [ ] First action after resume works if target still exists.
- [ ] If target no longer exists, the next action errors cleanly and asks for `screenshot`.

---

# Phase 15 — Skill file

## Tasks

- [ ] Write `skills/computer-use/SKILL.md`.
- [ ] Include correct Agent Skills frontmatter.
- [ ] Keep it optional and not auto-injected.
- [ ] Teach only the public workflow:
  - [ ] call `screenshot` first
  - [ ] use coordinates from latest screenshot
  - [ ] use `type_text` after focusing a field
  - [ ] every successful action returns a fresh screenshot
  - [ ] call `screenshot` again if state is stale or target changed

## Acceptance criteria

- [ ] Skill helps, but the tools remain understandable without loading it.

---

# Phase 16 — Manual QA matrix

Run manual checks on real macOS apps.

## Basic targeting

- [ ] `screenshot()` with no current target captures frontmost standard window
- [ ] `screenshot(app, windowTitle)` selects requested window
- [ ] switching targets works repeatedly in one session

## Browser / document app

- [ ] click a button
- [ ] double-click selectable content
- [ ] move mouse to reveal hover UI
- [ ] scroll page/content
- [ ] click text field then `type_text`
- [ ] use shortcut via `keypress`

## Minimized / off-Space window

- [ ] target can be brought forward and captured
- [ ] action completes after unminimize/activation

## Typing

- [ ] AX `setValue` path works for standard text field
- [ ] paste fallback works
- [ ] raw key fallback works when paste is rejected
- [ ] clipboard is restored best-effort afterward

## Coordinate validation

- [ ] stale `captureId` errors correctly
- [ ] omitted `captureId` uses latest screenshot implicitly

## Multi-display

- [ ] non-primary display works
- [ ] mixed scale factor display works
- [ ] moving window between displays still works after fresh screenshot

## Resume/fork

- [ ] resume reconstructs current target/capture
- [ ] missing target after resume errors cleanly

---

# Phase 17 — Final polish and packaging

## Tasks

- [ ] Confirm helper path stability logic.
- [ ] Confirm no public AX/inspection surface leaked into prompt metadata.
- [ ] Confirm all tools are sequential.
- [ ] Confirm no eager helper startup.
- [ ] Confirm no permission prompt on extension load.
- [ ] Confirm package installs via git/local path.
- [ ] Confirm dev fallback source build instructions are correct.
- [ ] Add brief README or package-level usage notes if needed.

## Acceptance criteria

- [ ] Package matches reconstructed plan.
- [ ] Public API is Pi-friendly but Codex-faithful.
- [ ] Ready for Codex iterative implementation/testing.

---

# Definition of done

The implementation is done when all of the following are true:

- [ ] All 9 public tools exist and are registered correctly.
- [ ] `screenshot` selects the current controlled window.
- [ ] All successful action tools return a fresh screenshot.
- [ ] Coordinates are interpreted as window-relative screenshot pixels.
- [ ] `captureId` validation works.
- [ ] `type_text` works on the currently focused control.
- [ ] Activation/unminimize fallback works for minimized/off-Space windows.
- [ ] Permissions are granted to the helper via the interactive bootstrap flow.
- [ ] Current target/capture state reconstructs across resume/fork.
- [ ] No public AX/inspection tools are exposed.
- [ ] Package works in real macOS apps with mixed-DPI/multi-display setups.
