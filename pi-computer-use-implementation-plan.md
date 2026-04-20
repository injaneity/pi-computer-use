# pi-computer-use — Reconstructed Implementation Plan

**Package name:** `pi-computer-use`  
**Target platform:** macOS 15+ (Sequoia and later), Apple Silicon and Intel  
**Runtime:** Node.js (TypeScript), Pi extension API  
**Desired outcome:** A Pi package that gives the agent Codex-style local computer use on macOS: it can observe app windows, move the mouse, click, double-click, drag, scroll, type, press keys, and wait. V1 prioritizes non-intrusive background operation and reliability: avoid forced activate/raise/unminimize behavior in normal flow, use AX-first paths where possible, and fall back to vision/coordinate actions when AX is unavailable. No virtual display, no second user account, and no fork of Pi.

> Note: some later sections in this reconstructed plan still describe legacy activation-heavy behavior. Current implementation intent is non-intrusive default + AX-first/fallback strategy.

## Design priorities

1. **Be faithful to Codex computer use as far as possible.**
   - The underlying runtime model is screenshot + actions.
   - AX is an implementation detail, not the public contract.
   - Successful actions return a fresh screenshot.
2. **At the Pi compatibility layer, follow Pi conventions.**
   - Expose multiple focused tools instead of one giant `computer_use` union tool.
   - Use Pi-style tool schemas, prompt snippets, and sequential execution.
   - Signal errors using Pi's normal thrown-tool-error behavior.

---

## What we know from Codex + Pi + macOS

### Codex / OpenAI public computer-use contract

From the public Responses API schema and SDK types, Codex-style computer use is modeled as:

- a screenshot-driven loop
- with action types equivalent to:
  - `screenshot`
  - `click`
  - `double_click`
  - `move`
  - `drag`
  - `scroll`
  - `type`
  - `keypress`
  - `wait`
- and tool output that includes a screenshot after execution

Notably, the public schema does **not** expose:

- raw AX tree dumps
- AX element refs
- `click(ref)` / `type(ref)` style APIs

That strongly suggests the public model contract is **vision + actions**, while AX is used under the hood where helpful.

### macOS constraints that shape the implementation

- **ScreenCaptureKit** is the correct window-capture path on macOS 15+.
- `CGWindowListCreateImage` is removed on macOS 15, so no legacy screenshot fallback is needed.
- Standard text entry can often be done in the background via `AXUIElementSetAttributeValue(..., kAXValueAttribute, ...)`.
- Many coordinate-based actions still work best, or only reliably work, when the target window is active and visible.
- Minimized windows and windows on other Spaces are real edge cases; V1 should allow activation and unminimize to get the job done.

### Pi constraints and capabilities

- Pi custom tools are async TypeScript functions.
- Tool results can include **image attachments**.
- Tools can be marked `executionMode: "sequential"`, which is important because GUI state is shared and race-prone.
- Tool result `details` can be used to reconstruct extension state across resume/fork/branching.
- Pi tool errors should be signaled by **throwing**, not by returning success-shaped strings.

---

## Core product decisions

These decisions replace the older AX-heavy public design.

### 1. Public API: multiple Pi tools, not one `computer_use` mega-tool

To stay faithful to Codex semantics while still fitting Pi well, the package exposes **multiple focused tools** that map almost 1:1 to Codex actions.

Public tools:

- `screenshot`
- `click`
- `double_click`
- `move_mouse`
- `drag`
- `scroll`
- `type_text`
- `keypress`
- `wait`

Internally, these normalize into a single Codex-like action dispatcher.

### 2. AX is internal only

The package **does not** expose:

- `inspect_ui`
- `get_ax_tree`
- semantic refs
- AX element handles
- AX-specific public commands

AX is used internally for:

- window discovery and metadata
- focus/focused-element inspection
- background-safe text entry where possible
- unminimize / raise / activation helpers
- any future hidden optimizations for standard controls

### 3. `screenshot` selects the current controlled window

`screenshot` is both:

- the observation tool
- the target/window-selection tool

Rules:

- `screenshot({ app, windowTitle })` switches the current controlled target and captures it.
- `screenshot({})` captures the current target if one already exists.
- If there is no current target yet, `screenshot({})` captures the frontmost standard window and sets it as the current target.
- All other tools act on the **current controlled target** only.

