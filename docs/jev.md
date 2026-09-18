# Jev browser layer

`pi-computer-use` includes a browser layer ported from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast). It
gives a CDP browser page a **dynamic, indexed action space**: every actionable
element gets one code-owned id, each element lists the operations it supports,
and the executor only ever runs an observed action.

The layer is optional and layered. Each layer works without the ones above it.

| Layer | Tool | Needs a model? |
| --- | --- | --- |
| Indexed action space + guarded execution | `jev_observe`, `jev_step` (with an explicit `action`) | No |
| Speculative decision (Vercel AI SDK or direct TypeSafe) | `jev_step` (no `action`, with a `goal`) | a decision credential |
| Autonomous bounded loop | `jev_run` | a decision credential (+ text helper for typing) |

## Quick start

The layer is **disabled by default** because decision-making needs an additional
credential. Enable it for the session with `/computer-use jev on`, or set
`jev_enabled: true` / `PI_COMPUTER_USE_JEV_ENABLED=1`.

```text
launch_browser({ url: "https://example.com" })   # or find_roots for an existing CDP page
jev_observe({ root: "@r3" })                     # numbered element table + stateId
jev_step({ stateId, action: "e3" })              # execute one observed action
```

With decision-making enabled and credentialed:

```text
jev_step({ stateId, goal: "Search for a one-way flight to London" })
jev_run({ stateId, goal: "Search for a one-way flight to London", maxSteps: 20 })
```

## Configuration

Jev is controlled from the normal `pi-computer-use` configuration files:

```text
~/.pi/agent/extensions/pi-computer-use.json
.pi/computer-use.json
```

```json
{
  "jev_enabled": false,
  "jev_decide": true,
  "jev_backend": "auto",
  "jev_model": "typesafe-ai/jev",
  "jev_gateway_zdr": false,
  "jev_max_steps": 60
}
```

- `jev_enabled` (default `false`) — master switch for `jev_observe`, `jev_step`,
  and `jev_run`. It is off by default because decision-making needs an additional
  credential. When `false`, the jev tools are not active: they contribute no
  prompt snippet and cannot be called, and the base tools are unaffected. Enable
  it with `jev_enabled: true`, `PI_COMPUTER_USE_JEV_ENABLED=1`, or
  `/computer-use jev on` (which activates them immediately).
- `jev_decide` (default `true`) — controls **jev decision-making**. When
  `false`, `jev_step` still executes an explicit `action`, but the decision
  backend is unavailable: `jev_step` without `action` and `jev_run` are refused.
  Set this to `false` to keep the indexed action space and guards while the Pi
  agent chooses every operation and target itself.
- `jev_backend` (default `auto`) — which decision transport to use:
  - `auto` prefers the Vercel AI SDK backend when a Gateway or TypeSafe AI
    credential exists, then the direct TypeSafe transport.
  - `vercel` forces the Vercel AI SDK backend (`experimental_evaluate`).
  - `typesafe` forces the direct TypeSafe HTTP transport.
- `jev_model` (optional) — model id override. Defaults are `typesafe-ai/jev` for
  AI Gateway, `jev-latest` for the direct providers.
- `jev_gateway_zdr` (default `false`) — requests Gateway Zero Data Retention on
  Vercel AI Gateway evaluations.
- `jev_max_steps` (default `60`) — action budget for one `jev_run`, also capped
  by the engine's own limit.

The layer also requires `browser_use` (default `true`). With `browser_use`
disabled, every jev tool is refused.

Environment overrides:

```bash
PI_COMPUTER_USE_JEV_ENABLED=1
PI_COMPUTER_USE_JEV_DECIDE=0
PI_COMPUTER_USE_JEV_BACKEND=vercel
PI_COMPUTER_USE_JEV_MODEL=typesafe-ai/jev
PI_COMPUTER_USE_JEV_GATEWAY_ZDR=1
PI_COMPUTER_USE_JEV_MAX_STEPS=20
```

The earlier `jev_policy` / `PI_COMPUTER_USE_JEV_POLICY` spelling is still
accepted as an alias for `jev_decide`.

Session-scoped toggles:

```text
/computer-use                 # show the active configuration and its sources
/computer-use jev off         # disable the jev tool surface for this session
/computer-use jev-decide off  # disable jev decision-making for this session
/computer-use jev-decide on
```

A session override applies until the next `session_start`, when configuration is
reloaded from files and environment.

## Credentials

Credentials stay in the environment and are never written to configuration
files.

Vercel AI SDK backend (preferred by `auto` when present):

