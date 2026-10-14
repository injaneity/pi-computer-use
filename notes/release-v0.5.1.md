Windows helper packaging verification and release reliability.

## Features

- Added npm package verification for macOS, Windows, and Linux native helpers before publication.

## Changelog

- prevented releases from publishing when the Windows helper is absent from the npm tarball.
- updated the development lockfile for the latest Pi dependency version.

> "A release should verify the files it ships."