This keeps the action tools small and close to Codex.

### 4. Successful action tools return a fresh screenshot

To stay close to Codex behavior:

- every successful action tool returns a fresh screenshot of the current target
- the screenshot becomes the new current capture
- the result includes a new `captureId`

This applies to:

- `click`
- `double_click`
- `move_mouse`
- `drag`
- `scroll`
- `type_text`
- `keypress`
- `wait`
- and naturally `screenshot`

### 5. Coordinates are screenshot-relative

All public coordinates are:

- **window-relative**
- **top-left origin**
- expressed in **pixels of the returned screenshot image**

This coordinate system is shared by:

- `click.x`, `click.y`
- `double_click.x`, `double_click.y`
- `move_mouse.x`, `move_mouse.y`
- `scroll.x`, `scroll.y`
- every point in `drag.path`

### 6. `captureId` is optional validation, not required ceremony

Every successful screenshot-bearing result returns a `captureId` in `details`.

Action tools may accept an optional `captureId`:

- if present, the runtime validates it against the current capture/target state
- if stale or mismatched, the tool throws an actionable error
- if omitted, the latest capture is used implicitly

This gives Pi a safety check without forcing the model to thread IDs through every action.

### 7. Typing is Codex-style

Public typing is just:

```json
{ "text": "hello world" }
```

No public `x,y` typing. No refs.

If the model needs to type into a specific field, it should click that field first, then call `type_text`.

### 8. Activation is allowed when needed, and the target stays frontmost afterward

If the runtime activates a target window to complete an action, it leaves that target frontmost. V1 does **not** attempt to restore the previously frontmost app/window.

### 9. Minimized / off-Space windows are in scope

If needed, the runtime may:

- activate the app
- raise the window
- unminimize the window
- switch Spaces indirectly through activation/raise behavior

Correctness is more important than complete invisibility in V1.

---

## Public tool surface

These are the agent-facing tools.

### Tool list

| Tool | Parameters | Purpose |
|---|---|---|
| `screenshot` | `{ app?: string, windowTitle?: string }` | Capture the current target window, or select and capture a new target window. |
| `click` | `{ x: number, y: number, button?: "left" \| "right" \| "wheel" \| "back" \| "forward", captureId?: string }` | Click at a screenshot-relative coordinate in the current target window. |
| `double_click` | `{ x: number, y: number, captureId?: string }` | Double-click at a screenshot-relative coordinate. |
| `move_mouse` | `{ x: number, y: number, captureId?: string }` | Move the pointer to a screenshot-relative coordinate. Useful for hover-only UI. |
| `drag` | `{ path: Array<{ x: number, y: number }>, captureId?: string }` | Drag along a screenshot-relative path. |
| `scroll` | `{ x: number, y: number, scrollX: number, scrollY: number, captureId?: string }` | Scroll at a screenshot-relative coordinate using signed deltas. |
| `type_text` | `{ text: string }` | Type text into the currently focused control in the current target window. |
| `keypress` | `{ keys: string[] }` | Press a key or shortcut in the current target window. |
| `wait` | `{ ms?: number }` | Sleep briefly, then return a fresh screenshot. |

### Tool behavior contract

#### `screenshot({ app?, windowTitle? })`

Semantics:

- If `app` or `windowTitle` is provided, resolve a new target and make it current.
- If omitted, capture the existing target.
- If there is no existing target, capture the frontmost standard window and make it current.

Resolution rules:

- app match: exact case-insensitive match preferred over unique substring match
- window title: exact case-insensitive match preferred over unique substring match
- if no `windowTitle` is provided, prefer the app's main/focused visible standard window
- if multiple matches remain ambiguous, throw and ask for a more specific window title

Returns:

- short text summary
- image attachment
- structured details including target metadata, dimensions, scale factor, and `captureId`

#### `click({ x, y, button?, captureId? })`

Semantics:

- Validate optional `captureId`
- Translate screenshot-relative coordinates to current screen coordinates for the current target
- If required for correctness, activate/raise/unminimize first
- Post a mouse click using the requested button
- Capture and return the updated screenshot

Defaults:

- `button` defaults to `"left"`

