# v0.1.7 — The Stealth Frontier Update

## User-facing value proposition

People of Pi: `pi-computer-use` remains ahead of Codex computer use. v0.1.7 adds Pi-only wins:
- AX-first `scroll`, `keypress`, and `drag`
- Safari/Chrome URL entry without raw Enter
- `/computer-use` browser + stealth config
- frontier AX benchmarks

## Changelog

### AX-first execution improvements

- Collapsed more Accessibility behavior into the existing tools, so agents keep using normal actions instead of choosing between AX-specific and coordinate/vision-specific tools.
- `scroll` now tries AX scrolling by ref or hit-tested point before falling back to pointer scrolling.
- `keypress` now tries semantic AX actions before raw keyboard input:
  - Enter/Return: AX confirm or press
  - Escape/Esc: AX cancel
  - Space/Spacebar: AX press
- `keypress` can now map Enter/Escape to likely default/cancel buttons in the current window when the focused element does not expose a semantic action.
- `drag` can now adjust AX controls that expose increment/decrement actions, while preserving pointer drag fallback in default mode.
- AX target hints now include additional capabilities such as `scroll` and `adjust`.

### Browser stealth improvements

- Browser address-field workflows now have an AX-first fast path using the normal tool sequence:
  - `keypress({ keys: ["Command+L"] })`
  - `type_text({ text })`
  - `keypress({ keys: ["Enter"] })`
- For Safari and Chromium-family browsers, the pending address is opened without raw Enter fallback when possible.
- Browser address SOTA benchmark cases now pass as stealth-compatible for Safari and Google Chrome in the local validation run.

### User-visible safety config

- Added simple user/project config files:
  - `~/.pi/agent/extensions/pi-computer-use.json`
  - `.pi/computer-use.json`
- Added `browser_use` config to allow or block browser control.
- Added `stealth_mode` config to require background-safe AX execution.
- Added `/computer-use` command to show effective config and config sources.
- Added environment overrides:
  - `PI_COMPUTER_USE_BROWSER_USE=0|1`
  - `PI_COMPUTER_USE_STEALTH_MODE=0|1`
  - `PI_COMPUTER_USE_STEALTH=1`
  - `PI_COMPUTER_USE_STRICT_AX=1`

### Robustness and diagnostics

- Added stale AX-ref recovery for `click(ref)`, `set_text(ref)`, and `scroll(ref)` using refreshed role/label/capability/position matching.
- Added structured image fallback reasons in tool result details, including fallback recovery, sparse AX coverage, unlabeled targets, duplicated labels, and browser wait verification.
- Shortened post-action settle delays for AX-only operations to make stealth mode more responsive.
- Tightened browser address pending-state handling so pending address text is scoped to the originating browser pid/window.

### Benchmark and QA

- Promoted `benchmarks/qa.ts` into a SOTA/Pareto-frontier benchmark rather than only a regression smoke test.
- Added frontier capability probes for:
  - AX scroll refs
  - AX adjustable refs
  - browser address AX workflows
- Split core regression gates from frontier capability metrics:
  - `coreAxOnlyRatio`
  - `coreVisionFallbackRatio`
  - `capabilityTotal`
  - `capabilityExecuted`
  - `capabilityPassRatio`
  - `capabilityStealthRatio`
- Strict browser bootstrap refusal is now treated as an expected skip, not a benchmark failure.
- Removed the legacy manual QA script so the benchmark is the single QA authority.

### Cleanup

- Removed stale native AX helper paths that were no longer called.
- Removed legacy manual QA script and README references to manual QA snapshots.

## Validation snapshot

Default benchmark:

```json
{
  "executed": 22,
  "passed": 22,
  "failed": 0,
  "coreAxOnlyRatio": 0.85,
  "coreVisionFallbackRatio": 0.15,
  "stealthCompatibleRatio": 0.682,
  "capabilityTotal": 12,
  "capabilityExecuted": 2,
  "capabilityPassRatio": 1,
  "capabilityStealthRatio": 1
}
```

Strict/stealth benchmark:

```json
{
  "executed": 10,
  "passed": 10,
  "failed": 0,
  "axOnlyRatio": 1,
  "coreAxOnlyRatio": 1,
  "visionFallbackRatio": 0,
  "coreVisionFallbackRatio": 0,
  "stealthCompatibleRatio": 1
}
```

Notable frontier cases:

```text
Safari-sota-address-ax         PASS  variant=stealth stealthCompatible=true
Google Chrome-sota-address-ax  PASS  variant=stealth stealthCompatible=true
```

## Known benchmark fixture gaps

- AX scroll and AX adjustment are implemented, but the current local app matrix did not expose suitable scroll/adjust refs during validation.
- A future native benchmark fixture should add deterministic scrollable, adjustable, and popup/menu controls.
