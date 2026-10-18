import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ComputerUseConfig {
	browser_use: boolean;
	headless: boolean;
	cursor_overlay: boolean;
	activity_glow: boolean;
	managed_browser: "helium" | "chrome";
	/** Master switch for the jev tool surface (jev_observe, jev_step, jev_run). */
	jev_enabled: boolean;
	/** Enables jev decision-making: the TypeSafe policy for jev_step (without an action) and jev_run. */
	jev_decide: boolean;
	/** Which decision backend to use: auto prefers the Vercel AI SDK when credentialed. */
	jev_backend: "auto" | "typesafe" | "vercel";
	/** Optional model id override for the resolved decision backend. */
	jev_model?: string;
	/** Requests Gateway Zero Data Retention for Vercel AI Gateway evaluations. */
	jev_gateway_zdr: boolean;
	/** Bounds one jev_run loop; also capped by the engine's own hard limit. */
	jev_max_steps: number;
}

export interface ComputerUseConfigSource {
	path: string;
	exists: boolean;
	values?: Partial<ComputerUseConfig>;
	error?: string;
}

export interface LoadedComputerUseConfig {
	config: ComputerUseConfig;
	sources: ComputerUseConfigSource[];
	env: Partial<ComputerUseConfig>;
}

const DEFAULT_CONFIG: ComputerUseConfig = {
	browser_use: true,
	headless: false,
	cursor_overlay: true,
	activity_glow: false,
	managed_browser: "chrome",
	jev_enabled: false,
	jev_decide: true,
	jev_backend: "auto",
	jev_gateway_zdr: false,
	jev_max_steps: 60,
};

let activeConfig: ComputerUseConfig = { ...DEFAULT_CONFIG };
let activeLoadedConfig: LoadedComputerUseConfig = { config: activeConfig, sources: [], env: {} };
/** Session-scoped toggles win over files and environment until the next session_start. */
let sessionOverrides: Partial<ComputerUseConfig> = {};
/** The last file+environment base, so clearing a toggle can restore it without a reload. */
let activeBaseConfig: ComputerUseConfig = { ...DEFAULT_CONFIG };

/** A copy of the built-in defaults, so callers and tests can assert real defaults. */
export function defaultComputerUseConfig(): ComputerUseConfig {
	return { ...DEFAULT_CONFIG };
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

function parseMaxSteps(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? Math.max(1, Math.min(60, Math.trunc(parsed))) : undefined;
}

/** Accept `jev_decide` and its earlier `jev_policy` spelling. */
function parseJevDecide(source: Record<string, unknown>): boolean | undefined {
	return parseBoolean(source.jev_decide) ?? parseBoolean(source.jev_policy);
}

function normalizePartial(raw: unknown): Partial<ComputerUseConfig> {
	if (!raw || typeof raw !== "object") return {};
	const source = (raw as any).computer_use && typeof (raw as any).computer_use === "object" ? (raw as any).computer_use : raw;
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean((source as any).browser_use);
	const headless = parseBoolean((source as any).headless);
	const cursorOverlay = parseBoolean((source as any).cursor_overlay);
	const activityGlow = parseBoolean((source as any).activity_glow);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	if (activityGlow !== undefined) out.activity_glow = activityGlow;
	const managedBrowser = (source as any).managed_browser;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	const jevEnabled = parseBoolean((source as any).jev_enabled);
	if (jevEnabled !== undefined) out.jev_enabled = jevEnabled;
	const jevDecide = parseJevDecide(source as Record<string, unknown>);
	if (jevDecide !== undefined) out.jev_decide = jevDecide;
	const jevBackend = (source as any).jev_backend;
	if (jevBackend === "auto" || jevBackend === "typesafe" || jevBackend === "vercel") out.jev_backend = jevBackend;
	const jevModel = (source as any).jev_model;
	if (typeof jevModel === "string" && jevModel.trim()) out.jev_model = jevModel.trim();
	const jevGatewayZdr = parseBoolean((source as any).jev_gateway_zdr);
	if (jevGatewayZdr !== undefined) out.jev_gateway_zdr = jevGatewayZdr;
	const jevMaxSteps = parseMaxSteps((source as any).jev_max_steps);
	if (jevMaxSteps !== undefined) out.jev_max_steps = jevMaxSteps;
	return out;
}

function readConfigFile(filePath: string): ComputerUseConfigSource {
	if (!existsSync(filePath)) return { path: filePath, exists: false };
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		return { path: filePath, exists: true, values: normalizePartial(parsed) };
	} catch (error) {
		return { path: filePath, exists: true, error: error instanceof Error ? error.message : String(error) };
	}
}