#### `double_click({ x, y, captureId? })`

Semantics:

- Same targeting and validation rules as `click`
- Always performs a left-button double click
- Returns a fresh screenshot

#### `move_mouse({ x, y, captureId? })`

Semantics:

- Moves the pointer to the requested coordinate in the current target window
- Intended for hover-only or pointer-position-dependent UI
- Returns a fresh screenshot so the model can observe hover state/tooltips/menus

#### `drag({ path, captureId? })`

Semantics:

- `path` is an array of screenshot-relative points, length >= 2
- Translates the path to current screen coordinates at execution time
- Activates/raises/unminimizes if needed
- Performs mouse down / move / up along the path
- Returns a fresh screenshot

#### `scroll({ x, y, scrollX, scrollY, captureId? })`

Semantics:

- Scroll at the given coordinate in the current target window
- `scrollX` and `scrollY` are signed deltas
- They should be treated as input deltas, not guaranteed pixel-exact visual movement
- Returns a fresh screenshot

#### `type_text({ text })`

Semantics:

- Operates on the current target window's currently focused control
- Intended usage is usually:
  1. `click(...)` to focus a field
  2. `type_text({ text })`
- Internally, the runtime may use AX `setValue` on the focused element if that is the safest/reliable path
- If AX text setting is not available, the runtime may activate the target and fall back to clipboard-paste or raw key events
- Returns a fresh screenshot

#### `keypress({ keys })`

Semantics:

- `keys` is a canonical array of key names, e.g. `['CMD', 'L']`, `['SHIFT', 'TAB']`, `['ENTER']`
- A `prepareArguments()` function may accept convenience string forms like `"cmd+l"` and normalize them into arrays
- Operates on the current target window
- Activates target if needed
- Returns a fresh screenshot

#### `wait({ ms? })`

Semantics:

- Sleep for `ms` milliseconds, default ~1000ms
- Then return a fresh screenshot of the current target
- Used for slow loads, animations, async state changes, or deliberate polling

### Tool usage rules the prompt metadata should make obvious

Without requiring a huge system prompt, the tools should communicate these rules:

- **Call `screenshot` first** to choose a target window and get the initial image
- **Call `screenshot(app, windowTitle)` again to switch windows**
- All other tools act on the **current target window**
- Coordinates come from the **latest screenshot**
- `type_text` types into the **currently focused** control; click first if needed
- Every successful action tool returns a **new screenshot**

---

## State model

The runtime maintains a small amount of state per Pi session.

### Current target state

```ts
interface CurrentTarget {
  appName: string;
  bundleId?: string;
  pid: number;
  windowTitle: string;
  windowId: number;
  axWindowRef?: string;          // transient, not persisted across resume/fork
}
```

### Current capture state

```ts
interface CurrentCapture {
  captureId: string;
  width: number;
  height: number;
  scaleFactor: number;
  timestamp: number;
}
```

### Persisted vs transient

Persist/rebuild from tool result `details`:

- current target identity
- current capture metadata
- last `captureId`
- width / height / scale factor

Do **not** persist as durable:

- AX element refs
- hit-test caches
- focused element refs
- any transient helper handles except as opportunistic in-memory cache

### Resume / fork reconstruction

On `session_start`, the extension should scan `ctx.sessionManager.getBranch()` backwards for the latest tool result from one of the computer-use tools and reconstruct:

- `currentTarget`
- `currentCapture`

This gives branch/fork/resume behavior that fits Pi's model.

If the remembered app/window is no longer available at execution time, the next action should throw:

```text
The last controlled window is no longer available. Call screenshot to choose a new target window.
```

---

## Package layout

```text
pi-computer-use/
├── package.json
├── extensions/
│   └── computer-use.ts           # tool registration + state reconstruction
├── native/
│   └── macos/
│       └── bridge.swift          # single helper: screenshots, AX, input, permissions
├── prebuilt/
│   └── macos/
│       ├── arm64/
│       │   └── bridge            # signed/notarized release helper
│       └── x64/
│           └── bridge            # signed/notarized release helper
├── scripts/
│   ├── setup-helper.mjs          # choose/copy embedded helper to stable path
│   └── build-native.mjs          # local source-build fallback for dev/clones
├── src/
│   ├── bridge.ts                 # all TS runtime logic + public tool execute functions
│   └── permissions.ts            # interactive permission bootstrap loop
└── skills/
    └── computer-use/
        └── SKILL.md              # optional skill, not auto-injected
```

