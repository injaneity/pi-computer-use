# Contributing

Thanks for helping improve `pi-computer-use`.

## Start with an issue

Please open an issue before starting work.

- Every pull request needs an associated issue.
- The issue should be approved before a PR is opened.
- Use the issue to agree on scope, validation, and any user-facing behavior changes.

## Setup

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
```

Run this checkout in Pi:

```bash
pi --no-extensions -e .
```

If you change the native helper, rebuild it and make sure macOS grants Accessibility and Screen Recording permissions to:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

For more detail, see [docs/development.md](./docs/development.md) and [docs/troubleshooting.md](./docs/troubleshooting.md).

## Validation

- Documentation-only changes: proofread the changed files and check any links or commands you touched.
- TypeScript/tooling changes: run `npm test`.
- GUI, browser, AX, fallback, or native-helper changes: run `npm run benchmark:qa` and include the result in the PR.
- Broader behavior changes may also need `npm run benchmark:qa:full`.

## Commit messages

Use this format:

```text
feat|chore|refactor|fix(<scope>): <summary>
```

Examples:

```text
feat(browser): add direct navigation tool
fix(readme): correct install tag syntax
refactor(bridge): prefer native window refs
chore(release): prepare release notes
```

Check a range locally with:

```bash
npm run test:commits -- <base>..<head>
```

## Pull request checklist

- Link the approved issue.
- Explain the user-facing change briefly.
- Note any permission, browser, or strict AX impact.
- Include benchmark results for behavior changes.
- Keep unrelated formatting and generated output out of the PR.

## If you used AI

If AI tools helped produce the PR, include the thread or transcript so reviewers can see the context behind the change.

## Releases

Release notes use [`notes/release-template.md`](./notes/release-template.md). Releases are handled by maintainers.
