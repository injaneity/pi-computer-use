# Development

## Repository layout

```text
extensions/computer-use.ts       Public Pi tool registration
src/bridge.ts                    TypeScript runtime and scene model
native/macos/bridge.swift        macOS helper for AX, capture, and input
scripts/build-native.mjs         Native helper build script
scripts/setup-helper.mjs         Helper install script
```

The public tool surface lives in `extensions/computer-use.ts`. Keep it small. Internal complexity belongs in `src/bridge.ts` and the native helper.

## Checks

Run TypeScript and tool-schema checks:

```bash
npm test
```

Rebuild the native helper after Swift changes:

```bash
npm run build:native
```

## Architecture notes

The runtime is scene-first:

- macOS AX provides the semantic tree backbone
- native visible-child attributes help filter visibility
- capture metadata maps AX screen points into screenshot pixels
- visual text becomes evidence, not the source of truth
- `@t` scene refs are preferred for actions
- `@u` refs represent visible regions not explained by AX

The extension registers a small public API:

```text
observe
search_ui
expand_ui
inspect_ui
act
```

Discovery, browser, text, and wait utilities are also registered. Do not add direct public action tools unless the architecture changes.

## Benchmarks

Use `cubench` for behavior validation. It should exercise the registered extension tools rather than importing bridge internals.

Recommended flow:

```bash
cubench
cubench --output results/cubench-baseline.local.json
cubench --baseline results/cubench-baseline.local.json --output results/cubench-current.local.json
```

Run cubench for changes to AX traversal, scene association, visual grounding, browser handling, permissions, setup, or payload size.

## Native helper

The helper installed for permissions is:

```text
/Applications/pi-computer-use.app
```

The built helper binary is stored under `prebuilt/macos` and installed by `scripts/setup-helper.mjs`.

## Release signing

TCC keys permission grants to the app's code-signing *designated
requirement*. An ad-hoc signature pins that to the exact binary hash
(cdhash), so an ad-hoc release orphans every user's grants on update. Any
real certificate — Developer ID **or a stable self-signed cert** — anchors
the requirement on `identifier + certificate leaf`, so grants survive all
releases as long as you sign every release with the same cert. (Verified:
two different binaries signed with one cert produce an identical designated
requirement.)

You do NOT need an Apple Developer Program membership for grant stability.
Apple enrollment (Developer ID + notarization) is only required to clear
Gatekeeper on **browser-downloaded** apps; npm-delivered installs carry no
quarantine attribute, so a self-signed cert is sufficient.

Setup:

1. Run `./scripts/make-signing-cert.sh` once to generate a 10-year
   self-signed cert (`id.p12`). Back up `key.pem`/`cert.pem` permanently —
   losing them forces a one-time re-grant on the next release.
2. Add repository secrets `APPLICATION_CERT_BASE64` (base64 of `id.p12`),
   `CERT_PASSWORD`, and `SIGN_IDENTITY` (`pi-computer-use Self Signed`).
   For a Developer ID cert instead, set `SIGN_IDENTITY` to its full name,
   add the `NOTARIZE=true` repository variable, and the `TEAM_ID` /
   `APPLE_ID` / `APP_SPECIFIC_PASSWORD` secrets.
3. `.github/workflows/release-helper.yml` builds the universal
   `pi-computer-use.app` on tag push, signs it (hardened runtime), asserts
   the designated requirement anchors on the cert leaf (fails the release
   if it regressed to ad-hoc), notarizes+staples when `NOTARIZE=true`, and
   attaches the zip to the release.
4. Before `npm publish`, unzip that release asset into
   `prebuilt/macos/universal/modern/pi-computer-use.app`. The installer
   prefers it over per-arch bundles and loose binaries, verifies its
   signature, installs it verbatim with `ditto`, and never re-signs it.

Local dev builds stay ad-hoc; the installer's guard
(`PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`) covers that path.