### Canonical helper runtime path

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

This path should be used regardless of:

- global install
- project install
- local path install
- package version

The goal is to keep TCC approvals attached to one stable helper identity/path.

---

## Native helper: `native/macos/bridge.swift`

A single unsandboxed Swift helper handles:

- window screenshots via ScreenCaptureKit
- app/window enumeration and metadata
- app activation, window raising, and unminimize
- focused-element inspection for typing
- AX text setting where helpful
- mouse movement/click/drag/scroll event synthesis
- keypress synthesis
- clipboard set/restore support
- permission checks and Settings deep links

One process, one JSON-lines protocol, one request/response correlation mechanism.

### Suggested helper commands

```json
{ "cmd": "checkPermissions" }
{ "cmd": "openPermissionPane", "kind": "accessibility" }
{ "cmd": "openPermissionPane", "kind": "screenRecording" }

{ "cmd": "listApps" }
{ "cmd": "listWindows", "pid": 12345 }
{ "cmd": "getFrontmost" }
{ "cmd": "activateApp", "pid": 12345 }
{ "cmd": "raiseWindow", "windowRef": "..." }
{ "cmd": "unminimizeWindow", "windowRef": "..." }

{ "cmd": "focusedElement", "pid": 12345 }
{ "cmd": "setValue", "elementRef": "...", "value": "hello world" }

{ "cmd": "screenshot", "windowId": 987 }
{ "cmd": "mouseMove", "windowId": 987, "x": 420, "y": 86 }
{ "cmd": "mouseClick", "windowId": 987, "x": 420, "y": 86, "button": "left", "clicks": 1 }
{ "cmd": "mouseDrag", "windowId": 987, "path": [{ "x": 100, "y": 100 }, { "x": 200, "y": 200 }] }
{ "cmd": "mouseScroll", "windowId": 987, "x": 640, "y": 480, "scrollX": 0, "scrollY": 720 }
{ "cmd": "keypress", "keys": ["CMD", "V"] }
{ "cmd": "getClipboard" }
{ "cmd": "setClipboard", "value": "text to paste" }
```

### Important identities

- `windowRef`: opaque AX handle for a window
- `windowId`: CGWindowID / ScreenCaptureKit window identifier

These are related but not interchangeable.

### `listWindows(pid)` return shape

Return enough metadata for capture, activation logic, and coordinate mapping:

```json
[
  {
    "windowRef": "ax:...",
    "windowId": 987,
    "title": "Example",
    "framePoints": { "x": 120, "y": 88, "w": 1280, "h": 900 },
    "scaleFactor": 2,
    "isMinimized": false,
    "isMain": true,
    "isFocused": false,
    "isOnscreen": true
  }
]
```

### Screenshot behavior

`screenshot(windowId)` should:

- use `SCScreenshotManager.captureImage`
- capture the specific window only
- ignore or disable shadows if possible so screenshot pixels map to actionable coordinates cleanly
- return base64 PNG bytes or equivalent image payload plus width/height metadata

### Mouse and coordinate behavior

The helper receives **window-relative screenshot pixels** and should:

1. resolve the current window frame in screen points
2. use the current scale factor to convert screenshot pixels → screen points
3. translate into absolute screen coordinates
4. synthesize the requested mouse action

This must work on:

- Retina and non-Retina displays
- non-primary displays
- mixed-DPI multi-monitor setups
- windows that have moved since the last screenshot, as long as the target window can still be resolved

### Typing helpers

`focusedElement(pid)` should return enough metadata to decide whether AX `setValue` is viable for the currently focused control.

Rules:

- if focused element is a standard text field/text view, `setValue` is preferred when it is likely to be more reliable than raw key events
- secure/password field values must never be exposed back to the model
- secure/password fields may still accept `setValue` or typed input internally

### Activation / unminimize policy

The helper or TS layer may activate/raise/unminimize when:

- the target window is minimized
- the target is on another Space or not visible enough for reliable action/capture
- coordinate-based input requires the target to be frontmost
- keyboard focus is required for paste/raw typing or shortcuts

