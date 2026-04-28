Direct browser navigation and more reliable browser/window automation.

## Features

- Added `navigate_browser` to open a URL or search string directly in a targeted browser window.

## Changelog

- Added `navigate_browser` tool registration, docs, skill guidance, and bridge execution in `0e0111d`.
- Fixed browser window targeting by using native window refs across AX, mouse, scroll, drag, arrange, and capture paths in `0e0111d`.
- Fixed browser navigation stability with direct AppleScript-backed location opening in `0e0111d`.
- Fixed browser Apple Events JavaScript failures by surfacing a model-readable “Allow JavaScript from Apple Events” hint in `c53ba0b`.
- Fixed README Pi install/remove tag syntax from `#v0.2.1` to `@v0.2.1` in `41df92d`.
- Chore release notes by removing the old v0.2.1 proposition section in `485ac98`.

> “Don’t Panic.”
