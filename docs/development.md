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
