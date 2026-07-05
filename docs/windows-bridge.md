# Windows Bridge

`windows-bridge.exe` is the native helper for the root-forest Windows backend. It is spawned by the TypeScript helper client and speaks stdin/stdout JSON-lines protocol version **2**.

## Backend contract

The TypeScript Windows backend is intentionally stateless. It forwards root-forest seam calls to the Rust helper:

- `listRoots({ pid? })`: cheap HWND metadata only. HWNDs are the pairing source of truth, so roots report `pairing: { confidence: "exact", score: 100 }`.
- `look`: atomic observe result with `lookId`, outline, window payload (`rootRef`, `kind`, frame, scale), and optional image. Menu/outline-only roots omit `image`; coordinate acts against those roots fail with `coordinate_unavailable_for_root`.
- `act`: forwards the typed `PlatformActRequest` whole. The helper validates `lookId`, resolves refs from helper-owned look state, applies policy (`ax_only` blocks raw/coordinate input), executes, and returns outcome/evidence plus `performed.deltaSource` and shallow `rootDelta`.
- `uiaReadText` / `uiaWaitFor`: helper-side text access/waiting. No TypeScript screenshot polling or module-level element state is used.

## Root metadata

Windows roots are top-level HWNDs:

- `#32768` class => `kind: "menu"`
- `#32770` class => `kind: "dialog"`
- owned popups => `kind: "popover"`
- other HWNDs => `kind: "window"`

The helper declares per-monitor-v2 DPI awareness at startup and reports `scaleFactor = GetDpiForWindow(hwnd) / 96`.

## Actions and deltas

Implemented action path:

- `press`/`click`: resolved UIA ref center or image coordinate, then `SendInput` click fallback.
- `setText`: text input fallback with value evidence.
- `typeText`/`keypress`: `SendInput`; blocked under `ax_only`.
- `scroll`, `drag`, `moveMouse`: `SendInput`/cursor APIs; coordinate usage blocked under `ax_only` where applicable.

Root deltas are currently snapshot-diffed after a bounded helper-side settle, with `performed.deltaSource: "snapshot"`.

## Protocol

Request envelope:

```json
{ "protocolVersion": 2, "id": "req_1", "cmd": "listRoots", "args": {} }
```

Response envelope:

```json
{ "protocolVersion": 2, "id": "req_1", "ok": true, "result": { } }
```

Diagnostics (`cmd: "diagnostics"`) returns the protocol version and helper process metadata. The TypeScript backend rejects a mismatched version with a “Restart Pi …” error.

## Local constraints

- Local child process only; no service, socket, or network listener.
- Helper path: `%USERPROFILE%\.pi\agent\helpers\pi-computer-use\windows-bridge.exe`.
- UIAccess/elevated-window limitations are reported as errors; there is no interactive permission grant loop.
