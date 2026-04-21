# Strict AX E2E Plan

Goal: validate that the semantic-only AX runtime is usable for common background computer-use tasks.

## Strict mode setup

Run Pi with the semantic-only runtime and validate the public tool surface:
- `screenshot`
- `click`
- `type_text`
- `wait`

## Permission preconditions

Helper path:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required:
- Accessibility
- Screen Recording

## Success criteria

For each scenario:
- target app does not need to become frontmost unless macOS/app semantics force it
- execution metadata should use AX strategies (`ax_press`, `ax_set_value`)
- no non-AX fallback should be used

## App matrix

### 1. TextEdit

Scenarios:
- target TextEdit window with `screenshot(app="TextEdit")`
- click inside document body
- `type_text` inserts text via AX
- repeat on a new blank document

Expected:
- `click` => `ax_press` when possible
- `type_text` => `ax_set_value`

### 2. Finder

Scenarios:
- target Finder window
- single-click sidebar item or file row
- single-click search field
- `type_text` into search field

Expected:
- item/search focus should work with AX click path where possible
- search field text should use `ax_set_value`

### 3. Browser (Safari/Chrome)

Scenarios:
- target browser window
- click address bar / search box
- `type_text` into focused field
- click page buttons/links that expose AX press

Expected:
- address/search fields should support semantic typing frequently
- clickable controls with proper AX should support `ax_press`

### 4. Reminders

Scenarios:
- target Reminders window
- click list/sidebar item
- click reminder title/input field
- `type_text` into editable text field

Expected:
- editable fields use `ax_set_value`
- standard buttons/lists should allow semantic click where exposed

## Browser-specific E2E tasks

### Browser smoke test
- open browser manually
- navigate to a page with visible search or form controls
- ask Pi in strict mode to:
  1. screenshot browser
  2. click search/address field
  3. type text
  4. report execution metadata

### Browser form test
- use a page with standard HTML inputs/buttons
- validate:
  - field focus via `click`
  - text entry via `type_text`
  - button activation via `click`

## Known gaps to track

These are intentionally outside the semantic-only public surface:
- hover-only interactions
- literal dragging
- pointer-only affordances
- non-semantic scrolling
- arbitrary keyboard shortcuts
- double-click-specific file-open flows

## Next automation work

1. Keep strengthening `scripts/manual-qa.ts` around semantic-only invariants.
2. Add execution-metadata assertions per scenario.
3. Keep expanding app-specific smoke flows for:
   - TextEdit
   - Finder
   - Safari or Chrome
   - Reminders