```bash
AI_GATEWAY_API_KEY=...                # Vercel AI Gateway API key
VERCEL_OIDC_TOKEN=...                 # or a Vercel OIDC token (automatic on Vercel)
VERCEL_API_KEY=...                    # or a Vercel access token, passed to createGateway
TYPESAFE_AI_API_KEY=...               # for the @ai-sdk/typesafe-ai provider directly
```

Install the SDK to use this backend:

```bash
npm install ai@latest                 # AI SDK 7.0.105 or later
npm install @ai-sdk/typesafe-ai       # only for the direct provider variant
```

When `pi-computer-use` is installed as a Pi-managed npm package, install these
where the extension can resolve them, for example:

```bash
npm install --prefix ~/.pi/agent/npm ai@latest
```

`/computer-use` reports `jev_decision: <backend> needs '<package>'` when a
credential is present but the optional package is missing. `ai@7` requires
Node.js >= 22; the base extension still supports Node >= 20.6, so the Vercel
backend reports the runtime requirement as a clear error on older Node versions
instead of failing inside the SDK.

Direct TypeSafe transport:

```bash
TYPESAFE_API_KEY=...                 # required
TYPESAFE_MODEL=jev-latest            # optional
TYPESAFE_BASE_URL=https://api.typesafe.ai/v1/systemone   # optional
```

Text helper (a small OpenAI-compatible model that writes field values):

```bash
TEXT_MODEL_API_KEY=...               # explicit; requires TEXT_MODEL_BASE_URL
TEXT_MODEL_BASE_URL=https://api.deepseek.com/v1
TEXT_MODEL=deepseek-chat
TEXT_MODEL_REASONING=none            # or low
```

When `TEXT_MODEL_API_KEY` is unset, `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY`
supply a working default so `TYPE_TEXT` values are model-generated rather than
guessed. An explicit `TEXT_MODEL_API_KEY` must name `TEXT_MODEL_BASE_URL`, so a
credential is never posted to a guessed provider; a provider key always uses its
own host, so an unrelated `TEXT_MODEL_BASE_URL` cannot redirect it. The prefixed
spelling is accepted only for the variables listed above (`TEXT_MODEL_*`,
`TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`); provider keys `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`, `VERCEL_API_KEY`, `VERCEL_OIDC_TOKEN`, and
`TYPESAFE_AI_API_KEY` use their canonical names. `/computer-use` reports whether
each credential
was found.

## The action space

`jev_observe` returns one numbered entry per actionable DOM node, with the
operations that node supports and the code-owned action id behind each one:

```text
Elements (4):
[1] combobox "Where from?" · San Francisco {TYPE_TEXT(e1), CLICK(e2)}
[2] combobox "Where to?" · empty {TYPE_TEXT(e3), CLICK(e4)}
[3] button "Explore" {CLICK(e5)}
[4] select "Cabin" · Economy {SELECT(4:1 "Economy", SELECT(4:2 "Premium"))}
Document operations: SCROLL_DOWN, SCROLL_UP, WAIT
```

- One index per node even when it supports both clicking and typing.
- Dropdown options are targets of the same element (`4:2`) and each carries an
  observed value.
- Only supported operations are offered. Password, file, hidden, disabled, and
  invisible controls are never exposed.
- At most 250 action candidates are retained; truncated candidates are reported
  and cannot be selected.

Pass an action id to `jev_step`:

```ts
jev_step({ stateId, action: "e3" })
jev_step({ stateId, action: "e1", text: "Zürich" })   // explicit TYPE_TEXT value
```

## Decision-making

With `jev_decide` enabled and a decision credential present, `jev_step` can
decide and execute in one call:

```ts
jev_step({ stateId, goal: "Find a one-way flight from Zürich to London" })
```

Both transports send the **same** question set built from the indexed action
space: one `operation` choice plus one `choice` head per available operation.
Only the selected operation's target head is consumed, so a malformed unused
head cannot cause an action. The chosen target must belong to the selected head.

### Vercel AI SDK backend

Selected by `jev_backend: "vercel"`, or by `auto` when a Gateway or TypeSafe AI
credential exists. It calls the AI SDK's experimental evaluation API:

```ts
import { experimental_evaluate as evaluate } from "ai";

const result = await evaluate({
  model: "typesafe-ai/jev",
  state: "The support agent issued a full refund to the customer.",
  questions: {
    refunded: {
      type: "boolean",
      instructions: "Was a refund issued?",
    },
  },
});
```

