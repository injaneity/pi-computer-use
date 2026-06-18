Context-aware browser and desktop control release with leaner snapshots and stronger recovery tools.

## Features

- Context-first browser/desktop snapshots with explicit `browser_page` and `desktop_window` contexts, managed CDP browser launch, browser JavaScript evaluation, and browser-backed click/set_text/scroll/navigation.
- Source-classified macOS AX targets distinguish desktop AX, browser chrome AX, and web-content AX so chrome-only browser trees trigger recovery instead of looking like useful document content.
- Scoped desktop AX snapshots, paginated `read_text`, `wait_for`, action `responseMode: "confirmation"`, and reduced fallback screenshots improve token efficiency and recovery loops.

## Changelog

- added context discovery, CDP snapshots/actions, and managed browser contexts in `0811299`.
- added browser/web-content AX source classification and browser-chrome-only diagnostics in `9d4b54d`.
- added scoped AX tree snapshots and stronger model guidance for focused inspection in `0811299`.
- added paginated/cached text extraction for desktop AX and browser contexts in `b446664`.
- added compact AX text previews to prevent long target values from bloating tool results in `c8fa6f3`.
- added `wait_for` for desktop AX and browser-context condition polling in `97a764f`.
- added reduced automatic screenshot payloads with preserved coordinate scaling in `1435dd9`.
- fixed ScreenCaptureKit helper builds so the deprecated `CGWindowListCreateImage` fallback is not compiled into the modern helper in `644b473`.

> "Time is an illusion. Lunchtime doubly so."
