# Windows Bridge

`windows-bridge.exe` is the native helper for the root-forest Windows backend. It is spawned by the TypeScript helper client and speaks stdin/stdout JSON-lines protocol version **3**.

## Backend contract

The TypeScript Windows backend is intentionally stateless. It forwards root-forest seam calls to the Rust helper:

- `listRoots({ pid? })`: cheap HWND metadata only. Roots do not fabricate pairing or sheet counts; HWND/class/style diagnostics live under `metadata` when useful.
- `look`: atomic observe result with `lookId`, outline, window payload (`rootRef`, `kind`, frame, scale), and optional image. Menu/outline-only roots omit `image`; coordinate acts against those roots fail with `coordinate_unavailable_for_root`.
- `act`: forwards the typed `PlatformActRequest` whole. The helper validates `lookId`, resolves refs from helper-owned look state, applies policy, executes, and returns honest outcome/evidence plus `performed.deltaSource` and shallow `rootDelta`.
- `uiaReadText` / `uiaWaitFor`: helper-side live UIA reads/polls. No TypeScript screenshot polling or module-level element state is used.

## Root metadata

Windows roots are top-level HWNDs:

- `#32768` class => `kind: "menu"`
- `#32770` class => `kind: "dialog"`
- owned popups => `kind: "popover"`
- other HWNDs => `kind: "window"`

The helper declares per-monitor-v2 DPI awareness at startup and reports `scaleFactor = GetDpiForWindow(hwnd) / 96`.

## Refs, actions, and deltas

Observed `@e` refs store UIA RuntimeId and AutomationId metadata. Ref-targeted actions resolve a live `IUIAutomationElement` first:

- `press`/`click`: `InvokePattern`, then `TogglePattern`, then `SelectionItemPattern`, then `ExpandCollapsePattern`, then LegacyIAccessible default action; successful pattern grounding reports `grounding: "description"`, `delivery: "ax"`. Coordinate fallback is blocked by `ax_only` and preflights occlusion with `ElementFromPoint`.
- `setText`: `ValuePattern.SetValue`, then `CurrentValue` read-back. `evidence.value` is the value actually read.
- `scroll`: `ScrollPattern` where exposed; wheel fallback is raw input and policy-gated.
- `typeText`, `keypress`, `drag`, `moveMouse`, and coordinate targets remain raw input and report `unknown` unless verified.

`readText` resolves the live element and reads TextPattern → ValuePattern → CurrentName. `waitFor` polls the live UIA subtree at about 150ms intervals.

Root deltas are baselined at act time. The helper polls a cheap top-level HWND signature for early settle (`deltaSource: "win-poll"`), then takes short catch-up snapshots before returning the final full before/after diff. If no change is seen before the cap, it returns the full snapshot timeout path (`"snapshot"`).

## Protocol

Request envelope:

```json
{ "protocolVersion": 3, "id": "req_1", "cmd": "listRoots", "args": {} }
```

Response envelope:

```json
{ "protocolVersion": 3, "id": "req_1", "ok": true, "result": { } }
```

Diagnostics (`cmd: "diagnostics"`) returns the protocol version and helper process metadata. The TypeScript backend rejects a mismatched version with a “Restart Pi …” error.

## Remote acceptance notes

- **Item 5 / menus:** click Notepad's File menu, read `rootDelta`, then observe the `appeared` root's `ref`. Menus are separate roots; observing the original Notepad window will not show the menu contents.
- **Item 7 / occlusion:** record element coordinates from a fresh look, cover the window, then issue a coordinate act (`target: { "x": ..., "y": ... }`, `policy: "default"`). Expect `occluded_target`. Ref-targeted acts may re-resolve and do not exercise this coordinate preflight path.
- **Item 8 / ref re-resolve:** fresh look, capture any element ref, move the window, then act on the same ref with the same `lookId`. RuntimeId/AutomationId re-resolution should succeed with refound semantics, not `stale_ref`.
- **Pressability smoke:** a fresh look at Win11 Notepad must show `canPress: true` on menu bar items and buttons. If not, attach the raw outline dump so the capability matrix can be inspected.

## Local constraints

- Local child process only; no service, socket, or network listener.
- Helper path: `%USERPROFILE%\.pi\agent\helpers\pi-computer-use\windows-bridge.exe`.
- UIAccess/elevated-window limitations are reported as errors; there is no interactive permission grant loop.
