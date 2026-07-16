# Contributing

Thanks for helping improve `pi-computer-use`.

## Before you start

Open an issue before starting work. Use it to agree on scope, validation, and any user-facing behavior changes.

## Setup

```bash
npm install
npm test
```

Run this checkout in Pi:

```bash
pi --no-extensions -e .
```

If you change native code, rebuild the helper:

```bash
npm run build:native
```

macOS permissions should be granted to:

```text
/Applications/pi-computer-use.app
```

## Validation

Use the smallest check that proves the change:

- Documentation changes: run `npm run docs:check`, proofread changed files, and check touched links or commands.
- TypeScript or schema changes: run `npm test`; if the public tool definition changed, run `npm run docs:generate` first.
- Native helper changes: run `npm run build:native` and `npm test`.
- Behavior changes: run `cubench` against the registered extension tools.

The in-repo legacy benchmark harness was removed because it targeted old direct action tools. Use `cubench` for behavioral validation.

## Commit messages

Use:

```text
feat|chore|refactor|fix(<scope>): <summary>
```

Examples:

```text
feat(scene): add label association
fix(config): document strict AX env vars
refactor(extension): simplify public tool surface
```

Check a range locally with:

```bash
npm run test:commits -- <base>..<head>
```

## Pull requests

A PR should include:

- the linked issue
- a short description of the user-facing change
- permission, browser, or strict AX impact if relevant
- validation results

Keep unrelated formatting out of the PR. Commit generated reference changes when their source definition changed so CI can verify that the two remain synchronized.

## AI-assisted work

If AI tools helped produce the PR, include the thread or transcript so reviewers can see the context.

## Releases

Release notes use [`notes/release-template.md`](./notes/release-template.md). Maintainers handle releases.
