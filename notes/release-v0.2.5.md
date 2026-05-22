macOS 12 compatibility release for the native helper.

## Changelog

- Added separate native helper variants: a macOS 14+ modern helper with ScreenCaptureKit and a macOS 12+ legacy helper using CGWindow/screencapture capture paths.
- Updated helper setup to select the appropriate helper variant automatically by macOS version, with `PI_COMPUTER_USE_HELPER_VARIANT=modern|legacy|auto` for troubleshooting.
- Rebuilt and packaged variant-specific arm64 and x64 helper prebuilts.
- Removed the bundled `computer-use` skill so model behavior is driven by tool descriptions, schemas, and helper feedback rather than packaged skill instructions.
- Updated helper build and development docs for variant builds.

> “The knack lies in learning how to throw yourself at the ground and miss.”