function readEnv(): Partial<ComputerUseConfig> {
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean(process.env.PI_COMPUTER_USE_BROWSER_USE);
	const headless = parseBoolean(process.env.PI_COMPUTER_USE_HEADLESS);
	const cursorOverlay = parseBoolean(process.env.PI_COMPUTER_USE_CURSOR_OVERLAY);
	const activityGlow = parseBoolean(process.env.PI_COMPUTER_USE_ACTIVITY_GLOW);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	if (activityGlow !== undefined) out.activity_glow = activityGlow;
	const managedBrowser = process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	const jevEnabled = parseBoolean(process.env.PI_COMPUTER_USE_JEV_ENABLED);
	if (jevEnabled !== undefined) out.jev_enabled = jevEnabled;
	const jevDecide = parseBoolean(process.env.PI_COMPUTER_USE_JEV_DECIDE) ?? parseBoolean(process.env.PI_COMPUTER_USE_JEV_POLICY);
	if (jevDecide !== undefined) out.jev_decide = jevDecide;
	const jevBackend = process.env.PI_COMPUTER_USE_JEV_BACKEND;
	if (jevBackend === "auto" || jevBackend === "typesafe" || jevBackend === "vercel") out.jev_backend = jevBackend;
	const jevModel = process.env.PI_COMPUTER_USE_JEV_MODEL;
	if (typeof jevModel === "string" && jevModel.trim()) out.jev_model = jevModel.trim();
	const jevGatewayZdr = parseBoolean(process.env.PI_COMPUTER_USE_JEV_GATEWAY_ZDR);
	if (jevGatewayZdr !== undefined) out.jev_gateway_zdr = jevGatewayZdr;
	const jevMaxSteps = parseMaxSteps(process.env.PI_COMPUTER_USE_JEV_MAX_STEPS);
	if (jevMaxSteps !== undefined) out.jev_max_steps = jevMaxSteps;
	return out;
}

export function loadComputerUseConfig(cwd: string): LoadedComputerUseConfig {
	const sources = [
		readConfigFile(path.join(getAgentDir(), "extensions", "pi-computer-use.json")),
		readConfigFile(path.join(cwd, ".pi", "computer-use.json")),
	];
	const env = readEnv();
	const config = { ...DEFAULT_CONFIG };
	for (const source of sources) {
		if (source.values) Object.assign(config, source.values);
	}
	Object.assign(config, env);
	activeBaseConfig = { ...config };
	// A session toggle outranks files and environment, so reloading config during a
	// tool call cannot silently re-enable a feature the user turned off this session.
	Object.assign(config, sessionOverrides);
	activeConfig = config;
	activeLoadedConfig = { config, sources, env };
	return activeLoadedConfig;
}

/** Start a fresh session: drop session toggles and reload files plus environment. */
export function resetComputerUseConfig(cwd: string): LoadedComputerUseConfig {
	sessionOverrides = {};
	return loadComputerUseConfig(cwd);
}

/** Drop session toggles and restore the last file+environment base immediately. */
export function clearComputerUseSessionOverrides(): void {
	sessionOverrides = {};
	activeConfig = { ...activeBaseConfig };
	activeLoadedConfig = { ...activeLoadedConfig, config: activeConfig };
}

/** Apply a session-scoped override, e.g. from the /computer-use command. */
export function updateComputerUseConfig(patch: Partial<ComputerUseConfig>): ComputerUseConfig {
	sessionOverrides = { ...sessionOverrides, ...patch };
	activeConfig = { ...activeConfig, ...patch };
	activeLoadedConfig = { ...activeLoadedConfig, config: activeConfig };
	return activeConfig;
}

export function getComputerUseConfig(): ComputerUseConfig {
	return activeConfig;
}

export function getLoadedComputerUseConfig(): LoadedComputerUseConfig {
	return activeLoadedConfig;
}

export function isHeadlessMode(): boolean {
	return activeConfig.headless;
}

export function isBrowserUseEnabled(): boolean {
	return activeConfig.browser_use;
}

