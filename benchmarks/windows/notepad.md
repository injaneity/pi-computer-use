# Manual Benchmark: Notepad Discovery and Screenshot

Verify that `pi-computer-use` can discover Notepad windows via the
Windows bridge and produce state IDs, window refs, element refs, and
a screenshot.  Also verify that action and CDP commands correctly
return `capability_deferred`.

## Prerequisites

- Windows 10 or later
- Rust toolchain (to build the helper, or a prebuilt
  `windows-bridge.exe`)
- `pi-computer-use` Node.js package installed
- Notepad accessible via `notepad` (comes with Windows)

---

## Checklist

### 1. Build the Windows helper

```powershell
cargo build --manifest-path native/windows/bridge-rs/Cargo.toml --release
```

Expected: a binary at
`native/windows/bridge-rs/target/release/windows-bridge.exe`.

If prebuilt, copy it to
`%USERPROFILE%\.pi\agent\helpers\pi-computer-use\windows-bridge.exe`.

---

### 2. Open Notepad

Open Notepad (Start → type "Notepad" → Enter).

---

### 3. Discover windows

Call `list_windows` from the pi-computer-use toolchain.

Expected output:

- A `stateId` prefixed with `w-` (e.g. `w-0`)
- At least one window entry for Notepad with:
  - `ref`: `@w1` (or the first window ref)
  - `title`: `"Untitled - Notepad"`
  - `processName`: `"notepad.exe"`
  - `isBrowser`: `false`
  - `bounds`: non-zero width and height

Note the window ref (e.g. `@w1`) for the next step.

---

### 4. Screenshot the Notepad window

Call `screenshot({ window: "@w1" })` using the ref from Step 3.

Expected output:

- A `stateId` prefixed with `s-` (e.g. `s-0`)
- `width` and `height` matching the Notepad window (at least 200×100)
- A base64-encoded PNG image in `imageBase64`
- `scaleFactor`: `1`
- `axTargets` array (when `includeElements` is enabled by default)
  containing element refs (e.g. `@e1`, `@e2`, …)

---

### 5. Verify UIA element refs

If element extraction was included, check that the `axTargets` array
contains at least one element with:

- A `ref` string in `@eN` format (e.g. `@e1`)
- A non-empty `role` string
- Valid `bounds`

Typical Notepad elements: `edit` (text area), `menuItem` (menu bar),
`button` (minimise/maximise/close).

---

### 6. Open a browser (Edge or Chrome)

Open Microsoft Edge or Google Chrome to a blank or default page.
Do not navigate away from the default page.

---

### 7. Discover the browser window

Call `list_windows` again.

Expected: At least one new entry for the browser with:

- `isBrowser`: `true`
- `browserFamily`: `"edge"` or `"chrome"`
- A process name ending in `msedge.exe` or `chrome.exe`

---

### 8. Screenshot the browser window

Using the browser's window ref, call `screenshot`.

Expected: A valid screenshot of the browser window (same shape as
Step 4).  Windows that use hardware acceleration may show partial or
blank content via GDI — this is a known limitation.

---

### 9. Verify a deferred action

Call any action command (e.g. `click`, `type_text`, `keypress`).

Expected: The command returns `capability_deferred` with a message
similar to:

> Windows ref-backed actions are deferred in PR #1. This PR supports
> window discovery, screenshots, state IDs, and read-only UIA element
> discovery.

Do NOT verify that the action executes — verify that it refuses with
the deferred error.

---

### 10. Verify a deferred CDP command

Call any CDP-requiring command (e.g. `navigate_browser`,
`evaluate_browser`, `launch_browser_context`).

Expected: Same `capability_deferred` response as Step 9.

---

## Pass / Fail

All checks pass if:

1. `list_windows` returns a valid Notepad entry with a `@wN` ref and
   a `stateId`
2. `screenshot({ window: "@wN" })` returns a valid image and state ID
3. `axTargets` contains at least one `@eN` ref with valid properties
4. Browser window is reported with `isBrowser: true`
5. Action command returns `capability_deferred`
6. CDP-requiring command returns `capability_deferred`

Record the `stateId` and ref count for traceability.