### Permissions

The helper is the canonical TCC target.

It needs:

- **Accessibility** permission
- **Screen Recording** permission

The plan should never instruct users to add `pi` itself. The user grants permissions to the helper at the stable helper path.

---

## TypeScript runtime: `src/bridge.ts`

This file owns all runtime logic between Pi tools and the helper process.

### Responsibilities

- lazy helper install/selection
- helper process lifecycle
- JSON-lines protocol and request correlation
- current target and capture state
- session-state reconstruction support
- target resolution
- coordinate validation and optional `captureId` validation
- internal Codex-like action dispatch
- public tool execute functions
- brief post-action waits when appropriate
- clipboard preservation during typing fallback

### Internal action type

The public multiple tools normalize into a single internal action family:

```ts
type InternalAction =
  | { type: "screenshot" }
  | { type: "click"; x: number; y: number; button: "left" | "right" | "wheel" | "back" | "forward" }
  | { type: "double_click"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; path: Array<{ x: number; y: number }> }
  | { type: "scroll"; x: number; y: number; scrollX: number; scrollY: number }
  | { type: "type"; text: string }
  | { type: "keypress"; keys: string[] }
  | { type: "wait"; ms: number };
```

### Core helpers

```ts
async function ensureReady(ctx: ExtensionContext): Promise<void>
async function bridge(cmd: object): Promise<any>
async function resolveTarget(selection?: { app?: string; windowTitle?: string }): Promise<ResolvedTarget>
async function dispatch(action: InternalAction): Promise<ActionResult>
async function captureCurrentTarget(reason: string): Promise<CaptureResult>
function stopBridge(): void
```

### Lazy bootstrap flow

Every tool begins with `ensureReady(ctx)`.

`ensureReady(ctx)` should:

1. ensure the canonical helper exists, running `setup-helper` logic if needed
2. start the helper if not already running
3. check permissions through the helper
4. if permissions are missing, delegate to `ensurePermissions(ctx)`
5. return only when helper + permissions are ready

This keeps the package lazy while still allowing the helper to be the single permission authority.

### Process management

- one long-lived child process
- JSON line protocol over stdin/stdout
- request `id` correlation
- per-call timeouts
- automatic restart if the helper dies between tool calls
- all public tools also marked `executionMode: "sequential"` to avoid sibling races at the Pi level

### Target resolution strategy

The TS runtime keeps `currentTarget` in memory and re-resolves it as needed against live app/window data.

If `screenshot({ app, windowTitle })` is called:

- resolve app
- resolve window
- update `currentTarget`
- capture

If `screenshot({})` is called:

- if `currentTarget` exists, re-resolve it and capture
- otherwise resolve the frontmost standard window and set it as `currentTarget`

If any non-screenshot action is called and no current target exists:

- throw:

```text
No current controlled window. Call screenshot first to choose a target window.
```

If the remembered target can no longer be resolved:

- throw:

```text
The current controlled window is no longer available. Call screenshot to choose a new target window.
```

### Capture validation

If an action includes `captureId`:

- compare it to `currentCapture.captureId`
- if mismatched, throw an actionable stale-capture error

Suggested error:

```text
The coordinates were based on an older screenshot. Call screenshot again to refresh the current window state.
```

### Dispatch behavior by action

#### `screenshot`

- resolve current target
- capture it
- generate a new `captureId`
- update `currentCapture`
- return image attachment + details

#### `click`

- validate current target and optional `captureId`
- activate/raise/unminimize if needed
- dispatch helper `mouseClick`
- brief settle wait (~300ms)
- capture current target
- update `captureId`
- return image attachment + details

#### `double_click`

Same as click, but helper click count is 2 and button is left.

#### `move`

- validate state
- activate if needed
- dispatch helper `mouseMove`
- brief settle wait if hover UI might need it
- capture current target

#### `drag`

- validate state
- activate/raise/unminimize if needed
- dispatch helper `mouseDrag`
- brief settle wait
- capture current target

#### `scroll`

- validate state
- activate if needed
- dispatch helper `mouseScroll`
- brief settle wait
- capture current target

#### `type`

Priority order:

