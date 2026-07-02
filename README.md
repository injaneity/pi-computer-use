# pi-computer-use

<p align="center">
  <img src="./assets/logo/logo3.png" width="50%" alt="pi-computer-use">
</p>

`pi-computer-use` is a macOS extension for Pi that lets an agent inspect and control desktop windows through a compact UI scene model.

The extension uses macOS Accessibility as the semantic backbone, native window capture for coordinate mapping, and optional visual evidence when AX data is not enough. The public tool surface is intentionally small:

- `observe`
- `search_ui`
- `expand_ui`
- `inspect_ui`
- `act`

Discovery, browser, text, and wait utilities are also available.

## Install

```bash
pi install git:github.com/injaneity/pi-computer-use@v0.3.3
```

Start Pi and grant permissions to:

```text
/Applications/pi-computer-use.app
```

Required macOS permissions:

- Accessibility
- Screen Recording, shown as Screen and System Audio Recording on newer macOS versions

Use `/computer-use` inside Pi to show the active configuration and where it came from.

## Basic flow

```ts
list_windows({ app: "TextEdit" })
observe({ window: "@w1", mode: "fused" })
search_ui({ text: "Save", action: "press" })
act({ ref: "@t1", action: "press", stateId: "..." })
```

Prefer scene refs from `observe` and `search_ui`:

- `@tN` is a scene target backed by AX and, when available, visual evidence.
- `@uN` is an unknown visible region that AX did not explain.
- `@eN` is a raw AX ref.
- `@vN` is a raw visual text ref.

## Documentation

- [Usage](./docs/usage.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Development](./docs/development.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Contributing](./CONTRIBUTING.md)

## Development status

The current architecture is scene-first. Older direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` are no longer part of the public extension surface. Use `observe` and `act` instead.

Behavioral benchmarking should use `cubench` against the registered extension tools.

## License

MIT
