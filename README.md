# pi-computer-use

<p align="center">
  <img src="./assets/logo/logo3.png" width="50%" alt="pi-computer-use">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@injaneity/pi-computer-use"><img alt="npm" src="https://img.shields.io/npm/v/@injaneity/pi-computer-use?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/github/license/injaneity/pi-computer-use?style=flat-square"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square">
  <a href="https://github.com/injaneity/pi-computer-use/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/injaneity/pi-computer-use/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/sponsors/injaneity"><img alt="Sponsor" src="https://img.shields.io/badge/Sponsor-injaneity-EA4AAA?style=flat-square&logo=githubsponsors"></a>
</p>

`pi-computer-use` is a macOS computer-use extension that lets [Pi](https://pi.dev/) inspect and control visible desktop windows with semantic context, including apps and Chromium browsers. Looking for contributors for bringing pi-computer-use to Linux & Windows - see how to contribute [here](./CONTRIBUTING.md). **AI usage must be disclosed for all contributions**.

## Getting Started

Install the extension from the latest release tag:

```bash
pi install git:github.com/injaneity/pi-computer-use@v0.3.2
```

Start Pi and grant macOS permissions when prompted. The helper that needs access is:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required permissions:

- Accessibility
- Screen Recording

Then ask Pi to use computer-use tools. A good first request is:

> Ask Pi what pi-computer-use can see on my screen and how it would interact with the current window.

Use `/computer-use` inside Pi to inspect the active configuration and where it came from.

## Features

- Semantic window inspection for macOS apps, with stable app, window, and UI-element references.
- Ref-first interaction for clicking, scrolling, text replacement, keyboard input, dragging, and waiting.
- Screenshot fallback when macOS Accessibility data is not enough.
- Browser-aware navigation and optional Chromium CDP acceleration.
- Batched actions for short GUI sequences that do not need intermediate inspection.
- Strict AX mode for workflows that should avoid raw pointer and keyboard fallback.
- Local benchmark and validation tools for changes that affect GUI behavior.

## Learn the Implementation with Pi

This repository is meant to be explored with Pi. From a local checkout, run Pi with this extension enabled and ask questions such as:

> Explain how pi-computer-use captures windows, chooses semantic refs, and falls back to screenshots.

Pi can read the extension, bridge, native helper, docs, and benchmark harness directly, then summarize the implementation for the area you are changing.

## Documentation

- [Usage](./docs/usage.md)
- [Configuration](./docs/configuration.md)
- [Development](./docs/development.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Contributing](./CONTRIBUTING.md): local setup, validation, and pull requests

## Sponsoring

If `pi-computer-use` is useful to you, please consider supporting development through [GitHub Sponsors](https://github.com/sponsors/injaneity). I'm still pursuing my full-time studies, so any help goes a long way! Thank you for supporting open source~

## License

MIT