1. ensure target is ready/focused enough for text entry
2. query helper `focusedElement`
3. if focused element is a suitable text control, try AX `setValue`
4. otherwise preserve clipboard, set clipboard to desired text, paste via `keypress(['CMD','V'])`
5. if paste fails, fall back to raw key events
6. best-effort restore prior clipboard contents
7. capture current target

This preserves Codex-style public semantics while still taking advantage of AX internally.

#### `keypress`

- normalize keys array
- activate target if needed
- dispatch helper keypress
- brief settle wait
- capture current target

#### `wait`

- sleep `ms` or default
- capture current target

### Public execute functions

Each public tool execute function should be small:

- validate args
- `ensureReady(ctx)`
- normalize to internal action
- `dispatch(...)`
- return Pi result object

Canonical signatures:

```ts
export async function screenshot(toolCallId, params, signal, onUpdate, ctx)
export async function click(toolCallId, params, signal, onUpdate, ctx)
export async function doubleClick(toolCallId, params, signal, onUpdate, ctx)
export async function moveMouse(toolCallId, params, signal, onUpdate, ctx)
export async function drag(toolCallId, params, signal, onUpdate, ctx)
export async function scroll(toolCallId, params, signal, onUpdate, ctx)
export async function typeText(toolCallId, params, signal, onUpdate, ctx)
export async function keypress(toolCallId, params, signal, onUpdate, ctx)
export async function wait(toolCallId, params, signal, onUpdate, ctx)
```

### Tool result shape

All successful tools return:

- one short text summary
- one image attachment
- structured details

Suggested details shape:

```ts
interface ComputerUseDetails {
  tool: string;
  target: {
    app: string;
    bundleId?: string;
    pid: number;
    windowTitle: string;
    windowId: number;
  };
  capture: {
    captureId: string;
    width: number;
    height: number;
    scaleFactor: number;
    coordinateSpace: "window-relative-screenshot-pixels";
  };
  activation: {
    activated: boolean;
    unminimized: boolean;
    raised: boolean;
  };
}
```

Example summary text:

```text
Clicked at (420,86) in Safari — Example. Returned updated screenshot. Coordinates are window-relative screenshot pixels.
```

### Error behavior

Use Pi-style tool errors:

- throw actionable errors from `execute`
- do not flatten failures into success-shaped text

Because Pi uses thrown exceptions to mark tool errors, V1 does **not** guarantee an image attachment on failed actions. If a failure may have changed state, the thrown error should tell the model to call `screenshot` again immediately.

---

## Permissions: `src/permissions.ts`

Permission handling is lazy and interactive-first.

### Behavior

`ensurePermissions(ctx)` should:

1. ask the helper for `checkPermissions`
2. if both permissions are granted, return immediately
3. if the current context is non-interactive, throw an actionable error telling the user to run Pi interactively and grant permissions to the helper
4. if interactive, block in a Pi UI loop until permissions are granted or the session/tool is aborted

### UX model

Use Pi dialogs, not a permanent extension UI.

Suggested loop:

- show a `ctx.ui.select(...)` prompt with options like:
  - `Open Accessibility Settings`
  - `Open Screen Recording Settings`
  - `Recheck`
  - `Cancel`
- after opening a settings pane, return to the loop
- keep polling/rechecking via `checkPermissions`
- exit only when both permissions are granted or the tool/session is cancelled

The prompt must clearly say:

- which permissions are missing
- that the permissions must be granted to the **signed `pi-computer-use` helper**
- the stable helper path

### Non-interactive behavior

If no interactive UI is available and permissions are missing, throw:

```text
Computer use requires interactive permission setup. Start pi in interactive mode and grant Accessibility and Screen Recording to the signed pi-computer-use helper.
```

---

## Extension entrypoint: `extensions/computer-use.ts`

This file should stay thin.

### Responsibilities

- register all public tools immediately
- mark them `executionMode: "sequential"`
- set concise `promptSnippet` / `promptGuidelines` metadata
- rebuild persisted state on `session_start`
- stop the helper on `session_shutdown`

### It should not

- start the helper on `session_start`
- check permissions on `session_start`
- auto-inject the skill into the system prompt

### Tools to register