`pi-computer-use` builds the equivalent `choice` questions from the observed
action space and reads `answers.<id>.choice`, `answers.<id>.probabilities`, and
`result.providerMetadata.typesafe.confidence`. `result.response.modelId` and
`result.usage` are reported with the decision. A plain `typesafe-ai/jev` string
resolves through Vercel AI Gateway; with `TYPESAFE_AI_API_KEY` the backend uses
`typeSafeAi.evaluationModel(...)` from `@ai-sdk/typesafe-ai` instead. The AI SDK
applies its own retry policy (`maxRetries: 2`).

### Direct TypeSafe transport

Selected by `jev_backend: "typesafe"`, or by `auto` when only `TYPESAFE_API_KEY`
is set. One request goes to `https://api.typesafe.ai/v1/systemone`, and the
response is rejected unless it is a well-formed distribution whose chosen option
is the maximum.

For `TYPE_TEXT`, a separate small model writes the field value. Its JSON must
contain exactly one key, `text`, with a non-empty string of at most 2000
characters. If no value can be inferred, nothing is typed.

`DONE` and `BLOCKED` end a run. `DONE` is never treated as verified success:
`jev_run` reports `verification: "unverified"` and the caller must confirm the
outcome.

## Guards and safety

The executor never accepts selectors, coordinates, or scripts. It only runs an
observed, code-owned action id.

- **Node identity.** A page-side `WeakMap` gives every real DOM node a stable
  code-owned id. Replaced elements get new identities, disconnected references
  are pruned, and navigation starts a new cache.
- **Semantic freshness.** Click and select targets are checked against the full
  semantic page key (URL, viewport, safe form values, target state) and the
  target's own guard (role, name, value, checked/selected, read-only, disabled,
  ARIA state, href, and nearby form/dialog/row text). Other operations compare
  the document marker. Geometry is always re-read immediately before input.
- **Occlusion.** Before a pointer action, the target must still be visible,
  enabled, on-screen, and the topmost element at its center point. A textless
  overlay blocks the click.
- **No retries.** A browser mutation is never retried. Execution is recorded
  before the resulting observation, so a navigation that interrupts the
  observation cannot erase the action. A stale decision is consumed and the
  caller re-observes.
- **Text reuse.** A generated value survives a stale decision only while its
  entire helper input is unchanged; it is discarded after a successful mutation.
- **Bounded work.** One run allows at most 60 actions and 120 decisions. Three
  consecutive non-wait actions with no page change stop the run as `blocked`.

## Tools

| Tool | Purpose |
| --- | --- |
| `jev_observe` | Observe a CDP browser page into the indexed action space. `root` is an exact `@r` ref from `find_roots`; when omitted, the single open CDP page is used. |
| `jev_step` | Execute one observed action. Pass `action` to choose it yourself, or `goal` (with `jev_decide` enabled) to let the policy decide. `text` supplies an explicit `TYPE_TEXT` value. |
| `jev_run` | Run the bounded autonomous loop for a `goal` from a jev `stateId` or a browser `root`. Returns the execution trace. |

A jev state is separate from `observe_ui` states. `act_ui` refuses a jev state,
and `jev_step`/`jev_run` only accept jev states. Both share the same CDP page
resource lane, so a jev write invalidates an older `observe_ui` state and vice
versa.

## Limits

The DOM reader handles common HTML and ARIA controls, not the full
accessible-name algorithm. Shadow roots, iframes, canvas, uploads, pop-up tabs,
nested scrolling, and arbitrary keyboard widgets can block progress. The action
space is generic, but a valid action can still be the wrong one.

Decision-making requires network access and a credential. The Vercel AI SDK
backend needs the optional `ai` package (AI SDK 7.0.105+) and Node.js >= 22; the
direct TypeSafe transport needs none. A DONE choice is never verified by the
engine.

The freshness oracle and the node-identity cache live inside the controlled page
(`window.__jevFast`), so a hostile page can in principle forge its own freshness
signal within its own tab. The host still owns every action id, resolves the
final geometry itself, and never accepts a model-supplied selector, coordinate,
or script.

## Checks

```bash
npm run test:jev         # offline contracts: action space, validation, loop, config, backends
npm run test:jev-live    # 19 live Chrome checks (starts a headless browser, no model calls)
npm run test:jev-gateway # one live Vercel AI Gateway evaluation (spends Gateway credits)
```

The offline check verifies both decision transports with injected responses: the
direct TypeSafe request shape and the AI SDK evaluation question/answer mapping,
including rejection of an unknown operation or target and reporting of a missing
optional package. The live Chrome check verifies semantic freshness, scoped click
guards, overlay blocking, native select, text replacement with asynchronous
suggestions, and navigation invalidation against a local fixture page. The
Gateway check is explicit opt-in and requires `ai` plus a Gateway credential.
