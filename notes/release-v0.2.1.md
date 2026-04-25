# v0.2.1 — Window Stability Release

v0.2.1 focuses on model usability, multi-window targeting, state safety, and deterministic layouts while keeping the AX-first workflow fast.

## Added

- `list_apps` for running app discovery.
- `list_windows` for controllable window discovery with stable model-facing refs such as `@w1`.
- Explicit `window` targeting on `screenshot` and action tools.
- `stateId` for stale-state validation.
- `arrange_window` for deterministic layouts using presets or explicit frames.
- `image: "auto" | "always" | "never"` for screenshot attachment control.
- Per-window write serialization foundation for safer multi-agent/multi-window workflows.
- Clearer stale state, stale ref, stale window, and scroll failure guidance.

## Changed

- Removed the public `captureId` parameter/result field in favor of `stateId`.
- Updated docs and examples to use `stateId` exclusively.
- Native helper now supports setting target window frames through Accessibility.

## Benchmark

The default QA benchmark passed after the changes:

- Failed cases: `0`
- Core AX-only ratio stayed above the configured target.
- Average and targeting latency stayed well under benchmark limits.

## Known follow-ups

- Per-window write queues are in place, but Pi tool execution still uses a global runtime lock around helper readiness and shared state. A future release can split read-only discovery/screenshot paths from write paths to unlock more true parallel multi-window execution.
- `image` mode is currently stored in runtime state during a tool call. This is safe with current sequential execution, but should become strictly per-call state before relaxing the global runtime lock.