- `screenshot`
- `click`
- `double_click`
- `move_mouse`
- `drag`
- `scroll`
- `type_text`
- `keypress`
- `wait`

### Prompt metadata strategy

Keep it small and obvious.

Examples:

- `screenshot.promptSnippet`: `Capture and select a macOS window. Call this first and to switch windows.`
- `click.promptGuidelines`: `Coordinates come from the latest screenshot of the current window. This tool returns an updated screenshot.`
- `type_text.promptGuidelines`: `Types into the currently focused control in the current window. Click first if needed. Returns an updated screenshot.`

This keeps the tools understandable without a massive injected system prompt.

---

## Optional skill: `skills/computer-use/SKILL.md`

The skill remains optional and is **not auto-injected**.

It exists to give the model more workflow guidance when needed, but the public tools should still be usable without reading it.

### Suggested frontmatter

```yaml
---
name: computer-use
description: Interact with macOS GUI windows using screenshots, clicks, double-clicks, mouse movement, dragging, scrolling, typing, keypresses, and waits. Use when the task requires operating an app window instead of only files or shell commands.
---
```

### Key content

- Call `screenshot` first to select a target window and see its current state
- Use `screenshot(app, windowTitle)` to switch windows
- All action tools operate on the current target window
- Coordinates come from the latest screenshot
- `type_text` acts on the currently focused control, so click a field first if needed
- Every successful action tool returns a fresh screenshot
- If an action errors because the screenshot is stale or the target changed, call `screenshot` again

---

## Helper distribution and setup

### Release / normal install path

Ship embedded signed/notarized helpers for:

- `prebuilt/macos/arm64/bridge`
- `prebuilt/macos/x64/bridge`

`setup-helper.mjs` should:

1. detect architecture
2. choose the embedded matching helper
3. copy it to:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

4. overwrite in place if the shipped helper hash changed
5. preserve the same stable destination path across installs and upgrades

### Local dev / clone fallback

If no embedded prebuilt helper is available, or if a developer explicitly opts into it, support a local build fallback:

```bash
xcrun swiftc -O \
  -framework ApplicationServices \
  -framework ScreenCaptureKit \
  -framework Foundation \
  native/macos/bridge.swift -o <output-path>
```

Notes:

- Requires Xcode Command Line Tools
- A dev-built helper may require separate permissions; that is acceptable in development

### Packaging rule

Do **not** rely on `postinstall` alone.

`postinstall` should opportunistically prepare the helper, but first-use lazy bootstrap must run the same helper-setup logic if the canonical helper path is missing.

---

## `package.json`

Suggested shape:

```json
{
  "name": "pi-computer-use",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/computer-use.ts"],
    "skills": ["./skills"]
  },
  "scripts": {
    "postinstall": "node scripts/setup-helper.mjs --postinstall",
    "build:native": "node scripts/build-native.mjs"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-ai": "*",
    "@sinclair/typebox": "*"
  }
}
```

No heavy runtime dependencies should be necessary.

---

## Error handling contract

All operational failures should be thrown as Pi tool errors.

Examples:

- `Accessibility permission is not granted to the signed pi-computer-use helper.`
- `Screen Recording permission is not granted to the signed pi-computer-use helper.`
- `Computer use requires interactive permission setup. Start pi in interactive mode and grant permissions to the helper.`
- `No current controlled window. Call screenshot first to choose a target window.`
- `The current controlled window is no longer available. Call screenshot to choose a new target window.`
- `The coordinates were based on an older screenshot. Call screenshot again to refresh the current window state.`
- `App 'Figma' is not running.`
- `Window 'Project Settings' was not found in app 'Figma'.`
- `The target window could not be activated or unminimized.`
- `Typing failed through AX text setting, clipboard paste, and raw key events. Click the intended field and try again.`

Because Pi marks errors via thrown exceptions, V1 does not guarantee a screenshot attachment on failed actions. Error messages should explicitly tell the model when it should refresh state with `screenshot`.

---

## Compatibility matrix

