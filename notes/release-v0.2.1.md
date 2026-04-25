# v0.2.1 — the window update

## Changelog

### App and window discovery

- Added `list_apps()` so agents can inspect running apps before choosing a target.
- Added `list_windows({ app | bundleId | pid })` so agents can inspect controllable windows, titles, ids, geometry, and focus/visibility flags.
- `list_windows` now returns model-facing window refs such as `@w1`.
- Window discovery results include enough context for the model to choose the intended target without guessing from partial titles.

### Explicit window targeting

- `screenshot` now accepts explicit window targets:
  - `screenshot({ window: "@w1" })`
  - `screenshot({ window: 12345 })`
- Action tools now accept the same optional `window` selector, for example:
  - `click({ window: "@w1", ref: "@e1" })`
  - `keypress({ window: "@w1", keys: ["Enter"] })`
- Batched actions can be scoped to a top-level `window`, and per-action window mismatches are rejected with clear guidance.
- Tool results now include `target.windowRef` where available.

### State safety and stale-target guidance

- Replaced the public `captureId` field with `stateId`.
- Action tools that depend on the latest inspected state now accept `stateId` for stale-state validation.
- Tool result details now expose `capture.stateId` instead of `capture.captureId`.
- Stale state errors now point the model toward refreshing the correct window, e.g. `screenshot({ window: "@w1" })`.
- Stale AX-ref errors now explain that refs are scoped to the latest state and should be refreshed with `screenshot`.

### Window layout and visual control

- Added `arrange_window` for deterministic layouts before interaction.
- `arrange_window` supports presets:
  - `center_large`
  - `left_half`
  - `right_half`
  - `top_half`
  - `bottom_half`
- `arrange_window` also supports explicit frames with `x`, `y`, `width`, and `height` in screen points.
- Added native helper support for setting a target window frame through Accessibility.
- Added screenshot attachment control through `image: "auto" | "always" | "never"`.

### Multi-agent and multi-window safety groundwork

- Added per-window write queues so writes targeting the same window are serialized internally.
- This reduces the chance of conflicting writes when multiple flows target the same `@w` ref.
- Current Pi execution still keeps a global runtime lock around helper readiness/shared state, so this is groundwork rather than full parallel multi-window execution.

### Scroll diagnostics and recovery

- Scroll failures now preserve the best available AX failure reason.
- Strict AX scroll failures include the AX reason when one is available.
- Coordinate fallback errors now provide clearer recovery guidance when an AX scroll path is unavailable.

### Docs, benchmark, and cleanup

- Updated README, usage docs, troubleshooting docs, and the computer-use skill for the new discovery/window/state workflow.
- Updated the benchmark harness to use `stateId` instead of the removed `captureId` field.
- Removed stale public `captureId` schemas and examples.
- Bumped package version to `0.2.1`.

## Validation snapshot

Default benchmark:

```json
{
  "executed": 9,
  "passed": 9,
  "failed": 0,
  "coreAxOnlyRatio": 1,
  "coreVisionFallbackRatio": 0,
  "axExecutionRatio": 1,
  "stealthCompatibleRatio": 1,
  "avgLatencyMs": 442,
  "avgNavigationLatencyMs": 519,
  "avgTargetingLatencyMs": 288,
  "batchPassRatio": 1
}
```

Configured benchmark gates passed:

```text
coreAxOnlyRatio       1 >= 0.8
avgLatencyMs          442ms <= 7500ms
avgTargetingLatencyMs 288ms <= 4000ms
```

Notable cases:

```text
Finder-targeting            PASS  variant=stealth stealthCompatible=true
Reminders-targeting         PASS  variant=stealth stealthCompatible=true
Helium-targeting            PASS  variant=stealth stealthCompatible=true
Helium-sota-address-ax      PASS  variant=stealth stealthCompatible=true
```

## Known follow-ups

- Per-window write queues are in place, but Pi tool execution still uses a global runtime lock around helper readiness and shared state. A future release can split read-only discovery/screenshot paths from write paths to unlock more true parallel multi-window execution.
- `image` mode is currently stored in runtime state during a tool call. This is safe with current sequential execution, but should become strictly per-call state before relaxing the global runtime lock.
- AX scroll and AX adjustment are implemented, but the current local benchmark app matrix did not expose suitable scroll/adjust refs during validation.
