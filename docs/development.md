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

The runtime helper lives at:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

The helper needs:

- Accessibility
- Screen Recording

If permissions are missing, start Pi interactively and let the extension guide setup.

## Helper Builds

Build for the current architecture into the repo prebuilt path:

```bash
npm run build:native
```

Build directly to the installed helper path:

```bash
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

Build both release prebuilts:

```bash
node scripts/build-native.mjs --arch all
```

Local helper builds are ad-hoc codesigned by default. For release builds, use a Developer ID Application certificate:

```bash
node scripts/build-native.mjs --arch all \
  --sign-identity "Developer ID Application: Your Team (TEAMID)" \
  --hardened-runtime \
  --timestamp
```

The default signing identifier is:

```text
com.injaneity.pi-computer-use.bridge
```

Keep that identifier stable for release builds so macOS permissions remain tied to the same helper identity across updates.

## Validation

For TypeScript and schema checks:

```bash
npm test
```

For behavior changes, run the QA benchmark:

```bash
npm run benchmark:qa
```

For wider coverage that may open apps:

```bash
npm run benchmark:qa:full
```

Use benchmark output when changing:

- semantic target ranking
- fallback policy
- AX execution
- browser handling
- native helper behavior
- permission/setup behavior

For documentation-only changes, proofreading markdown and checking touched links is usually enough.

## Pull Requests

Before opening a PR:

1. Open an issue.
2. Get approval or alignment in the issue.
3. Keep the change scoped.
4. Include validation results.
5. Attach the AI transcript if AI tools helped produce the PR.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the project contribution policy.
