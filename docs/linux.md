# Linux support

Linux uses the same root/state/ref navigation architecture as macOS and Windows. Its per-user Rust helper uses AT-SPI2 semantics first. In an X11 session it can enrich those semantics with EWMH window state, X11 capture, and guarded XTEST physical input.

## Setup

Run Pi as the same user and inside the same graphical session as the target applications. The session needs a working D-Bus and AT-SPI2 accessibility bus, and applications must export useful accessibility interfaces. A normal install places the helper at:

```text
~/.pi/agent/helpers/pi-computer-use/linux-bridge
```

The upstream [AT-SPI development guide](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/index.html) describes the accessibility stack. Containers, system services, `sudo`, and unrelated SSH sessions do not automatically inherit the graphical user's bus.

## Capability matrix

| Capability | X11 | Wayland | Delivery |
| --- | --- | --- | --- |
| Discover accessible roots | Yes; EWMH enriches geometry, stacking, focus, and minimized state | Yes, when exported | AT-SPI2, plus EWMH on X11 |
| Press/click an actionable ref | Capability-gated | Capability-gated | AT-SPI `Action` |
| Replace editable text | Capability-gated | Capability-gated | AT-SPI `EditableText` |
| Read/wait on accessible text | Capability-gated | Capability-gated | AT-SPI `Text`/snapshots |
| Screenshot/visual observation | Yes | No | XComposite PNG; `GetImage` fallback may be stale or obscured |
| Coordinate pointer, keyboard, scroll, and drag | Non-headless only | No | XTEST after semantic delivery is unavailable/insufficient |
| Force focus | Non-headless only | No | EWMH `_NET_ACTIVE_WINDOW` |
| Managed Chromium pages | Yes | Yes | Loopback CDP |
| Open a URL | Yes | Yes | `xdg-open` |

“Capability-gated” means the target must export the corresponding AT-SPI interface. X11 physical fallback reports an `unknown` outcome unless later observation or a postcondition verifies the result. Capture prefers XComposite so covered windows can still be read; the `GetImage` fallback explicitly warns that pixels may be stale or obscured.

## Background and headless guarantees

Linux always attempts AT-SPI semantics first. Semantic delivery does not request compositor focus or inject global input; background delivery is not invisible execution, because an application may still update its visible window.

With `headless: true` or the `ax_only`/`background` delivery policy, the helper never invokes XTEST or EWMH focus. Unsupported semantic input fails closed. With non-headless `default` or `foreground` policy on X11, actions may fall back to global XTEST input and focus may use EWMH. Those operations can move the real pointer, type into the focused application, and interfere with the user's session. Native Wayland has no such physical fallback.

Managed CDP actions also avoid desktop focus, but `launch_browser` starts a normal visible browser; this project's `headless` option is an input-delivery policy, not Chromium's `--headless` switch.

## Wayland portal boundary

The standardized [ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) can expose user-selected streams through PipeWire. The [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) can negotiate input devices and may return restore tokens when the desktop grants persistence. Starting a session normally invokes compositor-owned selection/consent, and backend support varies.

On Wayland, diagnostics performs only a read-only property probe and reports the RemoteDesktop and ScreenCast interface versions plus advertised device, source, and cursor-mode bitmasks. It does not create a portal request or session and cannot display a chooser.

The native module contains dormant session plumbing, but interactive portal use is not enabled: no runtime command starts a session, decodes PipeWire frames, dispatches portal input, or persists restore tokens. Installing a portal backend therefore does not enable Wayland capture or input.

## Security boundaries

- The helper is a local stdin/stdout child process and opens no helper network listener.
- It can inspect applications exposed on the current user's AT-SPI bus; run only trusted agents and extensions in that session.
- Password-role values are omitted and explicit reads are rejected, though application mislabeling remains possible.
- On X11, capture can read window pixels and non-headless physical fallback can control the global pointer/keyboard and request focus. These are broad desktop capabilities; strict headless/background policy blocks XTEST and focus, but does not make AT-SPI or requested X11 observation private.
- On Wayland, portal plumbing does not yet decode frames or deliver actions. Portal session creation would be explicit and potentially interactive, not an automatic background escalation.
- CDP is separate and gives local processes that can reach its loopback port powerful page access. `launch_browser` uses a fresh non-default temporary profile, matching modern Chrome's [remote-debugging security policy](https://developer.chrome.com/blog/remote-debugging-port), rather than the user's normal profile.

## Browser discovery

`launch_browser` searches common Chrome/Chromium or Helium locations and `PATH`. For an AppImage or custom install, set an authoritative executable override:

```bash
PI_COMPUTER_USE_CHROME_EXECUTABLE=/absolute/path/to/chrome
PI_COMPUTER_USE_HELIUM_EXECUTABLE=/absolute/path/to/helium.AppImage
```

Manual CDP launches must use a non-default `--user-data-dir` together with `--remote-debugging-port`; set `PI_COMPUTER_USE_CDP_PORT` to that loopback port.
