# v0.1.1 — stealth mode

## Patch notes

- Switched the runtime to a semantic-only AX-first surface: `screenshot`, `click`, `type_text`, `wait`
- Removed legacy pointer, keyboard, clipboard, and raw-event fallback paths from the public/runtime surface
- Enforced background-safe behavior: no foreground activation, no cursor takeover, and no keyboard-focus stealing during validated flows
- Improved AX target discovery with ranked candidates, confidence reporting, and better window-target diagnostics
- Expanded strict QA coverage across Finder, TextEdit, Safari, Reminders, Notes, Calendar, and Chrome