| Dimension | Status | Notes |
|---|---|---|
| macOS below 15 | ❌ | Not supported |
| macOS 15 Sequoia | ✅ | Primary target |
| macOS 16+ | ✅ | Expected to work; retest on new releases |
| Apple Silicon | ✅ | Signed embedded arm64 helper |
| Intel | ✅ | Signed embedded x64 helper |
| Interactive Pi session | ✅ | Full permission bootstrap supported |
| Non-interactive / SDK | ✅* | Works after permissions already granted; missing-permission bootstrap fails fast |
| Minimized windows | ✅ | Helper may unminimize/activate |
| Off-Space windows | ✅ | Helper may activate/raise them |
| Multi-display mixed-DPI setups | ✅ | In scope for V1 |
| Image-capable model | ✅ | Required for effective computer use |
| Text-only model | ⚠️ | Tools still exist, but computer use is not meaningfully usable |
| Fully invisible/background operation | ⚠️ | Best effort only; not guaranteed for every app/action |

---

## What V1 does NOT implement

- A guarantee of fully invisible/background automation for every macOS app
- A virtual display, VM, or second user account
- A Pi fork
- App-level permission allowlists/policy gating in V1
- Public AX inspection tools as part of the default agent contract
- Windows or Linux support
- A ghost cursor overlay
- Parallel computer-use streams against the same UI state

---

## Installation and first use

### Install

```bash
pi install git:github.com/your-org/pi-computer-use
```

### Expected behavior

- tools are available immediately after install
- helper is prepared during install if possible
- on first actual computer-use tool call, the package verifies helper presence, checks permissions, prompts if needed, then executes

### First useful call

The first meaningful action in a session should typically be:

```text
screenshot
```

or to switch/select a specific app window:

```text
screenshot app="Safari" windowTitle="Example"
```

That selects the current controlled target and returns the image the model should reason over.

---

## Key references

**Pi**
- Extension API docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Pi package format: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md
- Pi skills docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md

**OpenAI / Codex computer use**
- OpenAI Codex computer use announcement: https://openai.com/index/codex-for-almost-everything/
- Codex computer use docs (app-level): https://developers.openai.com/codex/app/computer-use
- OpenAI Responses / tools docs: https://platform.openai.com/docs/guides/tools-computer-use
- OpenAI Node SDK Responses types (`computer_call`, `computer_call_output`, `computer_use_preview`): https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts
- MacStories deep dive on Codex + Sky / AX usage: https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/
- Manton Reece on the cosmetic cursor: https://www.manton.org/2026/04/17/codex-and-sky-polish.html

**macOS APIs**
- AXUIElement reference: https://developer.apple.com/documentation/applicationservices/axuielement_h
- Accessibility programming guide: https://developer.apple.com/library/archive/documentation/Accessibility/Conceptual/AccessibilityMacOSX/
- ScreenCaptureKit intro: https://developer.apple.com/videos/play/wwdc2022/10156/
- SCScreenshotManager overview: https://nonstrict.eu/blog/2023/a-look-at-screencapturekit-on-macos-sonoma/
- Background keyboard/input limitation discussion: https://developer.apple.com/forums/thread/695941
- `CGWindowListCreateImage` removal in macOS 15: https://akrabat.com/quickss-screenshot-the-active-window-on-mac/

---

## Estimated scope

| Component | Complexity | Notes |
|---|---|---|
| `native/macos/bridge.swift` | Medium-High | Window capture, input synthesis, activation/unminimize, focused element + AX text path, permissions |
| `src/bridge.ts` | Medium | State model, helper lifecycle, target selection, capture validation, internal action dispatch, 9 public tools |
| `src/permissions.ts` | Low-Medium | Interactive blocking permission loop |
| `extensions/computer-use.ts` | Low | Registration + state reconstruction only |
| `scripts/setup-helper.mjs` | Low-Medium | Embedded helper copy to stable path |
| `scripts/build-native.mjs` | Low | Dev fallback source build |
| `skills/computer-use/SKILL.md` | Low | Optional workflow guidance |

**Rough total:** ~900–1200 lines across TS, Swift, and scripts.

### Hardest parts

1. Correct coordinate translation across Retina, mixed-DPI, and moving windows
2. Reliable activation/unminimize behavior for minimized/off-Space windows
3. Clipboard-preserving text fallback that still behaves well in real apps
4. Keeping the helper identity/path stable enough to minimize repeated TCC approvals
5. Preserving Codex-like screenshot-after-action behavior while still fitting Pi's error model
