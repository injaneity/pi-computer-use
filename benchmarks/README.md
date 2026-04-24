# Official QA benchmark

This directory contains the contributor-facing benchmark harness for `pi-computer-use`.

Use it before and after changes that affect semantic targeting, image fallback policy, AX execution, browser handling, or native helper behavior.

## What it measures

The benchmark answers four questions:

1. **AX-only efficacy**
   - navigation efficacy: can `screenshot`/`wait` return semantic AX state without vision fallback?
   - targeting efficacy: can `click(ref=@eN)` succeed through AX without fallback?
2. **Overall efficiency**
   - AX-only ratio
   - vision-fallback ratio
   - AX execution ratio
3. **Latency**
   - overall average latency
   - navigation latency
   - targeting latency
4. **Coverage**
   - baseline/frontmost
   - native apps (`TextEdit`, `Finder`, `Reminders`)
   - browsers (`Safari`, `Chrome`, `Firefox`, `Helium`, etc. when available)
   - expanded TextEdit action surface (`set_text`, raw keyboard/pointer primitives, and `computer_actions`)

## Commands

Run the interactive but non-intrusive default:

```bash
npx -y tsx benchmarks/qa.ts --allow-foreground-qa
```

Allow the harness to open apps for wider coverage:

```bash
npx -y tsx benchmarks/qa.ts --allow-foreground-qa --allow-screen-takeover
```

Save a result file:

```bash
npx -y tsx benchmarks/qa.ts --allow-foreground-qa --output benchmarks/results/latest.json
```

Compare against a saved baseline and fail on regression:

```bash
npx -y tsx benchmarks/qa.ts \
  --allow-foreground-qa \
  --allow-screen-takeover \
  --baseline benchmarks/results/baseline.json \
  --output benchmarks/results/current.json
```

## Result format

The benchmark prints a JSON report containing:

- environment metadata
- aggregate metrics
- optional baseline comparison
- per-case records

Important metrics:

- `axOnlyRatio`
- `coreAxOnlyRatio`
- `visionFallbackRatio`
- `coreVisionFallbackRatio`
- `axExecutionRatio`
- `stealthCompatibleRatio`
- `navigationAxOnlyRatio`
- `targetingAxOnlyRatio`
- `primitivePassRatio`
- `batchPassRatio`
- `capabilityPassRatio`
- `capabilityStealthRatio`
- `avgLatencyMs`
- `avgNavigationLatencyMs`
- `avgTargetingLatencyMs`
- `avgPrimitiveLatencyMs`
- `avgBatchLatencyMs`

`core*` metrics exclude frontier capability probes so experimental coverage does not hide regressions in the main user path.

`axExecutionRatio` and `targetingAxOnlyRatio` intentionally track AX-first targeting actions (`click` and `set_text`). Raw primitives such as `keypress`, `drag`, and `scroll` are measured separately so improved primitive coverage does not hide AX-first targeting regressions.

Current benchmark goals are defined in `benchmarks/config.json`:

- `coreAxOnlyRatio >= 0.8`
- `avgLatencyMs <= 7500`
- `avgTargetingLatencyMs <= 4000`

## Regression policy

Regression tolerances live in:

```text
benchmarks/config.json
```

When `--baseline` is provided, the benchmark compares current results against the baseline and exits non-zero if any configured metric regresses beyond tolerance.

## Results directory

Store committed or local benchmark artifacts under:

```text
benchmarks/results/
```

The repository includes `benchmarks/results/.gitkeep` so contributors have a stable location for baselines and comparison outputs.

Suggested local workflow:

```bash
npx -y tsx benchmarks/qa.ts \
  --allow-foreground-qa \
  --output benchmarks/results/baseline.local.json

npx -y tsx benchmarks/qa.ts \
  --allow-foreground-qa \
  --baseline benchmarks/results/baseline.local.json \
  --output benchmarks/results/current.local.json
```

## Contributor workflow

1. Run the benchmark and save a baseline.
2. Make your change.
3. Re-run the benchmark with `--baseline`.
4. Only claim improvement if the benchmark shows it.

This benchmark should be treated as the official gate for semantic-targeting changes, fallback-policy changes, and AX-vs-vision efficiency claims.

For documentation-only changes, running this benchmark is usually not necessary.
