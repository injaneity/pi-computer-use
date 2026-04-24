# Contributing

Thanks for your interest in contributing.

## Project expectations

`pi-computer-use` is a macOS computer-use extension for Pi. Most meaningful changes affect user trust, permissions, GUI state, or native input behavior, so the project values small, well-scoped changes with clear validation.

Documentation-only changes are welcome when they make setup, install, local development, benchmarking, or contribution workflow easier to follow.

## Before you start

Please open an issue first.

- All pull requests must have an associated issue.
- That issue must be approved before you open a PR.

If you want to work on something, use the issue thread to discuss the change and get alignment before you start.

## Local setup

Install dependencies:

```bash
npm install
```

Run the local checkout in Pi without loading another installed copy:

```bash
pi --no-extensions -e .
```

Build the native helper into the installed helper path when you need to test helper changes:

```bash
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

The helper needs macOS Accessibility and Screen Recording permissions. Grant them to:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

## Validation

For documentation-only changes, proofread the changed markdown and check links or commands you touched.

For behavior changes, run the benchmark before and after your change:

```bash
npm run benchmark:qa
```

For wider coverage, including opening apps where available:

```bash
npm run benchmark:qa:full
```

If you are changing semantic targeting, AX behavior, fallback policy, browser handling, or native helper behavior, save benchmark output and compare against a baseline. See [benchmarks/README.md](./benchmarks/README.md).

## Pull request checklist

- Link the approved issue.
- Explain the user-facing change.
- Call out any permission, browser, or strict AX behavior impact.
- Include benchmark results for behavior changes.
- Keep unrelated formatting and generated output out of the PR.

## If you used AI

If AI tools were used to help produce the PR, attach the thread or transcript used to generate the change.

This should be included in the PR so reviewers can see the context that led to the proposed changes.
