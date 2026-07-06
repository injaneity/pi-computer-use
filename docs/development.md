# Development

## Repository layout

```text
extensions/computer-use.ts       Public Pi tool registration
src/bridge.ts                    TypeScript runtime and tool implementation
src/outline.ts                   Outline parsing, folding, search, and ref mapping
src/note.ts                      Disposable running-note generation
native/macos/bridge.swift        macOS helper for AX, capture, permissions, and input
scripts/build-native.mjs         Native helper build script
scripts/setup-helper.mjs         Helper install script
scripts/check-invariants.mjs     Architecture invariant checks
```

The public tool surface lives in `extensions/computer-use.ts`. Keep it small. Internal complexity belongs in `src/bridge.ts`, `src/outline.ts`, `src/note.ts`, and the native helper.

## Checks

Run all static checks:

```bash
npm test
```

This runs TypeScript, tool-schema compatibility checks, architecture invariants, and Swift typechecking.

Rebuild the native helper after Swift changes:

```bash
npm run build:native
```

## Architecture rules

The runtime is outline-first:

- `observe_ui` returns a folded UI outline and running note.
- `search_ui`, `expand_ui`, and `inspect_ui` provide progressive disclosure.
- `act_ui` is the only public desktop action entrypoint.
- The helper owns grounding, preflight, execution, and verification.
- Removed direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` should not reappear as public extension tools.

Run invariants after architecture changes:

```bash
npm run test:invariants
```

Set `PI_CU_LIVE=1` only when you want live helper checks in addition to static checks.

## Benchmarks

`../cubench` is the behavioral benchmark for computer-use clients. This repo includes a Pi client for cubench-runner:

```bash
node ../cubench/bin/cubench-runner.mjs \
  --client ./bin/pi-cubench-client.mjs \
  --task finder.rename.basic \
  --seed 1 \
  --variants ax-clean
```

Use this regression matrix for platform-seam changes:

- `ax-clean`: semantic grounding through a good accessibility tree.
- `ax-readable-not-actionable`: readable accessibility content with action fallback pressure.
- `visual-only`: pure visual/coordinate grounding pressure.

`scripts/cubench.mjs` remains a local measurement harness for observation size, helper timing, image size, and bridge round trips.

```bash
node scripts/cubench.mjs
```

It writes:

```text
scripts/cubench-results.json
```

Use it for changes to accessibility traversal, outline folding, visual evidence, action refresh, browser handling, permissions, setup, or payload size.

## Native helper

The helper installed for permissions is:

```text
/Applications/pi-computer-use.app
```

Local development can use ad-hoc signing. Release builds must use the release workflow so the helper app is signed with the stable release certificate.

## Release signing

macOS TCC keys Accessibility and Screen Recording grants to an app's code-signing designated requirement. An ad-hoc signature pins that requirement to the exact binary hash, so updates can orphan existing grants. A stable certificate anchors the requirement on `identifier + certificate leaf`, allowing grants to survive future releases signed with the same certificate.

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

`.github/workflows/publish-npm.yml` builds the universal helper, signs it, optionally notarizes it, stages a draft GitHub Release, injects the same signed helper app into the npm package, publishes npm, and only then publishes the GitHub Release.
