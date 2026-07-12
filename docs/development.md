# Development

## Repository layout

```text
extensions/computer-use.ts       Public Pi tool registration
src/bridge.ts                    TypeScript runtime and tool implementation
src/runtime.ts                   Immutable state store and resource scheduler
src/outline.ts                   Outline parsing, folding, search, and ref mapping
src/note.ts                      Disposable running-note generation
native/macos/bridge.swift        macOS helper for AX, capture, permissions, and input
native/windows/                 Windows backend/helper code when developing on Windows
scripts/build-native.mjs         macOS helper build script
scripts/setup-helper.mjs         macOS helper install script
scripts/check-invariants.mjs     Architecture invariant checks
scripts/check-runtime-concurrency.mjs Scheduler/state concurrency checks
```

The public tool surface lives in `extensions/computer-use.ts`. Keep it small. Internal complexity belongs in `src/bridge.ts`, `src/outline.ts`, `src/note.ts`, and the native helper.

## Checks

Run all static checks:

```bash
npm test
```

This runs TypeScript, tool-schema compatibility checks, architecture invariants, and native helper checks available on the current platform.

On macOS, rebuild the native helper after Swift changes:

```bash
npm run build:native
```

## Architecture rules

The runtime is state-scoped and outline-first:

- `observe_ui` returns a folded UI outline and running note.
- `search_ui`, `expand_ui`, and `inspect_ui` provide progressive disclosure.
- `act_ui` is the only public desktop action entrypoint.
- UI observations are immutable records; request-local hydration replaces global current state.
- Cached queries bypass scheduling; live work is ordered per physical resource.
- Browser pages and desktop surfaces share the `@r` root forest and `@e` outline contract.
- The helper owns grounding, preflight, execution, and verification.
- Removed direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` should not reappear as public extension tools.

Run invariants after architecture changes:

```bash
npm run test:invariants
```

Set `PI_CU_LIVE=1` only when you want live helper checks in addition to static checks.

## Native platform helpers

On macOS, the helper installed for permissions is:

```text
/Applications/pi-computer-use.app
```

The macOS helper targets macOS 14+ and uses ScreenCaptureKit. Local development can use ad-hoc signing. Release builds must use the release workflow so the helper app is signed with the stable release certificate.

On Windows, development uses the Windows platform backend/helper and the active desktop session rather than the macOS app bundle or TCC permission model.

## Release signing

This section applies to macOS releases. macOS TCC keys Accessibility and Screen Recording grants to an app's code-signing identity. Ad-hoc and locally self-signed development builds may require permission review whenever their native code changes. Only Developer ID-signed release bundles should be treated as having a stable update identity.

Release setup:

1. Run `./scripts/make-signing-cert.sh` once, or use a Developer ID Application certificate.
2. Add repository secrets:
   - `APPLICATION_CERT_BASE64`
   - `CERT_PASSWORD`
   - `SIGN_IDENTITY`
3. For Developer ID notarization, set repository variable `NOTARIZE=true` and add:
   - `TEAM_ID`
   - `APPLE_ID`
   - `APP_SPECIFIC_PASSWORD`
4. Push a `v*` tag or run the `Release` workflow manually.

For macOS, `.github/workflows/publish-npm.yml` builds the universal helper, signs it, optionally notarizes it, stages a draft GitHub Release, injects the same signed helper app into the npm package, publishes npm, and only then publishes the GitHub Release.
