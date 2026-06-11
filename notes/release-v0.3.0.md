Optional CDP acceleration and codebase cleanup release.

## Features

- Optional Chrome DevTools Protocol backend for Chromium-family browsers: set `PI_COMPUTER_USE_CDP_PORT` to a browser's `--remote-debugging-port` to get event-driven `navigate_browser` and browser console output piggybacked on tool results, with no change to the tool surface.

## Changelog

- Added the opt-in CDP backend with window-aware tab matching and console/exception capture.
- Hardened native bridge safeguards and tightened CDP and input guard cleanup.
- Removed the orphaned isolated-browser-window bootstrap path and dead activation plumbing from the bridge, and collapsed duplicated tool executor layers (~500 lines removed with no behavior change).
- Fixed the published package image path, which still pointed at `assets/img.jpg` after the file moved to `assets/reference/`.
- Untracked a committed local session transcript and cleaned up stale `.gitignore` entries.
- Aligned docs and tool prompt guidelines with the removed browser bootstrap behavior.

> "He felt that his whole life was some kind of dream and he sometimes wondered whose it was and whether they were enjoying it."