/*
PI_DOCS_REFERENCE_BEGIN reference/configuration

Configuration controls browser access, strict accessibility execution, the macOS agent cursor, and the macOS activity glow.

## Files

Global config:

```text
~/.pi/agent/extensions/pi-computer-use.json
```

Project config:

```text
.pi/computer-use.json
```

Project config overrides global config. Environment variables override both.

Example:

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "activity_glow": true,
  "jev_enabled": false,
  "jev_decide": true,
  "jev_backend": "auto",
  "jev_model": "typesafe-ai/jev",
  "jev_gateway_zdr": false,
  "jev_max_steps": 60
}
```

Run `/computer-use` in Pi to show the active config and its source. Run
`/computer-use jev on|off` or `/computer-use jev-decide on|off` to override the
jev switches for the current session.

## Options

### `browser_use`

Default: `{{config-default:browser_use}}`

When `false`, the extension refuses known browser windows. This is useful for projects that should not control browsers.

Known browser families include Safari, Chrome and Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `managed_browser`

Default: `{{config-default:managed_browser}}`

Selects `"helium"` or `"chrome"` for `launch_browser`. The debugging port is always allocated internally and isn't part of the model-facing contract.

### `headless`

Default: `{{config-default:headless}}`

When `true`, actions must remain in the background. Raw pointer events, raw keyboard events, foreground focus fallback, cursor takeover, the agent cursor overlay, and the activity glow are blocked. On macOS, actions that would need synthesized pointer or keyboard input, including every `typeText` and `keypress`, fail with `foreground_required` ([macOS reference](./platforms/macos/actions.mdx#headless-policy)). When `false` (the default), Pi prefers verified semantic activation when it is credible, preserves the focus established by editable clicks for dependent keyboard input, and may retry keyboard input in the foreground when a background attempt conclusively produced no value change. Ambiguous pointer actions are never replayed blindly.

### `cursor_overlay`

Default: `{{config-default:cursor_overlay}}`

When `true`, macOS pointer actions enqueue a click-through agent cursor animation to the native grounded point during non-headless background delivery. Foreground actions that control the physical cursor don't display the overlay. The overlay doesn't move the system pointer, accept input, or delay the action. Set it to `false` for invisible automation. `headless: true` always suppresses it regardless of this setting ([macOS reference](./platforms/macos/actions.mdx#agent-cursor-overlay)).

### `activity_glow`

Default: `{{config-default:activity_glow}}`

When `true`, macOS displays a click-through pulsing border on every screen while a Pi agent is using one of the extension's tools. The border stays visible until the agent run ends. Each Pi session owns its indicator state, so one session cannot hide another session's active indicator. The helper removes a session's state if its connection closes unexpectedly.

The activity glow appears in user screen recordings, but never in the agent's own observations: helper captures always target a single window, so screen-edge overlays are not included. The glow is excluded from accessibility discovery. Other platforms ignore this setting, and `headless: true` always suppresses it ([macOS reference](./platforms/macos/implementation.mdx#activity-glow)).

### `jev_enabled`

Default: `false`

Master switch for the jev browser layer (`jev_observe`, `jev_step`, `jev_run`).
It is off by default because jev decision-making needs an additional credential.
When `false`, the jev tools are not active: they contribute no prompt snippet
and cannot be called, and the base tools are unaffected. Enable it with
`jev_enabled: true`, `PI_COMPUTER_USE_JEV_ENABLED=1`, or `/computer-use jev on`
(which activates them immediately). See [Jev browser layer](../explanation/jev.mdx).

### `jev_decide`

Default: `true`

Controls jev decision-making. When `true` and a decision credential is set
(`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `VERCEL_API_KEY`, or
`TYPESAFE_AI_API_KEY` for the Vercel AI SDK backend; `TYPESAFE_API_KEY` for the
direct transport), `jev_step` can choose the operation and target itself (omit
`action` and pass `goal`) and `jev_run` can drive a bounded autonomous loop.
When `false`, the indexed action space and guarded execution remain available,
but the decision backend is refused and `jev_step` requires an explicit
`action`. The earlier `jev_policy` spelling is accepted as an alias.

### `jev_backend`

Default: `"auto"`

Selects the jev decision transport. `auto` prefers the Vercel AI SDK backend
(`experimental_evaluate` from `ai`) when `AI_GATEWAY_API_KEY`,
`VERCEL_OIDC_TOKEN`, `VERCEL_API_KEY`, or `TYPESAFE_AI_API_KEY` is set, then
falls back to the direct TypeSafe HTTP transport when `TYPESAFE_API_KEY` is set.
`"vercel"` forces the AI SDK backend and `"typesafe"` forces the direct
transport. See [Jev browser layer](../explanation/jev.mdx).

### `jev_model`

Default: unset

Overrides the decision model id. Backend defaults are `typesafe-ai/jev` for
Vercel AI Gateway and `jev-latest` for the direct TypeSafe providers.

### `jev_gateway_zdr`

Default: `false`

When `true`, Vercel AI Gateway evaluations request Zero Data Retention via
`providerOptions.gateway.zeroDataRetention`.

### `jev_max_steps`

Default: `60`

Action budget for one `jev_run`, clamped to `1`–`60` and also bounded by the
engine's own hard limit.

## Environment variables

```bash
PI_COMPUTER_USE_BROWSER_USE=0
PI_COMPUTER_USE_BROWSER_USE=1
PI_COMPUTER_USE_MANAGED_BROWSER=helium
PI_COMPUTER_USE_MANAGED_BROWSER=chrome
PI_COMPUTER_USE_CHROME_EXECUTABLE=/absolute/path/to/chrome
PI_COMPUTER_USE_HELIUM_EXECUTABLE=/absolute/path/to/helium
PI_COMPUTER_USE_HEADLESS=0
PI_COMPUTER_USE_HEADLESS=1
PI_COMPUTER_USE_CURSOR_OVERLAY=0
PI_COMPUTER_USE_CURSOR_OVERLAY=1
PI_COMPUTER_USE_ACTIVITY_GLOW=0
PI_COMPUTER_USE_ACTIVITY_GLOW=1
PI_COMPUTER_USE_JEV_ENABLED=0
PI_COMPUTER_USE_JEV_ENABLED=1
PI_COMPUTER_USE_JEV_DECIDE=0
PI_COMPUTER_USE_JEV_DECIDE=1
PI_COMPUTER_USE_JEV_BACKEND=auto
PI_COMPUTER_USE_JEV_BACKEND=typesafe
PI_COMPUTER_USE_JEV_BACKEND=vercel
PI_COMPUTER_USE_JEV_MODEL=typesafe-ai/jev
PI_COMPUTER_USE_JEV_GATEWAY_ZDR=1
PI_COMPUTER_USE_JEV_MAX_STEPS=20
PI_COMPUTER_USE_DELIVERY_POLICY=default
PI_COMPUTER_USE_DELIVERY_POLICY=foreground
PI_COMPUTER_USE_CDP_PORT=9222
```

`PI_COMPUTER_USE_HEADLESS=1` prohibits foreground fallback. `PI_COMPUTER_USE_DELIVERY_POLICY` is a debugging input; normal policy belongs in configuration rather than individual model calls.

`PI_COMPUTER_USE_JEV_ENABLED` and `PI_COMPUTER_USE_JEV_DECIDE` override the jev
switches; `PI_COMPUTER_USE_JEV_POLICY` is accepted as an alias for the latter.
`PI_COMPUTER_USE_JEV_BACKEND`, `PI_COMPUTER_USE_JEV_MODEL`, and
`PI_COMPUTER_USE_JEV_GATEWAY_ZDR` select and configure the decision transport.
Jev credentials (`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `VERCEL_API_KEY`,
`TYPESAFE_AI_API_KEY`, `TYPESAFE_API_KEY`, `TEXT_MODEL_API_KEY`, and their
optional model/endpoint variables) are read from the environment only and are
never written to configuration files. See [Jev browser layer](../explanation/jev.mdx).

`launch_browser` searches common platform install locations and `PATH`. Use `PI_COMPUTER_USE_CHROME_EXECUTABLE` or `PI_COMPUTER_USE_HELIUM_EXECUTABLE` for an AppImage, portable install, or any non-standard location. An explicit override is authoritative and must name an executable file.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

Use a dedicated, non-default profile with `--user-data-dir=<directory>`. Chrome 136 and later ignore remote-debugging switches for the default data directory as a security measure. `launch_browser` already creates a temporary, separate CDP profile and binds discovery to a randomly allocated loopback port.

When CDP is active, discovered pages participate in the same root and state system as desktop UI. `launch_browser` configures CDP automatically and returns an observed page state. `navigate_browser` and `evaluate_browser` accept only CDP browser-page states; native browser windows continue to use the normal desktop observe/act tools.

With the variable unset, CDP is inactive.
PI_DOCS_REFERENCE_END
*/
