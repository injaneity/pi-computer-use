# Unified pi-computer-use benchmark

Date: 2026-04-29T07:26:31.536Z
Status: **FAIL**

## Direct tool/helper QA
- executed/passed: 17/17
- core AX-only ratio: 0.25
- avg latency: 438ms
- goals: FAIL

## Model-driven evals
- pass rate: 95.8% (46/48)
- overall cost: $1.300614

| model | pass | avg latency | total cost | avg cost |
|---|---:|---:|---:|---:|
| gpt-5.4-mini:off | 100.0% (6/6) | 16061ms | $0.071581 | $0.011930 |
| gpt-5.4-mini:low | 100.0% (6/6) | 16303ms | $0.070576 | $0.011763 |
| gpt-5.4-mini:minimal | 100.0% (6/6) | 16549ms | $0.069267 | $0.011544 |
| gpt-5.3-codex:low | 100.0% (6/6) | 21390ms | $0.168034 | $0.028006 |
| gpt-5.4-mini:high | 100.0% (6/6) | 21853ms | $0.099043 | $0.016507 |
| gpt-5.4-mini:medium | 100.0% (6/6) | 25005ms | $0.075059 | $0.012510 |
| gpt-5.5:off | 83.3% (5/6) | 28490ms | $0.620040 | $0.103340 |
| gpt-5.3-codex:off | 83.3% (5/6) | 42224ms | $0.127015 | $0.021169 |

Artifacts: benchmarks/results/unified-codex-models
