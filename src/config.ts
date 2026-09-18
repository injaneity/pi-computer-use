import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ComputerUseConfig {
	browser_use: boolean;
	headless: boolean;
	cursor_overlay: boolean;
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
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
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
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
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
