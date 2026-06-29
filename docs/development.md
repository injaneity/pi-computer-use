# Development

This guide covers local setup, helper builds, validation, and release notes for contributors.

## Requirements

- macOS for native helper development and computer-use QA.
- Node.js `>=20.6.0`.
- Xcode command line tools for native helper builds.
- Pi for extension testing.

## Local Setup

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
```

Run this checkout in Pi without loading another installed copy:

```bash
pi --no-extensions -e .
```

## Helper Install Path

The runtime helper lives in the app bundle:

```text
~/.pi/agent/helpers/pi-computer-use/PiComputerUseBridge.app
```

The helper app needs:

- Accessibility
- Screen Recording / Screen & System Audio Recording

If permissions are missing, start Pi interactively and let the extension guide setup.

## Helper Builds

Build for the current architecture into the repo prebuilt path:

```bash
npm run build:native
```

Build the repo prebuilt, then install/sign the helper app:

```bash
npm run build:native
node scripts/setup-helper.mjs --force
```

Use `modern` for macOS 14+ ScreenCaptureKit support, or `legacy` for the macOS 12+ CGWindow/screencapture helper when building release prebuilts.

Build both release prebuilts for both helper variants:

```bash
node scripts/build-native.mjs --arch all --variant all
```

Release prebuilt helpers live at:

```text
prebuilt/macos/arm64/modern/bridge
prebuilt/macos/arm64/legacy/bridge
prebuilt/macos/x64/modern/bridge
prebuilt/macos/x64/legacy/bridge
```

`setup-helper.mjs` selects `modern` on macOS 14+ and `legacy` on macOS 12/13, installs the selected binary inside `PiComputerUseBridge.app`, signs the app bundle, and removes the old standalone `bridge` helper from v0.3.2 and earlier.

Local helper builds are ad-hoc codesigned by default. For release builds, use a Developer ID Application certificate:

```bash
node scripts/build-native.mjs --arch all --variant all \
  --sign-identity "Developer ID Application: Your Team (TEAMID)" \
  --hardened-runtime \
  --timestamp
```

The default signing identifier is:

```text
com.injaneity.pi-computer-use.bridge
```

Keep that identifier stable for release builds so macOS permissions remain tied to `PiComputerUseBridge.app` across updates.

## Validation

For TypeScript and schema checks:

```bash
npm test
```

For documentation-only changes, proofreading markdown and checking touched links is usually enough.

## Benchmarks

Use benchmark output when changing semantic target ranking, fallback policy, AX execution, browser handling, native helper behavior, permission/setup behavior, or payload efficiency.

The QA benchmark is a local Pi-extension harness, not a clone of CUAbench.ai/OSWorld/WebArena. It borrows their principles—task diversity, reset/cleanup, action efficiency, and regression checks—while measuring package-specific behavior: compact semantic AX results, selective image fallback, AX execution, latency, payload size, and optional CDP behavior.

Default benchmark, non-intrusive aside from inspecting already-running visible apps:

```bash
npm run benchmark:qa
```

Wider coverage that may open apps. TextEdit/Finder artifacts created by the harness are cleaned up by default:

```bash
npm run benchmark:qa:full
```

Browser tab/address-bar navigation is skipped by default. Run it only when you are okay with the active browser tab/window changing:

```bash
npx -y tsx benchmarks/qa.ts --allow-foreground-qa --allow-browser-navigation
```

Keep temporary benchmark windows/documents for debugging:

```bash
npx -y tsx benchmarks/qa.ts --allow-foreground-qa --allow-screen-takeover --leave-artifacts
```

Save and compare local results:

```bash
npx -y tsx benchmarks/qa.ts --allow-foreground-qa --output benchmarks/results/baseline.local.json
npx -y tsx benchmarks/qa.ts --allow-foreground-qa --baseline benchmarks/results/baseline.local.json --output benchmarks/results/current.local.json
```

For the CDP backend only (self-contained; launches a headless Chrome, needs no macOS permissions, and is also included in `benchmark:qa` runs under a separate `cdp` category):

```bash
npm run benchmark:cdp
```

Important metrics include AX-only ratio, vision fallback ratio, semantic coverage, AX execution ratio, latency, executed app/category/tool counts, and payload proxies (`avgTextChars`, `avgImageBytes`, `avgContentJsonBytes`, `avgDetailsJsonBytes`, `avgPayloadBytes`). In `benchmarkSchemaVersion: 2`, payload bytes are serialized `content` JSON plus serialized `details` JSON, not just text length.

Current goals and regression tolerances live in `benchmarks/config.json`.

## Pull Requests

Before opening a PR:

1. Open an issue.
2. Get approval or alignment in the issue.
3. Keep the change scoped.
4. Include validation results.
5. Attach the AI transcript if AI tools helped produce the PR.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the project contribution policy.
