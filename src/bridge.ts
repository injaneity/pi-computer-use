import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cdpClickForContext, cdpEvaluateForContext, cdpNavigateContext, cdpScrollForContext, cdpSnapshotForContext, cdpTabForWindow, cdpTypeForContext, listCdpPageContexts, type CdpConsoleEntry, type CdpPageSnapshot } from "./cdp.ts";
import { getComputerUseConfig, isBrowserUseEnabled, isStrictAxMode, loadComputerUseConfig } from "./config.ts";
import { ensurePermissions, type PermissionStatus } from "./permissions.ts";

type WindowSelector = string | number;
type ImageMode = "auto" | "always" | "never";

interface StateTargetSnapshot {
	pid: number;
	windowId: number;
	windowRef?: string;
}

export interface ScreenshotParams {
	app?: string;
	windowTitle?: string;
	window?: WindowSelector;
	image?: ImageMode;
}

export interface ListWindowsParams {
	app?: string;
	bundleId?: string;
	pid?: number;
}

interface WindowTargetParams {
	contextId?: string;
	window?: WindowSelector;
	stateId?: string;
	image?: ImageMode;
	responseMode?: "state" | "confirmation";
}

export interface ClickParams extends WindowTargetParams {
	x?: number;
	y?: number;
	ref?: string;
	button?: MouseButtonName;
	clickCount?: number;
}

export interface TypeTextParams extends WindowTargetParams {
	text: string;
}

export interface SetTextParams extends WindowTargetParams {
	text: string;
	ref?: string;
	method?: "ax" | "keyboard";
}

export interface KeypressParams extends WindowTargetParams {
	keys: string[];
}

export interface ScrollParams extends WindowTargetParams {
	x?: number;
	y?: number;
	ref?: string;
	scrollX?: number;
	scrollY?: number;
}

export interface MoveMouseParams extends WindowTargetParams {
	x: number;
	y: number;
}

export interface DragParams extends WindowTargetParams {
	path?: Array<{ x: number; y: number } | [number, number]>;
	ref?: string;
}

export type ComputerAction =
	| ({ type: "click" } & ClickParams)
	| ({ type: "double_click" } & ClickParams)
	| ({ type: "move_mouse" } & MoveMouseParams)
	| ({ type: "drag" } & DragParams)
	| ({ type: "scroll" } & ScrollParams)
	| ({ type: "keypress" } & KeypressParams)
	| ({ type: "type_text" } & TypeTextParams)
	| ({ type: "set_text" } & SetTextParams)
	| ({ type: "wait" } & WaitParams);

export interface ComputerActionsParams extends WindowTargetParams {
	actions: ComputerAction[];
}

export interface ArrangeWindowParams extends WindowTargetParams {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	preset?: "center_large" | "left_half" | "right_half" | "top_half" | "bottom_half";
}

export interface NavigateBrowserParams extends WindowTargetParams {
	url: string;
}

export interface LaunchBrowserContextParams {
	browser?: "helium" | "chrome";
	url?: string;
	port?: number;
}

export interface EvaluateBrowserParams {
	contextId: string;
	expression: string;
}

export interface WaitParams extends WindowTargetParams {
	ms?: number;
}

export interface SnapshotParams {
	contextId: string;
	scopeRef?: string;
	maxNodes?: number;
	maxDepth?: number;
	image?: ImageMode;
}

export interface ReadTextParams extends WindowTargetParams {
	ref?: string;
	offset?: number;
	limit?: number;
}

export interface WaitForParams extends WindowTargetParams {
	text?: string;
	role?: string;
	gone?: boolean;
	timeoutMs?: number;
}

export interface CurrentTarget {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId: number;
	windowRef?: string;
	nativeWindowRef?: string;
}

export interface CurrentCapture {
	stateId: string;
	width: number;
	height: number;
	scaleFactor: number;
	timestamp: number;
}

interface ActivationFlags {
	activated: boolean;
	unminimized: boolean;
	raised: boolean;
}

type ExecutionVariant = "stealth" | "default";
type NativeInputDelivery = "pid" | "hid";
type ActionDelivery = "ax" | NativeInputDelivery;
type DeliveryPolicy = "ax_only" | "background" | "default";
type Grounding = "ax" | "vision";

interface ExecutionTrace {
	strategy:
		| "screenshot"
		| "wait"
		| "batch"
		| "window_frame"
		| "ax_press"
		| "ax_focus"
		| "coordinate_event_click"
		| "coordinate_event_double_click"
		| "coordinate_event_move"
		| "coordinate_event_drag"
		| "coordinate_event_scroll"
		| "pid_event_click"
		| "pid_event_double_click"
		| "pid_event_move"
		| "pid_event_drag"
		| "pid_event_scroll"
		| "ax_scroll"
		| "ax_action"
		| "browser_open_location"
		| "cdp_navigate"
		| "ax_set_value"
		| "raw_keypress"
		| "raw_key_text"
		| "pid_keypress"
		| "pid_key_text";
	axAttempted?: boolean;
	axSucceeded?: boolean;
	fallbackUsed?: boolean;
	runtimeMode?: ExecutionVariant;
	variant?: ExecutionVariant;
	stealthCompatible?: boolean;
	nonStealthReason?: string;
	grounding?: Grounding;
	delivery?: ActionDelivery;
	deliveryPolicy?: DeliveryPolicy;
	coordinateStateChanged?: boolean;
	coordinateVerification?: "ax_signature_changed" | "no_observable_change" | "unavailable";
	actionCount?: number;
	completedActionCount?: number;
	actions?: BatchActionTrace[];
}

interface BatchActionTrace {
	index: number;
	type: string;
	strategy: ExecutionTrace["strategy"];
	durationMs: number;
	axAttempted?: boolean;
	axSucceeded?: boolean;
	fallbackUsed?: boolean;
	runtimeMode?: ExecutionVariant;
	variant?: ExecutionVariant;
	stealthCompatible?: boolean;
	nonStealthReason?: string;
	grounding?: Grounding;
	delivery?: ActionDelivery;
	deliveryPolicy?: DeliveryPolicy;
	coordinateStateChanged?: boolean;
	coordinateVerification?: ExecutionTrace["coordinateVerification"];
}

interface HelperDiagnostics {
	protocolVersion: number;
	pid: number;
	parentPid?: number;
	parentAppName?: string;
	parentBundleId?: string;
	parentPath?: string;
	executablePath?: string;
	macOS?: string;
	arch?: string;
	accessibility?: boolean;
	screenRecording?: boolean;
}

export interface ComputerUseDetails {
	tool: string;
	target: {
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId: number;
		windowRef?: string;
		nativeWindowRef?: string;
	};
	capture: {
		stateId: string;
		width: number;
		height: number;
		scaleFactor: number;
		timestamp: number;
		coordinateSpace: "window-relative-screenshot-pixels";
	};
	axTargets?: AxTarget[];
	visionTargets?: VisionTarget[];
	activation: ActivationFlags;
	execution: ExecutionTrace;
	config?: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
	helper?: HelperDiagnostics;
	status?: "ok";
	axDiagnostics?: {
		reason?: string;
		message?: string;
		debug?: unknown;
	};
	/** Recent browser console messages/exceptions; only present when CDP is active. */
	console?: CdpConsoleEntry[];
	imageReason?:
		| "fallback_recovery"
		| "browser_ax_window_unavailable"
		| "no_ax_targets"
		| "sparse_ax_targets"
		| "weak_ax_targets"
		| "unlabeled_ax_targets"
		| "duplicated_ax_labels"
		| "browser_wait_verification";
}

export interface ListAppsDetails {
	tool: "list_apps";
	apps: Array<{
		app: string;
		bundleId?: string;
		pid: number;
		isFrontmost: boolean;
		browserUseAllowed: boolean;
	}>;
	config: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
	helper?: HelperDiagnostics;
}

export interface ListWindowsDetails {
	tool: "list_windows";
	query: ListWindowsParams;
	windows: Array<{
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId?: number;
		windowRef: string;
		nativeWindowRef?: string;
		framePoints: FramePoints;
		scaleFactor: number;
		isMinimized: boolean;
		isOnscreen: boolean;
		isMain: boolean;
		isFocused: boolean;
		isModal: boolean;
		sheetCount: number;
		role?: string;
		subrole?: string;
		browserUseAllowed: boolean;
		score: number;
	}>;
	config: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
}

export interface ContextDetails {
	tool: "list_contexts";
	contexts: Array<{
		contextId: string;
		kind: "desktop_window" | "browser_page";
		title: string;
		app?: string;
		bundleId?: string;
		pid?: number;
		windowRef?: string;
		windowId?: number;
		url?: string;
		availableActions: string[];
	}>;
	config: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
}

export interface SnapshotDetails {
	tool: "snapshot";
	contextId: string;
	kind: "desktop_window" | "browser_page";
	snapshotId: string;
	availableActions: string[];
	browser?: CdpPageSnapshot;
	desktop?: ComputerUseDetails;
}

export interface EvaluateBrowserDetails {
	tool: "evaluate_browser";
	contextId: string;
	value: unknown;
}

export interface LaunchBrowserContextDetails {
	tool: "launch_browser_context";
	browser: "helium" | "chrome";
	port: number;
	url: string;
	contexts: ContextDetails["contexts"];
}

export interface ReadTextDetails {
	tool: "read_text";
	contextId?: string;
	ref?: string;
	offset: number;
	limit: number;
	totalChars: number;
	hasMore: boolean;
	text: string;
}

export interface ConfirmationDetails {
	tool: string;
	status: "ok";
	target: Pick<ComputerUseDetails["target"], "app" | "bundleId" | "pid" | "windowTitle" | "windowId" | "windowRef">;
	execution: ExecutionTrace;
	message: string;
}

export interface WaitForDetails {
	tool: "wait_for";
	contextId?: string;
	found: boolean;
	gone?: boolean;
	timedOut?: boolean;
	target?: AxTarget;
	nodeCount?: number;
	text?: string;
	role?: string;
}

interface HelperApp {
	appName: string;
	bundleId?: string;
	pid: number;
	isFrontmost?: boolean;
}

interface FramePoints {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface HelperWindow {
	windowId?: number;
	windowRef?: string;
	title: string;
	role?: string;
	subrole?: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
	isModal: boolean;
	sheetCount: number;
}

interface FrontmostResult {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle?: string;
	windowId?: number;
}

interface ScreenshotPayload {
	pngBase64: string;
	width: number;
	height: number;
	scaleFactor: number;
}

interface VisionTarget {
	ref: string;
	text: string;
	confidence: number;
	x: number;
	y: number;
	frame?: FramePoints;
}

interface FocusedElementResult {
	exists: boolean;
	elementRef?: string;
	role?: string;
	subrole?: string;
	isTextInput?: boolean;
	isSecure?: boolean;
	canSetValue?: boolean;
}

interface FocusWindowResult {
	focused: boolean;
	alreadyFocused?: boolean;
	reason?: string;
}

interface AxPressAtPointResult {
	pressed: boolean;
	reason?: string;
}

interface AxFocusResult {
	focused: boolean;
	reason?: string;
}

interface HelperAxTarget {
	elementRef?: string;
	role?: string;
	subrole?: string;
	title?: string;
	description?: string;
	identifier?: string;
	value?: string;
	actions?: string[];
	source?: string;
	isTextInput?: boolean;
	canSetValue?: boolean;
	canFocus?: boolean;
	canPress?: boolean;
	canScroll?: boolean;
	canIncrement?: boolean;
	canDecrement?: boolean;
	x?: number;
	y?: number;
	frame?: Partial<FramePoints>;
	parentFrame?: Partial<FramePoints>;
	score?: number;
	depth?: number;
}

interface ResolvedTarget extends CurrentTarget {
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}


type AxTargetSource = "desktop_ax" | "browser_chrome_ax" | "web_content_ax" | "unknown_ax";

interface AxDiagnosticsDebug {
	browserChromeOnly?: boolean;
	browserChromeTargetCount?: number;
	webContentTargetCount?: number;
	sourceCounts?: Record<string, number>;
	[key: string]: unknown;
}

interface AxTarget {
	ref: string;
	elementRef: string;
	role: string;
	subrole: string;
	title: string;
	description: string;
	identifier: string;
	value: string;
	actions: string[];
	source: AxTargetSource;
	isTextInput: boolean;
	canSetValue: boolean;
	canFocus: boolean;
	canPress: boolean;
	canScroll: boolean;
	canIncrement: boolean;
	canDecrement: boolean;
	x: number;
	y: number;
	frame?: FramePoints;
	parentFrame?: FramePoints;
	score?: number;
	depth?: number;
}

interface PendingBrowserAddress {
	text: string;
	pid: number;
	windowId: number;
}

interface WindowRefRecord {
	ref: string;
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId?: number;
	nativeWindowRef?: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

interface RuntimeState {
	currentTarget?: CurrentTarget;
	currentCapture?: CurrentCapture;
	currentStateTarget?: StateTargetSnapshot;
	currentImageMode?: ImageMode;
	currentAxTargets?: AxTarget[];
	currentVisionTargets?: VisionTarget[];
	browserSnapshots: Map<string, CdpPageSnapshot>;
	windowRefs: Map<string, WindowRefRecord>;
	windowRefByIdentity: Map<string, string>;
	windowWriteQueues: Map<string, Promise<void>>;
	nextWindowRefIndex: number;
	allowNextTypeTextAxReplacement?: boolean;
	pendingBrowserAddress?: PendingBrowserAddress;
	daemonAvailable?: boolean;
	managedBrowser?: ChildProcess;
	requestSequence: number;
	queueTail: Promise<void>;
	permissionStatus?: PermissionStatus;
	helperDiagnostics?: HelperDiagnostics;
	lastPermissionCheckAt: number;
	helperInstallChecked: boolean;
}

type MouseButtonName = "left" | "right" | "middle";

const TOOL_NAMES = new Set([
	"list_apps",
	"list_windows",
	"list_contexts",
	"snapshot",
	"read_text",
	"wait_for",
	"screenshot",
	"click",
	"double_click",
	"move_mouse",
	"drag",
	"scroll",
	"keypress",
	"type_text",
	"set_text",
	"wait",
	"arrange_window",
	"navigate_browser",
	"evaluate_browser",
	"launch_browser_context",
	"computer_actions",
]);

const MISSING_TARGET_ERROR = "No current controlled window. Call screenshot first to choose a target window.";
const CURRENT_TARGET_GONE_ERROR =
	"The current controlled window is no longer available. Call screenshot to choose a new target window.";
const NON_MACOS_ERROR = "pi-computer-use currently supports macOS 12+ only.";

const COMMAND_TIMEOUT_MS = 15_000;
const HELPER_PROTOCOL_VERSION = 1;
const SCREENSHOT_TIMEOUT_MS = 25_000;
const HELPER_SETUP_TIMEOUT_MS = 60_000;
const ACTION_SETTLE_MS = 280;
const BATCH_ACTION_GAP_MS = 80;
const BATCH_MAX_ACTIONS = 20;
const DEFAULT_WAIT_MS = 1_000;

const RECOVERABLE_SCREENSHOT_ERROR_CODES = new Set(["screenshot_timeout", "window_not_found"]);
const BROWSER_BUNDLE_IDS = new Set([
	"com.apple.Safari",
	"com.google.Chrome",
	"org.chromium.Chromium",
	"company.thebrowser.Browser",
	"com.brave.Browser",
	"com.microsoft.edgemac",
	"com.vivaldi.Vivaldi",
	"net.imput.helium",
	"org.mozilla.firefox",
]);
const BROWSER_APP_NAMES = new Set([
	"safari",
	"google chrome",
	"chrome",
	"chromium",
	"arc",
	"brave browser",
	"brave",
	"microsoft edge",
	"edge",
	"vivaldi",
	"helium",
	"firefox",
]);
const CHROME_FAMILY_BUNDLE_IDS = new Set([
	"com.google.Chrome",
	"org.chromium.Chromium",
	"company.thebrowser.Browser",
	"com.brave.Browser",
	"com.microsoft.edgemac",
	"com.vivaldi.Vivaldi",
	"net.imput.helium",
]);
const CHROME_FAMILY_APP_NAMES = new Set([
	"google chrome",
	"chrome",
	"chromium",
	"arc",
	"brave browser",
	"brave",
	"microsoft edge",
	"edge",
	"vivaldi",
	"helium",
]);
const BROWSER_WINDOW_OPEN_TIMEOUT_MS = 10_000;
const BROWSER_CONTEXT_PREFIX = "browser:";
const DESKTOP_CONTEXT_PREFIX = "desktop:";
const MANAGED_BROWSER_READY_TIMEOUT_MS = 15_000;
const AUTO_IMAGE_MAX_DIMENSION = 1_000;
const EXPLICIT_IMAGE_MAX_DIMENSION = 1_600;
const AX_TARGET_TEXT_PREVIEW_CHARS = 240;
const BROWSER_SNAPSHOT_TEXT_PREVIEW_CHARS = 2_000;
const HELIUM_EXECUTABLE = "/Applications/Helium.app/Contents/MacOS/Helium";
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const HELPER_APP_PATH = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "PiComputerUseBridge.app");
const HELPER_APP_EXECUTABLE_PATH = path.join(HELPER_APP_PATH, "Contents", "MacOS", "bridge");
const HELPER_SOCKET_PATH = path.join(os.homedir(), "Library", "Caches", "pi-computer-use", "bridge.sock");

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");

const runtimeState: RuntimeState = {
	requestSequence: 0,
	queueTail: Promise.resolve(),
	lastPermissionCheckAt: 0,
	helperInstallChecked: false,
	allowNextTypeTextAxReplacement: false,
	browserSnapshots: new Map(),
	windowRefs: new Map(),
	windowRefByIdentity: new Map(),
	windowWriteQueues: new Map(),
	nextWindowRefIndex: 1,
};

class HelperTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HelperTransportError";
	}
}

class HelperCommandError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "HelperCommandError";
		this.code = code;
	}
}

const BROWSER_JAVASCRIPT_APPLE_EVENTS_HINT = [
	"Browser JavaScript Apple Events are disabled for the target browser.",
	"Ask the user to enable \"Allow JavaScript from Apple Events\" in the browser's developer menu, then retry the browser action.",
].join(" ");

function isBrowserJavaScriptAppleEventsErrorMessage(message: string): boolean {
	return /not allowed to send javascript commands/i.test(message)
		|| /executing javascript through applescript is turned off/i.test(message)
		|| /allow javascript from apple events/i.test(message)
		|| /enable javascript from apple events/i.test(message)
		|| (/javascript/i.test(message) && /apple events/i.test(message));
}

function appendBrowserJavaScriptAppleEventsHint(error: Error): Error {
	if (!isBrowserJavaScriptAppleEventsErrorMessage(error.message) || error.message.includes(BROWSER_JAVASCRIPT_APPLE_EVENTS_HINT)) {
		return error;
	}
	const enhanced = new Error(`${error.message}\n\n${BROWSER_JAVASCRIPT_APPLE_EVENTS_HINT}`);
	enhanced.name = error.name;
	return enhanced;
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isRecoverableScreenshotError(error: unknown): error is HelperCommandError {
	return error instanceof HelperCommandError && !!error.code && RECOVERABLE_SCREENSHOT_ERROR_CODES.has(error.code);
}

function currentRuntimeMode(): ExecutionVariant {
	return isStrictAxMode() ? "stealth" : "default";
}

function currentDeliveryPolicy(): DeliveryPolicy {
	if (isStrictAxMode()) return "ax_only";
	const value = (process.env.PI_COMPUTER_USE_DELIVERY_POLICY ?? process.env.PI_COMPUTER_USE_EVENT_DELIVERY ?? "default").toLowerCase();
	return value === "background" || value === "pid" ? "background" : value === "ax_only" || value === "ax-only" ? "ax_only" : "default";
}

function nativeInputDelivery(): NativeInputDelivery {
	return currentDeliveryPolicy() === "background" ? "pid" : "hid";
}

function inferredTraceGrounding(strategy: ExecutionTrace["strategy"]): Grounding | undefined {
	if (strategy.startsWith("ax_")) return "ax";
	if (strategy.startsWith("coordinate_") || strategy.startsWith("pid_event_")) return "vision";
	return undefined;
}

function inferredTraceDelivery(strategy: ExecutionTrace["strategy"]): ActionDelivery | undefined {
	if (strategy.startsWith("ax_")) return "ax";
	if (strategy.startsWith("pid_")) return "pid";
	if (strategy.startsWith("coordinate_") || strategy.startsWith("raw_")) return "hid";
	return undefined;
}

function executionTrace(
	strategy: ExecutionTrace["strategy"],
	variant: ExecutionVariant,
	metadata: Omit<ExecutionTrace, "strategy" | "runtimeMode" | "variant" | "stealthCompatible"> = {},
): ExecutionTrace {
	return {
		strategy,
		runtimeMode: currentRuntimeMode(),
		variant,
		stealthCompatible: variant === "stealth",
		grounding: metadata.grounding ?? inferredTraceGrounding(strategy),
		delivery: metadata.delivery ?? inferredTraceDelivery(strategy),
		...metadata,
	};
}

function strictModeBlock(message: string): never {
	throw new Error(`${message} Stealth/strict AX mode is enabled, so non-AX, foreground-focus, and cursor fallbacks are blocked.`);
}

function settleMsForExecution(execution: ExecutionTrace): number {
	if (execution.strategy === "batch") {
		const actions = execution.actions ?? [];
		return actions.length > 0 && actions.every((action) => action.variant === "stealth") ? 120 : ACTION_SETTLE_MS;
	}
	if (execution.variant === "stealth") {
		switch (execution.strategy) {
			case "ax_focus":
			case "ax_set_value":
				return 80;
			case "ax_action":
			case "browser_open_location":
			case "ax_scroll":
				return 120;
			case "ax_press":
				return 160;
			default:
				return 120;
		}
	}
	return ACTION_SETTLE_MS;
}

function addRefreshHint(error: unknown): Error {
	const message = normalizeError(error).message;
	if (/call screenshot/i.test(message)) {
		return new Error(message);
	}
	return new Error(`${message} Call screenshot again to refresh the current window state.`);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted.");
	}
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const onAbort = () => {
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function withRuntimeLock<T>(work: () => Promise<T>): Promise<T> {
	const previous = runtimeState.queueTail;
	let release!: () => void;
	runtimeState.queueTail = new Promise<void>((resolve) => {
		release = resolve;
	});

	await previous.catch(() => undefined);
	try {
		return await work();
	} finally {
		release();
	}
}

function windowWriteLockKey(target: ResolvedTarget | CurrentTarget): string {
	return target.windowId > 0 ? `pid:${target.pid}:window:${target.windowId}` : `pid:${target.pid}:ref:${target.windowRef ?? target.windowTitle}`;
}

async function withWindowWriteLock<T>(target: ResolvedTarget | CurrentTarget, work: () => Promise<T>): Promise<T> {
	const key = windowWriteLockKey(target);
	const previous = runtimeState.windowWriteQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.catch(() => undefined).then(() => next);
	runtimeState.windowWriteQueues.set(key, queued);
	await previous.catch(() => undefined);
	try {
		return await work();
	} finally {
		release();
		if (runtimeState.windowWriteQueues.get(key) === queued) {
			runtimeState.windowWriteQueues.delete(key);
		}
	}
}


function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeText(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function toFiniteNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function toBoolean(value: unknown): boolean {
	return value === true;
}

function normalizeMouseButton(value: unknown): MouseButtonName {
	if (value === "right" || value === "middle" || value === "left") {
		return value;
	}
	return "left";
}

function normalizeClickCount(value: unknown, fallback = 1): number {
	const count = Math.trunc(toFiniteNumber(value, fallback));
	return Math.max(1, Math.min(3, count));
}

function normalizeScrollDelta(value: unknown): number {
	const delta = Math.round(toFiniteNumber(value, 0));
	return Math.max(-10_000, Math.min(10_000, delta));
}

function normalizeKeyList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && key.trim().length > 0) : [];
}

function ensurePointIsInCapture(
	x: number,
	y: number,
	capture: CurrentCapture,
	errorPrefix = "Coordinates",
): void {
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${errorPrefix} must be finite numbers.`);
	}
	if (x < 0 || y < 0 || x >= capture.width || y >= capture.height) {
		throw new Error(
			`${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest screenshot bounds (${capture.width}x${capture.height}). Call screenshot again and retry.`,
		);
	}
}

function screenPointToCapturePoint(
	target: Pick<ResolvedTarget, "framePoints">,
	capture: CurrentCapture,
	screenX: number,
	screenY: number,
): { x: number; y: number } {
	const frame = target.framePoints;
	const relX = frame.w > 0 ? (screenX - frame.x) / frame.w : 0;
	const relY = frame.h > 0 ? (screenY - frame.y) / frame.h : 0;
	return {
		x: Math.max(0, Math.min(capture.width - 1, relX * capture.width)),
		y: Math.max(0, Math.min(capture.height - 1, relY * capture.height)),
	};
}

function axCoordinateFallbackPoint(target: AxTarget): { x: number; y: number } {
	const frame = target.frame;
	const parent = target.parentFrame;
	const parentLooksLikeRow = frame && parent && parent.w > frame.w * 1.5 && parent.h >= frame.h && parent.h <= frame.h * 3;
	return parentLooksLikeRow ? { x: parent.x + parent.w / 2, y: frame.y + frame.h / 2 } : { x: target.x, y: target.y };
}

function normalizeDragPath(path: DragParams["path"], capture: CurrentCapture): Array<{ x: number; y: number }> {
	if (!Array.isArray(path) || path.length < 2) {
		throw new Error("drag.path must contain at least two points.");
	}

	return path.map((point, index) => {
		const x = Array.isArray(point) ? toFiniteNumber(point[0], NaN) : toFiniteNumber(point?.x, NaN);
		const y = Array.isArray(point) ? toFiniteNumber(point[1], NaN) : toFiniteNumber(point?.y, NaN);
		ensurePointIsInCapture(x, y, capture, `Drag point ${index + 1}`);
		return { x, y };
	});
}

function validateStateId(stateId?: string): CurrentCapture {
	if (!runtimeState.currentTarget || !runtimeState.currentCapture) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	const supplied = stateId;
	if (supplied && runtimeState.currentCapture.stateId !== supplied) {
		throw new Error(
			`Stale state '${supplied}'. The latest state is '${runtimeState.currentCapture.stateId}' for ${runtimeState.currentTarget.windowRef ?? "the current window"}. Call screenshot${runtimeState.currentTarget.windowRef ? `({ window: "${runtimeState.currentTarget.windowRef}" })` : ""} again and retry.`,
		);
	}
	const stateTarget = runtimeState.currentStateTarget;
	if (stateTarget && (stateTarget.pid !== runtimeState.currentTarget.pid || stateTarget.windowId !== runtimeState.currentTarget.windowId)) {
		throw new Error("The latest state belongs to a different window. Call screenshot for the target window and retry.");
	}
	return runtimeState.currentCapture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseAxDiagnosticsDebug(value: unknown): AxDiagnosticsDebug | undefined {
	if (!isRecord(value)) return undefined;
	return {
		...value,
		browserChromeOnly: value.browserChromeOnly === true,
		browserChromeTargetCount: Number.isFinite(value.browserChromeTargetCount) ? Number(value.browserChromeTargetCount) : undefined,
		webContentTargetCount: Number.isFinite(value.webContentTargetCount) ? Number(value.webContentTargetCount) : undefined,
		sourceCounts: isRecord(value.sourceCounts)
			? Object.fromEntries(Object.entries(value.sourceCounts).filter((entry): entry is [string, number] => Number.isFinite(entry[1])))
			: undefined,
	};
}

function axDiagnosticsFromResult(result: unknown, target: ResolvedTarget): CaptureResult["axDiagnostics"] {
	const raw = isRecord(result) ? result : {};
	const reason = toOptionalString(raw.reason);
	const debug = parseAxDiagnosticsDebug(raw.diagnostics);
	if (!reason && debug === undefined) return undefined;
	if (reason === "window_not_found") {
		const windowHint = target.windowRef ? ` Use list_windows and choose an existing content window such as ${target.windowRef}, then call screenshot({ window: "${target.windowRef}" }).` : " Use list_windows and choose an existing content window.";
		return { reason, message: `Accessibility could not resolve the target browser window. Duplicate/empty browser windows can cause this.${windowHint}`, debug };
	}
	return { reason, message: reason ? `Accessibility target listing returned '${reason}'.` : undefined, debug };
}

function parseAxTargetSource(value: unknown): AxTargetSource {
	return value === "desktop_ax" || value === "browser_chrome_ax" || value === "web_content_ax" ? value : "unknown_ax";
}

function parseVisionTargets(result: unknown): VisionTarget[] {
	const items = Array.isArray(result) ? result : (isRecord(result) ? result.targets : undefined);
	if (!Array.isArray(items)) return [];
	return items
		.map((raw, index) => {
			const text = toOptionalString((raw as any)?.text);
			if (!text) return undefined;
			return {
				ref: `@v${index + 1}`,
				text,
				confidence: Math.max(0, Math.min(1, toFiniteNumber((raw as any)?.confidence, 0))),
				x: toFiniteNumber((raw as any)?.x, 0),
				y: toFiniteNumber((raw as any)?.y, 0),
				frame: parseOptionalFramePoints((raw as any)?.frame),
			} as VisionTarget;
		})
		.filter((item): item is VisionTarget => Boolean(item));
}

function formatVisionTargetLabel(target: VisionTarget): string {
	return `${target.ref} vision ${JSON.stringify(target.text)} at (${Math.round(target.x)},${Math.round(target.y)}) confidence=${target.confidence.toFixed(2)}`;
}

function previewAxText(value: unknown): string {
	const text = toOptionalString(value) ?? "";
	return text.length > AX_TARGET_TEXT_PREVIEW_CHARS ? `${text.slice(0, AX_TARGET_TEXT_PREVIEW_CHARS)}…` : text;
}

function parseAxTargets(result: unknown): AxTarget[] {
	const items = Array.isArray(result) ? result : (isRecord(result) ? result.targets : undefined);
	if (!Array.isArray(items)) return [];

	return items
		.map((raw, index) => {
			const target = raw as HelperAxTarget;
			const elementRef = toOptionalString(target?.elementRef);
			if (!elementRef) return undefined;
			const actions = Array.isArray(target?.actions) ? target.actions.filter((value): value is string => typeof value === "string") : [];
			return {
				ref: `@e${index + 1}`,
				elementRef,
				role: toOptionalString(target?.role) ?? "",
				subrole: toOptionalString(target?.subrole) ?? "",
				title: previewAxText(target?.title),
				description: previewAxText(target?.description),
				identifier: previewAxText(target?.identifier),
				value: previewAxText(target?.value),
				actions,
				source: parseAxTargetSource(target?.source),
				isTextInput: toBoolean(target?.isTextInput),
				canSetValue: toBoolean(target?.canSetValue),
				canFocus: toBoolean(target?.canFocus),
				canPress: toBoolean(target?.canPress),
				canScroll: toBoolean(target?.canScroll),
				canIncrement: toBoolean(target?.canIncrement),
				canDecrement: toBoolean(target?.canDecrement),
				x: toFiniteNumber(target?.x, 0),
				y: toFiniteNumber(target?.y, 0),
				frame: parseOptionalFramePoints(target?.frame),
				parentFrame: parseOptionalFramePoints(target?.parentFrame),
				score: Number.isFinite(target?.score) ? Number(target.score) : undefined,
				depth: Number.isFinite(target?.depth) ? Math.trunc(Number(target.depth)) : undefined,
			} as AxTarget;
		})
		.filter((item): item is AxTarget => Boolean(item));
}

function formatAxTargetLabel(target: AxTarget): string {
	const label = target.title || target.description || target.value || "(unlabeled)";
	const identifier = target.identifier ? ` id=${JSON.stringify(target.identifier)}` : "";
	const capabilities = [
		target.canSetValue ? "setValue" : undefined,
		target.canPress ? "press" : undefined,
		target.canFocus ? "focus" : undefined,
		target.canScroll ? "scroll" : undefined,
		target.canIncrement || target.canDecrement ? "adjust" : undefined,
	].filter((item): item is string => Boolean(item));
	const source = target.source !== "unknown_ax" ? ` source=${target.source}` : "";
	return `${target.ref} ${target.role}${target.subrole ? `/${target.subrole}` : ""}${source}${identifier} ${JSON.stringify(label)}${capabilities.length ? ` [${capabilities.join(",")}]` : ""}`;
}

function visionTargetByRef(ref: string): VisionTarget | undefined {
	return runtimeState.currentVisionTargets?.find((candidate) => candidate.ref === ref);
}

function axTargetByRef(ref: string): AxTarget {
	const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
	if (!axTarget) {
		const windowHint = runtimeState.currentTarget?.windowRef ? `({ window: "${runtimeState.currentTarget.windowRef}" })` : "";
		throw new Error(`AX target '${ref}' is stale or not available for the latest state. Call screenshot${windowHint} again and choose a current @e ref.`);
	}
	return axTarget;
}

function axTargetLabelKey(target: AxTarget): string {
	return normalizeText(target.title || target.description || target.value);
}

function isElementRefInvalid(error: unknown): boolean {
	return (error instanceof HelperCommandError && error.code === "element_ref_invalid") || /element reference is no longer valid|element_ref_invalid/i.test(normalizeError(error).message);
}

async function listAxTargetsRaw(target: ResolvedTarget, limit: number, signal?: AbortSignal): Promise<unknown> {
	return await bridgeCommand(
		"axListTargets",
		{ ...nativeWindowRequest(target), limit },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch((error) => ({ targets: [], reason: error instanceof HelperCommandError ? (error.code ?? "ax_list_failed") : "ax_list_failed" }));
}

async function refreshAxTargets(target: ResolvedTarget, signal?: AbortSignal): Promise<AxTarget[]> {
	const refreshed = parseAxTargets(await listAxTargetsRaw(target, 50, signal));
	if (refreshed.length) {
		runtimeState.currentAxTargets = refreshed;
	}
	return refreshed;
}

async function reacquireAxTarget(stale: AxTarget, target: ResolvedTarget, signal?: AbortSignal): Promise<AxTarget | undefined> {
	const refreshed = await refreshAxTargets(target, signal);
	if (!refreshed.length) return undefined;

	const staleLabel = axTargetLabelKey(stale);
	const staleIdentifier = normalizeText(stale.identifier);
	const candidates = refreshed.filter((candidate) => {
		if (candidate.role !== stale.role) return false;
		if (staleIdentifier && normalizeText(candidate.identifier) !== staleIdentifier) return false;
		if (!staleIdentifier && staleLabel && axTargetLabelKey(candidate) !== staleLabel) return false;
		if (stale.canSetValue && !candidate.canSetValue) return false;
		if (stale.canPress && !candidate.canPress) return false;
		if (stale.canScroll && !candidate.canScroll) return false;
		if (stale.canIncrement && !candidate.canIncrement) return false;
		if (stale.canDecrement && !candidate.canDecrement) return false;
		return true;
	});
	const pool = candidates.length ? candidates : refreshed.filter((candidate) => staleIdentifier ? normalizeText(candidate.identifier) === staleIdentifier : staleLabel && axTargetLabelKey(candidate) === staleLabel);
	const best = pool.sort((a, b) => Math.hypot(a.x - stale.x, a.y - stale.y) - Math.hypot(b.x - stale.x, b.y - stale.y))[0];
	return best ? { ...best, ref: stale.ref } : undefined;
}

function hasOnlyBrowserChromeCoverage(result: CaptureResult): boolean {
	const hasChromeTargets = result.axTargets.some((target) => target.source === "browser_chrome_ax");
	const hasContentTargets = result.axTargets.some((target) => target.source === "web_content_ax");
	return (hasChromeTargets && !hasContentTargets) || result.axDiagnostics?.debug?.browserChromeOnly === true;
}

function imageFallbackReason(
	tool: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	imageMode: ImageMode = "auto",
): { reason: NonNullable<ComputerUseDetails["imageReason"]>; message: string } | undefined {
	if (imageMode === "never") return undefined;
	if (imageMode === "always") return { reason: "fallback_recovery", message: "An image was requested explicitly for visual verification." };
	if (execution.fallbackUsed === true) {
		return { reason: "fallback_recovery", message: "The action used a fallback path, so an image is attached for recovery." }
	}
	if (hasOnlyBrowserChromeCoverage(result)) {
		return { reason: "weak_ax_targets", message: "Accessibility exposed browser chrome targets but no web-content targets, so an image is attached for content fallback." }
	}
	if (result.axTargets.length === 0) {
		if (isBrowserApp(result.target.appName, result.target.bundleId) && result.axDiagnostics?.reason === "window_not_found") {
			return { reason: "browser_ax_window_unavailable", message: result.axDiagnostics.message ?? "The browser window could not be resolved through Accessibility, so an image is attached for recovery." }
		}
		return { reason: "no_ax_targets", message: "No useful AX targets were found, so an image is attached for vision fallback." }
	}
	const labels = result.axTargets.map((target) => normalizeText(target.title || target.description || target.value)).filter(Boolean)
	const unlabeledCount = result.axTargets.filter((target) => !normalizeText(target.title || target.description || target.value)).length
	const strongTextRoles = new Set(["AXTextField", "AXSearchField", "AXTextArea", "AXTextView", "AXEditableText", "AXComboBox"])
	const strongTargets = result.axTargets.filter((target) => {
		const label = normalizeText(target.title || target.description || target.value)
		return strongTextRoles.has(target.role) || (!!label && (target.actions.includes("AXPress") || target.role === "AXLink" || target.role === "AXButton" || target.role === "AXWebArea"))
	})
	if (result.axTargets.length < 3 && strongTargets.length === 0) {
		return { reason: "sparse_ax_targets", message: "Only a few AX targets were found, so an image is attached for extra context." }
	}
	if (strongTargets.length === 0) {
		return { reason: "weak_ax_targets", message: "No strong AX targets were found, so an image is attached for vision fallback." }
	}
	if (result.axTargets.length < 3 && !strongTargets.some((target) => strongTextRoles.has(target.role))) {
		return { reason: "sparse_ax_targets", message: "Only a few AX targets were found, so an image is attached for extra context." }
	}
	if (result.axTargets.length >= 3 && unlabeledCount * 2 > result.axTargets.length) {
		return { reason: "unlabeled_ax_targets", message: "Most AX targets are unlabeled, so an image is attached for vision fallback." }
	}
	if (labels.length > 3 && new Set(labels).size * 2 <= labels.length) {
		return { reason: "duplicated_ax_labels", message: "AX target labels are highly duplicated, so an image is attached for extra context." }
	}
	if (tool === "wait" && isBrowserApp(result.target.appName, result.target.bundleId)) {
		return { reason: "browser_wait_verification", message: "Browser content may have changed visually during wait, so an image is attached for fallback." }
	}
	return undefined
}

function currentTargetOrThrow(): CurrentTarget {
	if (!runtimeState.currentTarget) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	return runtimeState.currentTarget;
}

function emptyActivation(): ActivationFlags {
	return { activated: false, unminimized: false, raised: false };
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function runProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stderr = "";
		let stdout = "";

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
		}, timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			cleanup();
			reject(error);
		});

		child.on("close", (code) => {
			cleanup();
			if (code === 0) {
				resolve();
				return;
			}
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
		});

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}


async function ensureHelperInstalled(signal?: AbortSignal): Promise<void> {
	if ((await isExecutable(HELPER_APP_EXECUTABLE_PATH)) && runtimeState.helperInstallChecked) return;

	// process.execPath may be an Electron binary when this module runs inside an
	// Electron main process. Force ELECTRON_RUN_AS_NODE so the helper script runs
	// as plain Node instead of launching a GUI Electron app (which adds a dock
	// icon and never exits). No-op for a regular Node executable.
	await runProcess(process.execPath, [SETUP_HELPER_SCRIPT, "--runtime"], HELPER_SETUP_TIMEOUT_MS, signal, {
		...process.env,
		ELECTRON_RUN_AS_NODE: "1",
	});
	runtimeState.helperInstallChecked = true;

	if (!(await isExecutable(HELPER_APP_EXECUTABLE_PATH))) {
		throw new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`);
	}
}


async function launchHelperDaemon(signal?: AbortSignal): Promise<void> {
	await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
	await runProcess("open", ["-n", "-g", HELPER_APP_PATH, "--args", "serve", "--socket", HELPER_SOCKET_PATH], COMMAND_TIMEOUT_MS, signal);
}

async function daemonCommand<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const id = `req_${++runtimeState.requestSequence}`;
		const socket = net.createConnection(HELPER_SOCKET_PATH);
		let buffer = "";
		const timer = setTimeout(() => { socket.destroy(); reject(new HelperTransportError(`Daemon command '${cmd}' timed out after ${timeoutMs}ms.`)); }, timeoutMs);
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
		const onAbort = () => { socket.destroy(); cleanup(); reject(new Error("Operation aborted.")); };
		signal?.addEventListener("abort", onAbort, { once: true });
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			cleanup();
			socket.end();
			try {
				const parsed = JSON.parse(buffer.slice(0, newline));
				if (parsed.ok === true) resolve(parsed.result as T);
				else reject(new HelperCommandError(parsed?.error?.message ?? `Daemon command '${cmd}' failed.`, parsed?.error?.code));
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", (error) => { cleanup(); reject(new HelperTransportError(error.message)); });
	});
}

async function ensureDaemon(signal?: AbortSignal): Promise<boolean> {
	if (runtimeState.daemonAvailable) return true;
	try {
		await daemonCommand("diagnostics", {}, 1_000, signal);
		runtimeState.daemonAvailable = true;
		return true;
	} catch {}
	await launchHelperDaemon(signal).catch(() => undefined);
	for (let index = 0; index < 30; index += 1) {
		try {
			await daemonCommand("diagnostics", {}, 1_000, signal);
			runtimeState.daemonAvailable = true;
			return true;
		} catch {
			await sleep(100, signal);
		}
	}
	return false;
}

async function bridgeCommand<T>(
	cmd: string,
	args: Record<string, unknown> = {},
	options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
	const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
	if (!(await ensureDaemon(options?.signal))) {
		throw new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`);
	}
	try {
		return await daemonCommand<T>(cmd, args, timeoutMs, options?.signal);
	} catch (error) {
		runtimeState.daemonAvailable = false;
		throw normalizeError(error);
	}
}


async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
	const result = await bridgeCommand<any>("checkPermissions", {}, { signal });
	return {
		accessibility: toBoolean(result?.accessibility),
		screenRecording: toBoolean(result?.screenRecording),
	};
}

async function helperDiagnostics(signal?: AbortSignal): Promise<HelperDiagnostics> {
	const result = await bridgeCommand<any>("diagnostics", {}, { signal });
	return {
		protocolVersion: Math.trunc(toFiniteNumber(result?.protocolVersion, 0)),
		pid: Math.trunc(toFiniteNumber(result?.pid, 0)),
		parentPid: Math.trunc(toFiniteNumber(result?.parentPid, 0)) || undefined,
		parentAppName: toOptionalString(result?.parentAppName),
		parentBundleId: toOptionalString(result?.parentBundleId),
		parentPath: toOptionalString(result?.parentPath),
		executablePath: toOptionalString(result?.executablePath),
		macOS: toOptionalString(result?.macOS),
		arch: toOptionalString(result?.arch),
		accessibility: toBoolean(result?.accessibility),
		screenRecording: toBoolean(result?.screenRecording),
	};
}

async function ensureHelperProtocol(signal?: AbortSignal): Promise<void> {
	const diagnostics = await helperDiagnostics(signal);
	runtimeState.helperDiagnostics = diagnostics;
	if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) {
		stopBridge();
		throw new Error(`pi-computer-use helper protocol mismatch: expected ${HELPER_PROTOCOL_VERSION}, got ${diagnostics.protocolVersion}. Restart Pi so the updated helper can be loaded.`);
	}
}

async function ensureReady(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	loadComputerUseConfig(ctx.cwd);

	if (process.platform !== "darwin") {
		throw new Error(NON_MACOS_ERROR);
	}

	throwIfAborted(signal);
	await ensureHelperInstalled(signal);
	if (!(await ensureDaemon(signal))) {
		throw new Error(`pi-computer-use helper app daemon did not start. Helper app: ${HELPER_APP_PATH}`);
	}
	await ensureHelperProtocol(signal);

	const now = Date.now();
	const canUseCachedPermissions =
		runtimeState.permissionStatus &&
		runtimeState.permissionStatus.accessibility &&
		runtimeState.permissionStatus.screenRecording &&
		now - runtimeState.lastPermissionCheckAt < 2_000;
	if (canUseCachedPermissions) {
		return;
	}

	let status = await checkPermissions(signal);
	runtimeState.permissionStatus = status;
	runtimeState.lastPermissionCheckAt = now;

	if (!status.accessibility || !status.screenRecording) {
		const permissionPath = HELPER_APP_PATH;
		const parentHint = runtimeState.helperDiagnostics?.parentAppName
			? `Launcher: ${runtimeState.helperDiagnostics.parentAppName}${runtimeState.helperDiagnostics.parentBundleId ? ` (${runtimeState.helperDiagnostics.parentBundleId})` : ""}. On some macOS versions Screen Recording may also need to remain enabled for this launcher.`
			: undefined;
		status = await ensurePermissions(
			ctx,
			{
				checkPermissions: (permissionSignal) => checkPermissions(permissionSignal ?? signal),
				openPermissionPane: async (kind, permissionSignal) => {
					await bridgeCommand("openPermissionPane", { kind }, { signal: permissionSignal ?? signal });
				},
				copyHelperPathToClipboard: async (permissionSignal) => {
					await runProcess("osascript", ["-e", `set the clipboard to "${escapeAppleScriptString(permissionPath)}"`], COMMAND_TIMEOUT_MS, permissionSignal ?? signal);
				},
				permissionHint: parentHint,
			},
			permissionPath,
			signal,
		);
	}

	runtimeState.permissionStatus = status;
	runtimeState.lastPermissionCheckAt = Date.now();
}

export async function ensureComputerUseSetup(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	await ensureReady(ctx, signal);
}

function parseApps(result: unknown): HelperApp[] {
	const array = Array.isArray(result) ? result : (result as any)?.apps;
	if (!Array.isArray(array)) return [];

	return array
		.map((raw) => {
			const pid = Math.trunc(toFiniteNumber((raw as any)?.pid, NaN));
			if (!Number.isFinite(pid) || pid <= 0) return undefined;
			const appName = toOptionalString((raw as any)?.appName) ?? "Unknown App";
			return {
				appName,
				bundleId: toOptionalString((raw as any)?.bundleId),
				pid,
				isFrontmost: toBoolean((raw as any)?.isFrontmost),
			} as HelperApp;
		})
		.filter((item): item is HelperApp => Boolean(item));
}

function parseFramePoints(raw: unknown): FramePoints {
	const frame = (raw as any)?.framePoints ?? {};
	return {
		x: toFiniteNumber(frame.x, 0),
		y: toFiniteNumber(frame.y, 0),
		w: Math.max(1, toFiniteNumber(frame.w, 1)),
		h: Math.max(1, toFiniteNumber(frame.h, 1)),
	};
}

function parseOptionalFramePoints(raw: unknown): FramePoints | undefined {
	const frame = raw as Partial<FramePoints> | undefined;
	if (!frame || ![frame.x, frame.y, frame.w, frame.h].every(Number.isFinite)) return undefined;
	return { x: Number(frame.x), y: Number(frame.y), w: Math.max(1, Number(frame.w)), h: Math.max(1, Number(frame.h)) };
}

function parseWindows(result: unknown): HelperWindow[] {
	const array = Array.isArray(result) ? result : (result as any)?.windows;
	if (!Array.isArray(array)) return [];

	return array.map((raw) => ({
		windowId: Number.isFinite((raw as any)?.windowId) ? Math.trunc((raw as any).windowId) : undefined,
		windowRef: toOptionalString((raw as any)?.windowRef),
		title: toOptionalString((raw as any)?.title) ?? "",
		role: toOptionalString((raw as any)?.role),
		subrole: toOptionalString((raw as any)?.subrole),
		framePoints: parseFramePoints(raw),
		scaleFactor: Math.max(1, toFiniteNumber((raw as any)?.scaleFactor, 1)),
		isMinimized: toBoolean((raw as any)?.isMinimized),
		isOnscreen: toBoolean((raw as any)?.isOnscreen),
		isMain: toBoolean((raw as any)?.isMain),
		isFocused: toBoolean((raw as any)?.isFocused),
		isModal: toBoolean((raw as any)?.isModal),
		sheetCount: Math.max(0, Math.trunc(toFiniteNumber((raw as any)?.sheetCount, 0))),
	}));
}

async function listApps(signal?: AbortSignal): Promise<HelperApp[]> {
	const result = await bridgeCommand<unknown>("listApps", {}, { signal });
	return parseApps(result);
}

async function listWindows(pid: number, signal?: AbortSignal): Promise<HelperWindow[]> {
	const result = await bridgeCommand<unknown>("listWindows", { pid }, { signal });
	return parseWindows(result);
}

function appMatchesWindowQuery(app: HelperApp, query: ListWindowsParams): boolean {
	const appQuery = trimOrUndefined(query.app);
	const bundleQuery = trimOrUndefined(query.bundleId);
	const pidQuery = Number.isFinite(query.pid) ? Math.trunc(query.pid!) : undefined;

	if (pidQuery !== undefined && app.pid !== pidQuery) return false;
	if (bundleQuery && normalizeText(app.bundleId ?? "") !== normalizeText(bundleQuery)) return false;
	if (appQuery && !normalizeText(app.appName).includes(normalizeText(appQuery))) return false;
	return true;
}

function formatAppLine(app: ListAppsDetails["apps"][number]): string {
	const flags = [app.isFrontmost ? "frontmost" : undefined, app.browserUseAllowed ? undefined : "browser_use_disabled"]
		.filter(Boolean)
		.join(", ");
	return `- ${app.app}${app.bundleId ? ` (${app.bundleId})` : ""}, pid ${app.pid}${flags ? ` [${flags}]` : ""}`;
}

function formatWindowLine(window: ListWindowsDetails["windows"][number]): string {
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isModal ? "modal" : undefined,
		window.sheetCount > 0 ? `sheets=${window.sheetCount}` : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
		window.browserUseAllowed ? undefined : "browser_use_disabled",
	]
		.filter(Boolean)
		.join(", ");
	const frame = `${Math.round(window.framePoints.x)},${Math.round(window.framePoints.y)} ${Math.round(window.framePoints.w)}x${Math.round(window.framePoints.h)}`;
	const id = window.windowId ? `windowId ${window.windowId}` : window.nativeWindowRef ? `nativeWindowRef ${window.nativeWindowRef}` : "unstable window id";
	return `- ${window.windowRef} ${window.app} — ${window.windowTitle || "(untitled)"} (${id}, pid ${window.pid}, frame ${frame}, score ${window.score}${flags ? `, ${flags}` : ""})`;
}

async function getFrontmost(signal?: AbortSignal): Promise<FrontmostResult> {
	const result = await bridgeCommand<any>("getFrontmost", {}, { signal });
	const pid = Math.trunc(toFiniteNumber(result?.pid, NaN));
	if (!Number.isFinite(pid) || pid <= 0) {
		throw new Error("No frontmost app was available for screenshot targeting.");
	}

	return {
		appName: toOptionalString(result?.appName) ?? "Unknown App",
		bundleId: toOptionalString(result?.bundleId),
		pid,
		windowTitle: toOptionalString(result?.windowTitle),
		windowId: Number.isFinite(result?.windowId) ? Math.trunc(result.windowId) : undefined,
	};
}

async function focusControlledWindow(target: ResolvedTarget, signal?: AbortSignal): Promise<void> {
	const result = await bridgeCommand<FocusWindowResult>(
		"focusWindow",
		nativeWindowRequest(target),
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	if (!toBoolean(result?.focused)) {
		throw new Error(
			`Unable to focus controlled window '${target.windowTitle}' before input${result?.reason ? `: ${result.reason}` : "."}`,
		);
	}
}

function isBrowserApp(appName: string, bundleId?: string): boolean {
	return BROWSER_BUNDLE_IDS.has(bundleId ?? "") || BROWSER_APP_NAMES.has(normalizeText(appName));
}

function isChromeFamilyApp(appName: string, bundleId?: string): boolean {
	return CHROME_FAMILY_BUNDLE_IDS.has(bundleId ?? "") || CHROME_FAMILY_APP_NAMES.has(normalizeText(appName));
}

function assertBrowserUseAllowed(target: { appName: string; bundleId?: string }): void {
	if (!isBrowserUseEnabled() && isBrowserApp(target.appName, target.bundleId)) {
		throw new Error(
			`Browser use is disabled by pi-computer-use config, so '${target.appName}' cannot be controlled. Enable browser_use in ~/.pi/agent/extensions/pi-computer-use.json or .pi/computer-use.json to allow browser windows.`,
		);
	}
}

function windowRecordIdentity(record: Pick<WindowRefRecord, "pid" | "windowId" | "nativeWindowRef" | "windowTitle" | "framePoints">): string {
	if (record.windowId && record.windowId > 0) {
		return `pid:${record.pid}|id:${record.windowId}`;
	}
	if (record.nativeWindowRef) {
		return `pid:${record.pid}|ref:${record.nativeWindowRef}`;
	}
	const { x, y, w, h } = record.framePoints;
	return `pid:${record.pid}|title:${normalizeText(record.windowTitle)}|frame:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

function storeWindowRef(record: Omit<WindowRefRecord, "ref">): WindowRefRecord {
	const identity = windowRecordIdentity(record);
	const existingRef = runtimeState.windowRefByIdentity.get(identity);
	if (existingRef) {
		const existing = runtimeState.windowRefs.get(existingRef);
		if (existing) {
			const updated = { ...record, ref: existingRef };
			runtimeState.windowRefs.set(existingRef, updated);
			return updated;
		}
	}

	const ref = `@w${runtimeState.nextWindowRefIndex++}`;
	const stored = { ...record, ref };
	runtimeState.windowRefByIdentity.set(identity, ref);
	runtimeState.windowRefs.set(ref, stored);
	return stored;
}

function storeWindowRefForTarget(target: ResolvedTarget): string {
	return storeWindowRef({
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
		windowTitle: target.windowTitle,
		windowId: target.windowId > 0 ? target.windowId : undefined,
		framePoints: target.framePoints,
		scaleFactor: target.scaleFactor,
		isMinimized: target.isMinimized,
		isOnscreen: target.isOnscreen,
		isMain: target.isMain,
		isFocused: target.isFocused,
	}).ref;
}

function storeWindowRefForAppWindow(app: HelperApp, window: HelperWindow): WindowRefRecord {
	return storeWindowRef({
		appName: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		windowTitle: window.title || "(untitled)",
		windowId: window.windowId,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
	});
}

function escapeAppleScriptString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function runAppleScript(lines: string[], signal?: AbortSignal): Promise<void> {
	const args = lines.flatMap((line) => ["-e", line]);
	try {
		await runProcess("osascript", args, BROWSER_WINDOW_OPEN_TIMEOUT_MS, signal);
	} catch (error) {
		throw appendBrowserJavaScriptAppleEventsHint(normalizeError(error));
	}
}

function browserOpenLocationAppleScript(target: ResolvedTarget, url: string): string[] | undefined {
	if (!isBrowserApp(target.appName, target.bundleId)) return undefined;
	const appTarget = target.bundleId
		? `application id "${escapeAppleScriptString(target.bundleId)}"`
		: `application "${escapeAppleScriptString(target.appName)}"`;
	const escapedUrl = escapeAppleScriptString(url);
	const normalizedName = normalizeText(target.appName);
	if (target.bundleId === "com.apple.Safari" || normalizedName === "safari") {
		return [`tell ${appTarget} to set URL of front document to "${escapedUrl}"`];
	}
	if (isChromeFamilyApp(target.appName, target.bundleId)) {
		return [`tell ${appTarget} to set URL of active tab of front window to "${escapedUrl}"`];
	}
	return undefined;
}

async function openBrowserLocationFromPendingAddress(keys: string[], target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	const isEnter = keys.length === 1 && ["enter", "return"].includes(keys[0]?.trim().toLowerCase());
	const pending = runtimeState.pendingBrowserAddress;
	if (!pending) return false;
	if (!isEnter) {
		runtimeState.pendingBrowserAddress = undefined;
		return false;
	}
	if (pending.pid !== target.pid || pending.windowId !== target.windowId) {
		runtimeState.pendingBrowserAddress = undefined;
		return false;
	}
	const script = browserOpenLocationAppleScript(target, pending.text);
	if (!script) return false;
	runtimeState.pendingBrowserAddress = undefined;
	await runAppleScript(script, signal);
	return true;
}

function choosePreferredWindow(windows: HelperWindow[], appName: string): HelperWindow {
	if (!windows.length) {
		throw new Error(`No controllable window was found in app '${appName}'.`);
	}

	const scored = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	return scored[0];
}

function isDialogLikeWindow(window: Pick<HelperWindow, "subrole" | "role">): boolean {
	return /dialog|modal|sheet/i.test(`${window.role ?? ""} ${window.subrole ?? ""}`);
}

function scoreWindow(window: HelperWindow): number {
	let score = 0;
	if (window.isModal || isDialogLikeWindow(window)) score += 180;
	if (window.sheetCount > 0) score += 160;
	if (window.isFocused) score += 100;
	if (window.isMain) score += 80;
	if (!window.isMinimized) score += 40;
	if (window.isOnscreen) score += 20;
	if (window.windowId && window.windowId > 0) score += 10;
	if (window.title.trim().length > 0) score += 2;
	return score;
}

function summarizeWindowCandidate(window: HelperWindow): string {
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
	]
		.filter(Boolean)
		.join(",");
	return `${window.title || "(untitled)"} [score=${scoreWindow(window)}${flags ? `, ${flags}` : ""}]`;
}

function summarizeWindowCandidates(windows: HelperWindow[], limit = 6): string {
	return [...windows]
		.sort((a, b) => scoreWindow(b) - scoreWindow(a))
		.slice(0, limit)
		.map(summarizeWindowCandidate)
		.join("; ");
}

function chooseRankedWindowOrUndefined(windows: HelperWindow[]): HelperWindow | undefined {
	if (windows.length === 0) return undefined;
	const ranked = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	if (ranked.length === 1) return ranked[0];
	const topScore = scoreWindow(ranked[0]);
	const nextScore = scoreWindow(ranked[1]);
	return topScore >= nextScore + 25 ? ranked[0] : undefined;
}

function chooseAppByQuery(apps: HelperApp[], appQuery: string): HelperApp {
	const query = normalizeText(appQuery);
	const exactMatches = apps.filter((app) => normalizeText(app.appName) === query);
	if (exactMatches.length === 1) return exactMatches[0];
	if (exactMatches.length > 1) {
		return exactMatches.find((app) => app.isFrontmost) ?? exactMatches[0];
	}

	const partialMatches = apps.filter((app) => normalizeText(app.appName).includes(query));
	if (partialMatches.length === 0) {
		const running = apps.slice(0, 12).map((app) => app.appName).join(", ");
		throw new Error(`App '${appQuery}' is not running. Running apps: ${running || "none"}.`);
	}
	if (partialMatches.length === 1) {
		return partialMatches[0];
	}

	const candidates = partialMatches.map((app) => app.appName).join(", ");
	throw new Error(`App name '${appQuery}' is ambiguous (${candidates}). Use a more specific app name.`);
}

function chooseWindowByTitle(windows: HelperWindow[], windowTitle: string, appName: string): HelperWindow {
	const query = normalizeText(windowTitle);
	const exactMatches = windows.filter((window) => normalizeText(window.title) === query);
	if (exactMatches.length === 1) return exactMatches[0];
	if (exactMatches.length > 1) {
		const clearWinner = chooseRankedWindowOrUndefined(exactMatches);
		if (clearWinner) return clearWinner;
		throw new Error(
			`Window title '${windowTitle}' is ambiguous in app '${appName}'. Candidates: ${summarizeWindowCandidates(exactMatches)}.`,
		);
	}

	const partialMatches = windows.filter((window) => normalizeText(window.title).includes(query));
	if (partialMatches.length === 0) {
		throw new Error(
			`Window '${windowTitle}' was not found in app '${appName}'. Available windows: ${summarizeWindowCandidates(windows)}.`,
		);
	}
	if (partialMatches.length === 1) return partialMatches[0];
	const clearWinner = chooseRankedWindowOrUndefined(partialMatches);
	if (clearWinner) return clearWinner;

	throw new Error(
		`Window title '${windowTitle}' is ambiguous in app '${appName}'. Candidates: ${summarizeWindowCandidates(partialMatches)}.`,
	);
}

function toResolvedTarget(app: HelperApp, window: HelperWindow): ResolvedTarget {
	const baseTarget = {
		appName: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		windowTitle: window.title || "(untitled)",
		windowId: typeof window.windowId === "number" ? window.windowId : 0,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
	};
	return { ...baseTarget, windowRef: storeWindowRefForAppWindow(app, window).ref };
}

function nativeWindowRequest(target: Pick<CurrentTarget, "pid" | "windowId" | "nativeWindowRef">): { pid: number; windowId: number; windowRef?: string } {
	return { pid: target.pid, windowId: target.windowId, windowRef: target.nativeWindowRef };
}

function setCurrentTarget(target: ResolvedTarget): void {
	assertBrowserUseAllowed(target);
	const windowRef = target.windowRef ?? storeWindowRefForTarget(target);
	runtimeState.currentTarget = {
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
		windowTitle: target.windowTitle,
		windowId: target.windowId,
		windowRef,
		nativeWindowRef: target.nativeWindowRef,
	};
}

function normalizeWindowSelector(selector: WindowSelector | undefined): string | undefined {
	if (typeof selector === "number" && Number.isFinite(selector)) return String(Math.trunc(selector));
	if (typeof selector === "string") return trimOrUndefined(selector);
	return undefined;
}

async function resolveTargetByWindowSelector(selector: WindowSelector, signal?: AbortSignal): Promise<ResolvedTarget> {
	const normalized = normalizeWindowSelector(selector);
	if (!normalized) {
		throw new Error("window target must be a non-empty @w ref or numeric windowId.");
	}

	const current = runtimeState.currentTarget;
	if (current?.windowRef === normalized) {
		return await resolveCurrentTarget(signal);
	}

	const fromRef = runtimeState.windowRefs.get(normalized);
	if (fromRef) {
		const app: HelperApp = { appName: fromRef.appName, bundleId: fromRef.bundleId, pid: fromRef.pid };
		const windows = await listWindows(fromRef.pid, signal);
		const match =
			(fromRef.windowId ? windows.find((window) => window.windowId === fromRef.windowId) : undefined) ??
			(fromRef.nativeWindowRef ? windows.find((window) => window.windowRef === fromRef.nativeWindowRef) : undefined) ??
			windows.find((window) => normalizeText(window.title || "(untitled)") === normalizeText(fromRef.windowTitle));
		if (!match) {
			throw new Error(`Window ref '${normalized}' is stale. Call list_windows again and choose a current window.`);
		}
		const resolved = toResolvedTarget(app, match);
		setCurrentTarget(resolved);
		return resolved;
	}

	const numericWindowId = Number(normalized);
	if (Number.isInteger(numericWindowId) && numericWindowId > 0) {
		const apps = await listApps(signal);
		for (const app of apps) {
			const windows = await listWindows(app.pid, signal);
			const match = windows.find((window) => window.windowId === numericWindowId);
			if (match) {
				assertBrowserUseAllowed(app);
				const resolved = toResolvedTarget(app, match);
				setCurrentTarget(resolved);
				return resolved;
			}
		}
		throw new Error(`Window id '${numericWindowId}' was not found. Call list_windows again and choose a current window.`);
	}

	if (normalized.startsWith("@w")) {
		throw new Error(`Window ref '${normalized}' is not available in this session. Call list_windows first.`);
	}
	throw new Error(`Unsupported window target '${normalized}'. Use a @w ref from list_windows or a numeric windowId.`);
}

async function selectWindowIfProvided(selector: WindowSelector | undefined, signal?: AbortSignal): Promise<void> {
	if (!normalizeWindowSelector(selector)) return;
	const previous = runtimeState.currentTarget;
	const selected = await resolveTargetByWindowSelector(selector!, signal);
	const changedWindow =
		!previous ||
		previous.pid !== selected.pid ||
		(previous.windowId > 0 && selected.windowId > 0 ? previous.windowId !== selected.windowId : previous.windowRef !== selected.windowRef);
	if (changedWindow) {
		runtimeState.currentCapture = undefined;
		runtimeState.currentAxTargets = undefined;
	}
}

function shouldPreferForegroundModalWindow(current: HelperWindow, candidate: HelperWindow): boolean {
	if (candidate.windowId === current.windowId && candidate.windowRef === current.windowRef) return false;
	if (!candidate.isOnscreen || candidate.isMinimized) return false;
	if (candidate.isModal || candidate.sheetCount > 0 || isDialogLikeWindow(candidate)) return scoreWindow(candidate) >= scoreWindow(current);
	return false;
}

async function resolveCurrentTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
	const current = currentTargetOrThrow();
	const windows = await listWindows(current.pid, signal);
	if (!windows.length) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const hadStableWindowId = current.windowId > 0;
	const titleQuery = normalizeText(current.windowTitle);
	let match = hadStableWindowId ? windows.find((window) => window.windowId !== undefined && window.windowId === current.windowId) : undefined;
	if (!match) {
		const exactTitleMatches = titleQuery && titleQuery !== "(untitled)" ? windows.filter((window) => normalizeText(window.title) === titleQuery) : [];
		if (exactTitleMatches.length === 1) {
			match = exactTitleMatches[0];
		} else if (exactTitleMatches.length > 1) {
			match = chooseRankedWindowOrUndefined(exactTitleMatches);
			if (!match) {
				throw new Error(
					`${CURRENT_TARGET_GONE_ERROR} Multiple windows now match '${current.windowTitle}': ${summarizeWindowCandidates(exactTitleMatches)}.`,
				);
			}
		}
	}

	if (!match && !hadStableWindowId) {
		match = chooseRankedWindowOrUndefined(windows);
	}

	if (!match) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const modal = windows
		.filter((window) => shouldPreferForegroundModalWindow(match!, window))
		.sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
	if (modal) match = modal;

	const app: HelperApp = {
		appName: current.appName,
		bundleId: current.bundleId,
		pid: current.pid,
	};

	const resolved = toResolvedTarget(app, match);
	setCurrentTarget(resolved);
	return resolved;
}

async function resolveFrontmostTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
	const frontmost = await getFrontmost(signal);
	const apps = await listApps(signal);
	const app = apps.find((candidate) => candidate.pid === frontmost.pid) ?? {
		appName: frontmost.appName,
		bundleId: frontmost.bundleId,
		pid: frontmost.pid,
	};

	const windows = await listWindows(frontmost.pid, signal);
	if (!windows.length) {
		throw new Error("No frontmost controllable window was found. Open an app window and call screenshot again.");
	}

	if (isBrowserApp(app.appName, app.bundleId)) {
		assertBrowserUseAllowed(app);
	}

	let selected = windows.find((window) => window.windowId !== undefined && window.windowId === frontmost.windowId);
	if (!selected && frontmost.windowTitle) {
		selected = windows.find((window) => normalizeText(window.title) === normalizeText(frontmost.windowTitle));
	}
	selected ??= choosePreferredWindow(windows, app.appName);

	const resolved = toResolvedTarget(app, selected);
	setCurrentTarget(resolved);
	return resolved;
}

function matchesScreenshotSelection(target: ResolvedTarget, selection: ScreenshotParams): boolean {
	const windowQuery = normalizeWindowSelector(selection.window);
	if (windowQuery) {
		if (target.windowRef === windowQuery) return true;
		const numeric = Number(windowQuery);
		return Number.isInteger(numeric) && numeric > 0 && target.windowId === numeric;
	}
	const appQuery = trimOrUndefined(selection.app);
	const windowTitleQuery = trimOrUndefined(selection.windowTitle);
	if (appQuery && !normalizeText(target.appName).includes(normalizeText(appQuery))) {
		return false;
	}
	if (windowTitleQuery && normalizeText(target.windowTitle) !== normalizeText(windowTitleQuery)) {
		return false;
	}
	return true;
}

async function resolveTargetForScreenshot(selection: ScreenshotParams, signal?: AbortSignal): Promise<ResolvedTarget> {
	const appQuery = trimOrUndefined(selection.app);
	const windowTitleQuery = trimOrUndefined(selection.windowTitle);

	if (!appQuery && !windowTitleQuery) {
		if (runtimeState.currentTarget) {
			return await resolveCurrentTarget(signal);
		}
		return await resolveFrontmostTarget(signal);
	}

	const apps = await listApps(signal);

	if (appQuery) {
		const app = chooseAppByQuery(apps, appQuery);
		assertBrowserUseAllowed(app);
		let windows = await listWindows(app.pid, signal);
		if (!windows.length) {
			throw new Error(`No controllable window was found in app '${app.appName}'.`);
		}

		let window: HelperWindow;
		if (windowTitleQuery) {
			window = chooseWindowByTitle(windows, windowTitleQuery, app.appName);
		} else if (isBrowserApp(app.appName, app.bundleId)) {
			const current = runtimeState.currentTarget;
			const currentBrowserWindow =
				current && current.pid === app.pid ? windows.find((candidate) => candidate.windowId === current.windowId) : undefined;
			window = currentBrowserWindow ?? choosePreferredWindow(windows, app.appName);
		} else {
			window = choosePreferredWindow(windows, app.appName);
		}

		const resolved = toResolvedTarget(app, window);
		setCurrentTarget(resolved);
		return resolved;
	}

	const query = windowTitleQuery!;
	const exactMatches: Array<{ app: HelperApp; window: HelperWindow }> = [];
	const partialMatches: Array<{ app: HelperApp; window: HelperWindow }> = [];

	for (const app of apps) {
		const windows = await listWindows(app.pid, signal);
		for (const window of windows) {
			const title = normalizeText(window.title);
			if (!title) continue;
			if (title === normalizeText(query)) {
				exactMatches.push({ app, window });
			} else if (title.includes(normalizeText(query))) {
				partialMatches.push({ app, window });
			}
		}
	}

	const matches = exactMatches.length > 0 ? exactMatches : partialMatches;
	if (matches.length === 0) {
		throw new Error(`Window '${query}' was not found in any running app.`);
	}
	if (matches.length > 1) {
		const ranked = [...matches].sort((a, b) => scoreWindow(b.window) - scoreWindow(a.window));
		if (ranked.length > 1 && scoreWindow(ranked[0].window) >= scoreWindow(ranked[1].window) + 25) {
			const resolved = toResolvedTarget(ranked[0].app, ranked[0].window);
			setCurrentTarget(resolved);
			return resolved;
		}
		const options = ranked
			.slice(0, 6)
			.map((match) => `${match.app.appName} — ${summarizeWindowCandidate(match.window)}`)
			.join(", ");
		throw new Error(`Window title '${query}' is ambiguous (${options}). Specify app as well.`);
	}

	const resolved = toResolvedTarget(matches[0].app, matches[0].window);
	setCurrentTarget(resolved);
	return resolved;
}

async function ensureTargetWindowId(target: ResolvedTarget, signal?: AbortSignal): Promise<ResolvedTarget> {
	if (target.windowId > 0) {
		return target;
	}

	const refreshed = await resolveCurrentTarget(signal);
	if (refreshed.windowId <= 0) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}
	return refreshed;
}

async function helperScreenshot(windowId: number, signal?: AbortSignal, maxDimension?: number): Promise<ScreenshotPayload> {
	const result = await bridgeCommand<any>(
		"screenshot",
		{ windowId, maxDimension },
		{ timeoutMs: SCREENSHOT_TIMEOUT_MS, signal },
	);

	const base64 = toOptionalString(result?.pngBase64);
	if (!base64) {
		throw new Error("Helper returned an invalid screenshot payload.");
	}

	return {
		pngBase64: base64,
		width: Math.max(1, Math.trunc(toFiniteNumber(result?.width, 1))),
		height: Math.max(1, Math.trunc(toFiniteNumber(result?.height, 1))),
		scaleFactor: Math.max(1, toFiniteNumber(result?.scaleFactor, 1)),
	};
}

async function helperVisionTargets(windowId: number, signal?: AbortSignal, maxDimension?: number): Promise<VisionTarget[]> {
	const result = await bridgeCommand<unknown>("visionTargets", { windowId, maxDimension }, { timeoutMs: SCREENSHOT_TIMEOUT_MS + 8_000, signal }).catch(() => undefined);
	return parseVisionTargets(result);
}

function windowsByCaptureRecoveryPriority(
	windows: HelperWindow[],
	target: ResolvedTarget,
	failureCode: string,
): HelperWindow[] {
	const sorted = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	if (failureCode !== "screenshot_timeout") {
		return sorted;
	}

	const alternatives = sorted.filter((window) => window.windowId !== target.windowId);
	const original = sorted.filter((window) => window.windowId === target.windowId);
	return [...alternatives, ...original];
}

async function recoverCaptureFromHelperFailure(
	target: ResolvedTarget,
	error: HelperCommandError,
	signal?: AbortSignal,
	maxDimension?: number,
): Promise<{ target: ResolvedTarget; image: ScreenshotPayload }> {
	const windows = await listWindows(target.pid, signal);
	if (!windows.length) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const app: HelperApp = {
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
	};

	const orderedWindows = windowsByCaptureRecoveryPriority(windows, target, error.code ?? "");
	const candidates = orderedWindows.filter((window) => typeof window.windowId === "number" && window.windowId > 0).slice(0, 3);
	if (!candidates.length) {
		throw normalizeError(error);
	}

	let lastError: Error = normalizeError(error);
	for (const candidateWindow of candidates) {
		const candidateTarget = toResolvedTarget(app, candidateWindow);
		try {
			const image = await helperScreenshot(candidateTarget.windowId, signal, maxDimension);
			return { target: candidateTarget, image };
		} catch (candidateError) {
			if (!isRecoverableScreenshotError(candidateError)) {
				throw normalizeError(candidateError);
			}
			lastError = normalizeError(candidateError);
		}
	}

	throw lastError;
}

interface CaptureResult {
	target: ResolvedTarget;
	capture: CurrentCapture;
	image?: ScreenshotPayload;
	axTargets: AxTarget[];
	visionTargets?: VisionTarget[];
	axDiagnostics?: { reason?: string; message?: string; debug?: AxDiagnosticsDebug };
	activation: ActivationFlags;
}

function captureForTarget(target: ResolvedTarget): CurrentCapture {
	return {
		stateId: randomUUID(),
		width: Math.max(1, Math.round(target.framePoints.w * target.scaleFactor)),
		height: Math.max(1, Math.round(target.framePoints.h * target.scaleFactor)),
		scaleFactor: target.scaleFactor,
		timestamp: Date.now(),
	};
}

async function ensureCaptureImage(result: CaptureResult, signal?: AbortSignal, maxDimension = AUTO_IMAGE_MAX_DIMENSION): Promise<void> {
	if (result.image) return;
	try {
		result.image = await helperScreenshot(result.target.windowId, signal, maxDimension);
		result.capture.width = result.image.width;
		result.capture.height = result.image.height;
		result.capture.scaleFactor = result.image.scaleFactor;
	} catch (error) {
		if (!isRecoverableScreenshotError(error)) {
			const normalized = normalizeError(error);
			if (isBrowserApp(result.target.appName, result.target.bundleId)) {
				throw new Error(`${normalized.message} Browser capture failed for ${result.target.appName} window '${result.target.windowTitle}'. Call list_windows and retry screenshot with an explicit existing content window ref, or use navigate_browser for direct URL navigation.`);
			}
			throw normalized;
		}
		const recovered = await recoverCaptureFromHelperFailure(result.target, error, signal, maxDimension);
		result.target = recovered.target;
		result.image = recovered.image;
		result.capture.width = recovered.image.width;
		result.capture.height = recovered.image.height;
		result.capture.scaleFactor = recovered.image.scaleFactor;
		const axResult = await listAxTargetsRaw(result.target, 12, signal);
		result.axTargets = parseAxTargets(axResult);
		result.axDiagnostics = axDiagnosticsFromResult(axResult, result.target);
	}
	setCurrentTarget(result.target);
	runtimeState.currentCapture = result.capture;
	runtimeState.currentStateTarget = { pid: result.target.pid, windowId: result.target.windowId, windowRef: result.target.windowRef };
	runtimeState.currentAxTargets = result.axTargets;
}

async function captureCurrentTarget(signal?: AbortSignal): Promise<CaptureResult> {
	let target = await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);

	const capture = captureForTarget(target);
	const axResult = await listAxTargetsRaw(target, 12, signal);
	const axTargets = parseAxTargets(axResult);
	const axDiagnostics = axDiagnosticsFromResult(axResult, target);

	setCurrentTarget(target);
	runtimeState.currentCapture = capture;
	runtimeState.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	runtimeState.currentAxTargets = axTargets;

	return {
		target,
		capture,
		axTargets,
		axDiagnostics,
		activation: emptyActivation(),
	};
}

async function buildToolResult(
	tool: string,
	summary: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	signal?: AbortSignal,
	imageMode: ImageMode = runtimeState.currentImageMode ?? "auto",
): Promise<AgentToolResult<ComputerUseDetails>> {
	const fallbackReason = imageFallbackReason(tool, result, execution, imageMode);
	if (fallbackReason) {
		await ensureCaptureImage(result, signal, imageMode === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION);
	}
	if ((fallbackReason || imageMode === "always") && !result.visionTargets?.length && result.target.windowId > 0) {
		result.visionTargets = await helperVisionTargets(result.target.windowId, signal, imageMode === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION);
	}
	runtimeState.currentVisionTargets = result.visionTargets;

	const details: ComputerUseDetails = {
		tool,
		target: {
			app: result.target.appName,
			bundleId: result.target.bundleId,
			pid: result.target.pid,
			windowTitle: result.target.windowTitle,
			windowId: result.target.windowId,
			windowRef: result.target.windowRef ?? runtimeState.currentTarget?.windowRef,
			nativeWindowRef: result.target.nativeWindowRef ?? runtimeState.currentTarget?.nativeWindowRef,
		},
		capture: {
			stateId: result.capture.stateId,
			width: result.capture.width,
			height: result.capture.height,
			scaleFactor: result.capture.scaleFactor,
			timestamp: result.capture.timestamp,
			coordinateSpace: "window-relative-screenshot-pixels",
		},
		axTargets: result.axTargets,
		visionTargets: result.visionTargets,
		activation: result.activation,
		execution,
		axDiagnostics: result.axDiagnostics,
		status: "ok",
		config: getComputerUseConfig(),
		helper: runtimeState.helperDiagnostics,
		imageReason: fallbackReason?.reason,
	};

	// Console piggyback: when a CDP connection is active for this browser
	// window, surface console output collected since the last tool result.
	let consoleText = "";
	if (isChromeFamilyApp(result.target.appName, result.target.bundleId)) {
		const tab = await cdpTabForWindow(result.target.windowTitle, result.target.framePoints);
		const entries = tab?.drainConsole() ?? [];
		if (entries.length > 0) {
			details.console = entries;
			consoleText = `\n\nBrowser console since the last action:\n${entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`;
		}
	}

	const axTargetText = result.axTargets.length
		? `\n\nPrefer these AX targets over coordinate clicks or focus-based text replacement when one matches your intent:\n${result.axTargets.map(formatAxTargetLabel).join("\n")}`
		: "";
	const visionText = result.visionTargets?.length
		? `\n\nVision targets:\n${result.visionTargets.map(formatVisionTargetLabel).join("\n")}`
		: "";
	const fallbackText = fallbackReason ? `\n\n${fallbackReason.message}` : "";
	const content: AgentToolResult<ComputerUseDetails>["content"] = [{ type: "text", text: `${summary}${consoleText}${axTargetText}${visionText}${fallbackText}` }];
	if (fallbackReason) {
		content.push({ type: "image", data: result.image!.pngBase64, mimeType: "image/png" });
	}

	return { content, details };
}

async function mouseClickAtCapturePoint(
	target: ResolvedTarget,
	capture: CurrentCapture,
	x: number,
	y: number,
	button: MouseButtonName,
	clickCount: number,
	delivery: NativeInputDelivery = nativeInputDelivery(),
	signal?: AbortSignal,
): Promise<void> {
	ensurePointIsInCapture(x, y, capture);
	await bridgeCommand(
		"mouseClick",
		{
			...nativeWindowRequest(target),
			x,
			y,
			button,
			clickCount,
			captureWidth: capture.width,
			captureHeight: capture.height,
			delivery,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
}

interface CoordinateClickVerification {
	stateChanged: boolean;
	verification: ExecutionTrace["coordinateVerification"];
}

async function coordinateStateSignature(target: ResolvedTarget, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const [focused, rawTargets] = await Promise.all([
			bridgeCommand<FocusedElementResult>("focusedElement", nativeWindowRequest(target), { signal, timeoutMs: COMMAND_TIMEOUT_MS }).catch(() => undefined),
			listAxTargetsRaw(target, 30, signal),
		]);
		const focusedSignature = focused?.exists
			? [focused.role, focused.subrole, focused.isTextInput, focused.canSetValue].map((item) => String(item ?? "")).join(":")
			: "none";
		const targetSignature = parseAxTargets(rawTargets)
			.map((candidate) => [candidate.role, candidate.subrole, axTargetLabelKey(candidate), Math.round(candidate.x), Math.round(candidate.y), candidate.canPress, candidate.canFocus].join(":"))
			.join("|");
		return `${focusedSignature}\n${targetSignature}`;
	} catch {
		return undefined;
	}
}

async function verifiedCoordinateClick(
	target: ResolvedTarget,
	capture: CurrentCapture,
	x: number,
	y: number,
	button: MouseButtonName,
	clickCount: number,
	delivery: NativeInputDelivery,
	signal?: AbortSignal,
): Promise<CoordinateClickVerification> {
	const before = await coordinateStateSignature(target, signal);
	await mouseClickAtCapturePoint(target, capture, x, y, button, clickCount, delivery, signal);
	await sleep(80, signal);
	const after = await coordinateStateSignature(target, signal);
	if (!before || !after) return { stateChanged: false, verification: "unavailable" };
	const stateChanged = before !== after;
	return { stateChanged, verification: stateChanged ? "ax_signature_changed" : "no_observable_change" };
}

function visionClickPoint(visual: VisionTarget, capture: CurrentCapture): { x: number; y: number } {
	const containers = (runtimeState.currentAxTargets ?? [])
		.map((target) => target.frame)
		.filter((frame): frame is FramePoints => Boolean(frame && frame.w > 80 && frame.h > 24));
	const containing = containers
		.filter((frame) => visual.y >= frame.y && visual.y <= frame.y + frame.h && visual.x >= frame.x && visual.x <= frame.x + frame.w)
		.sort((a, b) => a.w * a.h - b.w * b.h)[0];
	if (containing && containing.w > Math.max((visual.frame?.w ?? 0) * 2, 120)) {
		return { x: Math.min(capture.width - 1, Math.max(0, containing.x + containing.w / 2)), y: visual.y };
	}
	return { x: visual.x, y: visual.y };
}

async function dispatchClick(
	params: ClickParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	const button = normalizeMouseButton(params.button);
	const clickCount = normalizeClickCount(params.clickCount);
	const delivery = nativeInputDelivery();
	const deliveryPolicy = currentDeliveryPolicy();
	const clickStrategy = (count = clickCount): ExecutionTrace["strategy"] => delivery === "pid" ? (count > 1 ? "pid_event_double_click" : "pid_event_click") : (count > 1 ? "coordinate_event_double_click" : "coordinate_event_click");
	const nonStealthReason = delivery === "pid" ? "pid_routed_mouse_click" : "coordinate_mouse_click_requires_pointer_event";

	const performCoordinateClick = async (clickX: number, clickY: number): Promise<CoordinateClickVerification> =>
		await verifiedCoordinateClick(target, capture, clickX, clickY, button, clickCount, delivery, signal);

	if (ref) {
		const visual = visionTargetByRef(ref);
		if (visual) {
			if (isStrictAxMode()) strictModeBlock(`Vision ref '${ref}' requires coordinate input.`);
			if (button !== "left") throw new Error(`Vision refs only support left-button clicks. Use coordinates for ${button}-click.`);
			const point = visionClickPoint(visual, capture);
			const verification = await performCoordinateClick(point.x, point.y);
			return executionTrace(clickStrategy(), "default", {
				axAttempted: false,
				axSucceeded: false,
				fallbackUsed: true,
				nonStealthReason: delivery === "pid" ? "vision_ref_click_uses_pid_routed_mouse_click" : "vision_ref_click_uses_coordinate_mouse_click",
				grounding: "vision",
				delivery,
				deliveryPolicy,
				coordinateStateChanged: verification.stateChanged,
				coordinateVerification: verification.verification,
			});
		}
		if (button !== "left") {
			throw new Error(`AX target refs only support left-button clicks. Use coordinates for ${button}-click.`);
		}
		const attemptRefClick = async (axTarget: AxTarget): Promise<{ clickedViaAX: boolean; focusedViaAX: boolean }> => {
			let clickedViaAX = false;
			let focusedViaAX = false;
			for (let index = 0; index < clickCount; index += 1) {
				try {
					const axResult = await bridgeCommand<AxPressAtPointResult>(
						"axPressElement",
						{ elementRef: axTarget.elementRef, pid: target.pid },
						{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
					);
					clickedViaAX = toBoolean(axResult?.pressed);
				} catch {
					clickedViaAX = false;
				}
				if (!clickedViaAX) break;
				if (index + 1 < clickCount) {
					await sleep(60, signal);
				}
			}

			if (!clickedViaAX && clickCount === 1) {
				try {
					const focusResult = await bridgeCommand<AxFocusResult>(
						"axFocusElement",
						{ elementRef: axTarget.elementRef, pid: target.pid },
						{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
					);
					focusedViaAX = toBoolean(focusResult?.focused);
				} catch {
					focusedViaAX = false;
				}
			}
			return { clickedViaAX, focusedViaAX };
		};

		const axTarget = axTargetByRef(ref);
		const originalAxTargets = runtimeState.currentAxTargets;
		let reacquiredTarget: AxTarget | undefined;
		let { clickedViaAX, focusedViaAX } = await attemptRefClick(axTarget);
		if (!clickedViaAX && !focusedViaAX) {
			const reacquired = await reacquireAxTarget(axTarget, target, signal);
			if (reacquired) {
				reacquiredTarget = reacquired;
				({ clickedViaAX, focusedViaAX } = await attemptRefClick(reacquired));
			}
		}
		// Reacquisition refreshes the global AX target list. During a batched action
		// sequence, subsequent actions still refer to refs from the pre-batch state,
		// so preserve that ref namespace until the batch returns a fresh state.
		if (originalAxTargets) {
			runtimeState.currentAxTargets = originalAxTargets;
		}

		const effectiveTarget = reacquiredTarget ?? axTarget;
		const focusIsSufficient = focusedViaAX && (effectiveTarget.isTextInput || effectiveTarget.canFocus);
		if (!clickedViaAX && !focusIsSufficient) {
			if (isStrictAxMode()) {
				strictModeBlock(`AX click/focus could not be completed for ${ref}.`);
			}
			const screenPoint = axCoordinateFallbackPoint(effectiveTarget);
			const fallbackPoint = screenPointToCapturePoint(target, capture, screenPoint.x, screenPoint.y);
			const verification = await performCoordinateClick(fallbackPoint.x, fallbackPoint.y);
			return executionTrace(clickStrategy(), "default", {
				axAttempted: true,
				axSucceeded: false,
				fallbackUsed: true,
				nonStealthReason: delivery === "pid" ? "ax_ref_click_fell_back_to_pid_routed_mouse_click" : "ax_ref_click_fell_back_to_coordinate_mouse_click",
				grounding: "ax",
				delivery,
				deliveryPolicy,
				coordinateStateChanged: verification.stateChanged,
				coordinateVerification: verification.verification,
			});
		}

		return executionTrace(clickedViaAX ? "ax_press" : "ax_focus", "stealth", {
			axAttempted: true,
			axSucceeded: true,
			fallbackUsed: false,
			grounding: "ax",
			delivery: "ax",
		});
	}

	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error("click requires either ref or both x and y.");
	}
	ensurePointIsInCapture(x, y, capture);

	let clickedViaAX = false;
	const canTryAX = button === "left" && clickCount === 1;
	if (canTryAX) {
		try {
			const axResult = await bridgeCommand<AxPressAtPointResult>(
				"axPressAtPoint",
				{
					...nativeWindowRequest(target),
					x,
					y,
					captureWidth: capture.width,
					captureHeight: capture.height,
				},
				{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
			);
			clickedViaAX = toBoolean(axResult?.pressed);
		} catch {
			clickedViaAX = false;
		}

	}

	let coordinateVerification: CoordinateClickVerification | undefined;
	if (!clickedViaAX) {
		if (isStrictAxMode()) {
			strictModeBlock(`AX click could not be completed at (${Math.round(x)},${Math.round(y)}).`);
		}
		coordinateVerification = await performCoordinateClick(x, y);
	}

	const usedAxPath = clickedViaAX;
	return executionTrace(
		clickedViaAX ? "ax_press" : clickStrategy(),
		usedAxPath ? "stealth" : "default",
		{
			axAttempted: canTryAX,
			axSucceeded: usedAxPath,
			fallbackUsed: canTryAX && !usedAxPath,
			nonStealthReason: usedAxPath ? undefined : nonStealthReason,
			grounding: usedAxPath ? "ax" : "vision",
			delivery: usedAxPath ? "ax" : delivery,
			deliveryPolicy: usedAxPath ? undefined : deliveryPolicy,
			coordinateStateChanged: coordinateVerification?.stateChanged,
			coordinateVerification: coordinateVerification?.verification,
		},
	);
}

async function postKeyboardText(text: string, target: ResolvedTarget, delivery: NativeInputDelivery = nativeInputDelivery(), signal?: AbortSignal): Promise<void> {
	await bridgeCommand("typeText", { text, pid: target.pid, delivery }, { signal, timeoutMs: Math.min(90_000, Math.max(COMMAND_TIMEOUT_MS, text.length * 25 + 4_000)) });
}

async function dispatchTypeText(text: string, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	if (runtimeState.allowNextTypeTextAxReplacement) {
		runtimeState.allowNextTypeTextAxReplacement = false;
		const focusedElementRef = await focusedTextElementRef(target, signal);
		if (focusedElementRef) {
			await setAxValue(focusedElementRef, text, signal);
			if (isBrowserApp(target.appName, target.bundleId)) {
				runtimeState.pendingBrowserAddress = { text, pid: target.pid, windowId: target.windowId };
			}
			return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
		}
	}
	if (isStrictAxMode()) {
		strictModeBlock("Raw text insertion is not AX-only. Use set_text for AX value replacement.");
	}
	await focusControlledWindow(target, signal);
	const delivery = nativeInputDelivery();
	await postKeyboardText(text, target, delivery, signal);
	return executionTrace(delivery === "pid" ? "pid_key_text" : "raw_key_text", "default", {
		axAttempted: false,
		axSucceeded: false,
		fallbackUsed: false,
		delivery,
		deliveryPolicy: currentDeliveryPolicy(),
		nonStealthReason: delivery === "pid" ? "pid_routed_text_input" : "raw_text_insertion_requires_keyboard_focus",
	});
}

async function focusedTextElementRef(target: ResolvedTarget, signal?: AbortSignal): Promise<string | undefined> {
	const focused: FocusedElementResult = await bridgeCommand<FocusedElementResult>(
		"focusedElement",
		nativeWindowRequest(target),
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => ({ exists: false } as FocusedElementResult));

	if (!focused.exists || !focused.isTextInput || !focused.canSetValue || !focused.elementRef) {
		return undefined;
	}
	return focused.elementRef;
}

async function setAxValue(elementRef: string, text: string, signal?: AbortSignal): Promise<void> {
	await bridgeCommand(
		"setValue",
		{
			elementRef,
			value: text,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
}

async function focusAxElement(elementRef: string, target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	const result = await bridgeCommand<AxFocusResult>(
		"axFocusElement",
		{ elementRef, pid: target.pid },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => undefined);
	return toBoolean(result?.focused);
}

async function dispatchSetText(params: SetTextParams, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	const ref = trimOrUndefined(params.ref);
	const method = params.method === "keyboard" ? "keyboard" : "ax";
	if (method === "keyboard") {
		if (isStrictAxMode()) {
			strictModeBlock("Keyboard text replacement is not AX-only. Use default set_text AX semantics in strict mode.");
		}
		const delivery = nativeInputDelivery();
		let keyboardTextElementRef: string | undefined;
		if (ref) {
			let axTarget = axTargetByRef(ref);
			const capture = runtimeState.currentCapture;
			if (capture) {
				const screenPoint = axCoordinateFallbackPoint(axTarget);
				const point = screenPointToCapturePoint(target, capture, screenPoint.x, screenPoint.y);
				await mouseClickAtCapturePoint(target, capture, point.x, point.y, "left", 1, delivery, signal);
				await sleep(60, signal);
			}
			let focused = await focusAxElement(axTarget.elementRef, target, signal);
			if (!focused) {
				const reacquired = await reacquireAxTarget(axTarget, target, signal);
				if (reacquired) {
					axTarget = reacquired;
					focused = await focusAxElement(axTarget.elementRef, target, signal);
				}
			}
			if (!focused) {
				throw new Error(`Could not focus AX target '${ref}' for keyboard text replacement.`);
			}
			keyboardTextElementRef = axTarget.elementRef;
		} else {
			await focusControlledWindow(target, signal);
		}
		if (keyboardTextElementRef) {
			await bridgeCommand("selectText", { elementRef: keyboardTextElementRef }, { signal, timeoutMs: COMMAND_TIMEOUT_MS }).catch(() => undefined);
			await sleep(60, signal);
		}
		await postKeyboardText(params.text, target, delivery, signal);
		return executionTrace(delivery === "pid" ? "pid_key_text" : "raw_key_text", "default", {
			axAttempted: Boolean(ref),
			axSucceeded: Boolean(ref),
			fallbackUsed: false,
			delivery,
			deliveryPolicy: currentDeliveryPolicy(),
			nonStealthReason: delivery === "pid" ? "keyboard_text_replacement_uses_pid_routed_key_events" : "keyboard_text_replacement_requires_foreground_key_events",
		});
	}

	if (ref) {
		let axTarget = axTargetByRef(ref);
		if (axTarget.canSetValue !== false) {
			try {
				await setAxValue(axTarget.elementRef, params.text, signal);
				return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
			} catch (error) {
				if (isElementRefInvalid(error)) {
					const reacquired = await reacquireAxTarget(axTarget, target, signal);
					if (reacquired && reacquired.canSetValue !== false) {
						axTarget = reacquired;
						await setAxValue(axTarget.elementRef, params.text, signal);
						return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
					}
				}
				if (isStrictAxMode()) {
					throw normalizeError(error);
				}
			}
		}

		if (isStrictAxMode()) {
			strictModeBlock(`AX target '${ref}' does not expose a directly settable AX value.`);
		}

		let focusedViaRef = await focusAxElement(axTarget.elementRef, target, signal);
		if (!focusedViaRef) {
			const reacquired = await reacquireAxTarget(axTarget, target, signal);
			if (reacquired) {
				axTarget = reacquired;
				focusedViaRef = await focusAxElement(axTarget.elementRef, target, signal);
			}
		}
		if (focusedViaRef) {
			const focusedElementRef = await focusedTextElementRef(target, signal);
			if (focusedElementRef) {
				await setAxValue(focusedElementRef, params.text, signal);
				return executionTrace("ax_set_value", "stealth", {
					axAttempted: true,
					axSucceeded: true,
					fallbackUsed: false,
				});
			}
		}
	}

	const focusedElementRef = await focusedTextElementRef(target, signal);
	if (focusedElementRef) {
		await setAxValue(focusedElementRef, params.text, signal);
		return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	if (isStrictAxMode()) {
		strictModeBlock("set_text in stealth mode requires a text AX ref from the latest screenshot or an already-focused text control.");
	}

	await focusControlledWindow(target, signal);
	const focusedAfterWindowFocus = await focusedTextElementRef(target, signal);
	if (!focusedAfterWindowFocus) {
		throw new Error("AX value replacement requires a text AX ref or focused text control. Use set_text with ref from the latest screenshot when available.");
	}
	await setAxValue(focusedAfterWindowFocus, params.text, signal);
	return executionTrace("ax_set_value", "default", {
		axAttempted: true,
		axSucceeded: true,
		fallbackUsed: true,
		nonStealthReason: "set_text_without_ref_requires_window_focus_fallback",
	});
}

function isCommandL(keys: string[]): boolean {
	return keys.length === 1 && /^(cmd|command|meta)\+l$/i.test(keys[0].replace(/\s+/g, ""));
}

async function focusBrowserAddressField(keys: string[], target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	if (!isCommandL(keys) || !isBrowserApp(target.appName, target.bundleId)) return false;

	const focusedTextInput = await bridgeCommand<{ focused?: boolean; elementRef?: string }>(
		"axFocusTextInput",
		nativeWindowRequest(target),
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => undefined);
	if (toBoolean(focusedTextInput?.focused)) {
		runtimeState.allowNextTypeTextAxReplacement = true;
		return true;
	}

	const refreshed = await refreshAxTargets(target, signal);
	if (!refreshed.length) return false;
	const field = refreshed
		.filter((candidate) => candidate.canFocus && candidate.isTextInput && (candidate.role === "AXTextField" || candidate.role === "AXSearchField" || candidate.role === "AXComboBox"))
		.sort((a, b) => a.y - b.y || a.x - b.x)[0];
	if (!field) return false;
	const focused = await focusAxElement(field.elementRef, target, signal);
	if (focused) runtimeState.allowNextTypeTextAxReplacement = true;
	return focused;
}

function semanticActionsForKeys(keys: string[]): string[] {
	if (keys.length !== 1) return [];
	const key = keys[0].trim().toLowerCase();
	if (["enter", "return"].includes(key)) return ["confirm", "press"];
	if (["escape", "esc"].includes(key)) return ["cancel"];
	if (["space", "spacebar", " "].includes(key)) return ["press"];
	return [];
}

function windowButtonForSemanticKey(keys: string[], targets: AxTarget[]): AxTarget | undefined {
	if (keys.length !== 1) return undefined;
	const key = keys[0].trim().toLowerCase();
	const buttons = targets.filter((target) => target.canPress && target.role === "AXButton");
	if (["escape", "esc"].includes(key)) {
		return buttons.find((target) => ["cancel", "don't save", "dont save"].includes(axTargetLabelKey(target)));
	}
	if (["enter", "return"].includes(key)) {
		return (
			buttons.find((target) => normalizeText(target.subrole).includes("default")) ??
			buttons.find((target) => ["ok", "done", "save", "add", "continue", "open", "choose"].includes(axTargetLabelKey(target)))
		);
	}
	return undefined;
}

async function tryWindowAxKeyAction(keys: string[], target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	const refreshed = await refreshAxTargets(target, signal);
	if (!refreshed.length) return false;
	const button = windowButtonForSemanticKey(keys, refreshed);
	if (!button) return false;
	const result = await bridgeCommand<{ performed?: boolean }>(
		"axPerformActionElement",
		{ elementRef: button.elementRef, pid: target.pid, action: "press" },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => undefined);
	return toBoolean(result?.performed);
}

async function tryFocusedAxKeyAction(keys: string[], target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	const actions = semanticActionsForKeys(keys);
	if (!actions.length) return false;
	const focused = await focusedTextElementRef(target, signal);
	if (!focused) {
		const rawFocused = await bridgeCommand<FocusedElementResult>(
			"focusedElement",
			nativeWindowRequest(target),
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => undefined);
		if (!rawFocused?.exists || !rawFocused.elementRef) return await tryWindowAxKeyAction(keys, target, signal);
		for (const action of actions) {
			const result = await bridgeCommand<{ performed?: boolean }>(
				"axPerformActionElement",
				{ elementRef: rawFocused.elementRef, pid: target.pid, action },
				{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
			).catch(() => undefined);
			if (toBoolean(result?.performed)) return true;
		}
		return await tryWindowAxKeyAction(keys, target, signal);
	}
	for (const action of actions) {
		const result = await bridgeCommand<{ performed?: boolean }>(
			"axPerformActionElement",
			{ elementRef: focused, pid: target.pid, action },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => undefined);
		if (toBoolean(result?.performed)) return true;
	}
	return await tryWindowAxKeyAction(keys, target, signal);
}

async function dispatchKeypress(params: KeypressParams, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	const keys = normalizeKeyList(params.keys);
	if (keys.length === 0) {
		throw new Error("keypress.keys must contain at least one key.");
	}

	const openedPendingBrowserLocation = await openBrowserLocationFromPendingAddress(keys, target, signal);
	if (openedPendingBrowserLocation) {
		return executionTrace("browser_open_location", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	const focusedAddressViaAX = await focusBrowserAddressField(keys, target, signal);
	if (focusedAddressViaAX) {
		return executionTrace("ax_focus", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	const performedViaAX = await tryFocusedAxKeyAction(keys, target, signal);
	if (performedViaAX) {
		return executionTrace("ax_action", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	if (isStrictAxMode()) {
		strictModeBlock("Keypress is not AX-only and no semantic AX equivalent was available.");
	}
	const delivery = nativeInputDelivery();
	if (delivery === "hid") await focusControlledWindow(target, signal);
	await bridgeCommand("keyPress", { keys, pid: target.pid, delivery }, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
	return executionTrace(delivery === "pid" ? "pid_keypress" : "raw_keypress", "default", {
		axAttempted: semanticActionsForKeys(keys).length > 0,
		axSucceeded: false,
		fallbackUsed: semanticActionsForKeys(keys).length > 0,
		delivery,
		deliveryPolicy: currentDeliveryPolicy(),
		nonStealthReason: delivery === "pid" ? "pid_routed_keypress" : "keypress_requires_keyboard_focus",
	});
}

function scrollStepCount(delta: number): number {
	return Math.max(1, Math.min(8, Math.ceil(Math.abs(delta) / 500)));
}

interface ScrollAttemptResult {
	scrolled: boolean;
	reason?: string;
}

async function tryAxScrollElement(elementRef: string, target: ResolvedTarget, scrollX: number, scrollY: number, signal?: AbortSignal): Promise<ScrollAttemptResult> {
	const result = await bridgeCommand<{ scrolled?: boolean; reason?: string }>(
		"axScrollElement",
		{ elementRef, pid: target.pid, scrollX, scrollY, steps: Math.max(scrollStepCount(scrollX), scrollStepCount(scrollY)) },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch((error) => ({ scrolled: false, reason: normalizeError(error).message }));
	return { scrolled: toBoolean(result?.scrolled), reason: toOptionalString(result?.reason) };
}

async function tryAxScrollAtPoint(
	target: ResolvedTarget,
	capture: CurrentCapture,
	x: number,
	y: number,
	scrollX: number,
	scrollY: number,
	signal?: AbortSignal,
): Promise<ScrollAttemptResult> {
	const result = await bridgeCommand<{ scrolled?: boolean; reason?: string }>(
		"axScrollAtPoint",
		{
			...nativeWindowRequest(target),
			x,
			y,
			scrollX,
			scrollY,
			steps: Math.max(scrollStepCount(scrollX), scrollStepCount(scrollY)),
			captureWidth: capture.width,
			captureHeight: capture.height,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch((error) => ({ scrolled: false, reason: normalizeError(error).message }));
	return { scrolled: toBoolean(result?.scrolled), reason: toOptionalString(result?.reason) };
}

async function dispatchScroll(
	params: ScrollParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	const scrollX = normalizeScrollDelta(params.scrollX);
	const scrollY = normalizeScrollDelta(params.scrollY);
	if (scrollX === 0 && scrollY === 0) {
		throw new Error("scroll requires a non-zero scrollX or scrollY.");
	}

	let scrollAttempt: ScrollAttemptResult = { scrolled: false };
	if (ref) {
		const axTarget = axTargetByRef(ref);
		scrollAttempt = await tryAxScrollElement(axTarget.elementRef, target, scrollX, scrollY, signal);
		if (!scrollAttempt.scrolled) {
			const reacquired = await reacquireAxTarget(axTarget, target, signal);
			if (reacquired) {
				scrollAttempt = await tryAxScrollElement(reacquired.elementRef, target, scrollX, scrollY, signal);
			}
		}
	} else if (Number.isFinite(x) && Number.isFinite(y)) {
		ensurePointIsInCapture(x, y, capture);
		scrollAttempt = await tryAxScrollAtPoint(target, capture, x, y, scrollX, scrollY, signal);
	} else {
		throw new Error("scroll requires either ref or both x and y. If the target came from an old state, call screenshot again and retry with a current @e scroll ref or coordinates.");
	}

	if (scrollAttempt.scrolled) {
		return executionTrace("ax_scroll", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	const reasonText = scrollAttempt.reason ? ` Reason: ${scrollAttempt.reason}.` : "";
	if (isStrictAxMode()) {
		strictModeBlock(ref ? `AX scroll could not be completed for ${ref}.${reasonText}` : `AX scroll could not be completed at (${Math.round(x)},${Math.round(y)}).${reasonText}`);
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`Coordinate scroll fallback requires x and y.${reasonText} Provide coordinates from the latest screenshot or use a current AX scroll target.`);
	}
	ensurePointIsInCapture(x, y, capture);
	const delivery = nativeInputDelivery();
	await bridgeCommand(
		"scrollWheel",
		{
			...nativeWindowRequest(target),
			x,
			y,
			scrollX,
			scrollY,
			captureWidth: capture.width,
			captureHeight: capture.height,
			delivery,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return executionTrace(delivery === "pid" ? "pid_event_scroll" : "coordinate_event_scroll", "default", {
		axAttempted: true,
		axSucceeded: false,
		fallbackUsed: true,
		delivery,
		deliveryPolicy: currentDeliveryPolicy(),
		nonStealthReason: delivery === "pid" ? "pid_routed_scroll" : "coordinate_scroll_requires_pointer_event",
	});
}

async function dispatchMoveMouse(
	params: MoveMouseParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	if (isStrictAxMode()) {
		strictModeBlock("Mouse movement is not AX-only.");
	}
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	ensurePointIsInCapture(x, y, capture);
	const delivery = nativeInputDelivery();
	await bridgeCommand(
		"mouseMove",
		{ ...nativeWindowRequest(target), x, y, captureWidth: capture.width, captureHeight: capture.height, delivery },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return executionTrace(delivery === "pid" ? "pid_event_move" : "coordinate_event_move", "default", {
		axAttempted: false,
		axSucceeded: false,
		fallbackUsed: false,
		delivery,
		deliveryPolicy: currentDeliveryPolicy(),
		nonStealthReason: delivery === "pid" ? "pid_routed_mouse_move" : "mouse_move_requires_cursor_control",
	});
}

function dragAdjustment(path: Array<{ x: number; y: number }> | undefined): { action: "increment" | "decrement"; steps: number } | undefined {
	if (!path || path.length < 2) return undefined;
	const first = path[0];
	const last = path[path.length - 1];
	const dx = last.x - first.x;
	const dy = last.y - first.y;
	const primary = Math.abs(dx) >= Math.abs(dy) ? dx : -dy;
	if (Math.abs(primary) < 4) return undefined;
	return { action: primary > 0 ? "increment" : "decrement", steps: Math.max(1, Math.min(20, Math.round(Math.abs(primary) / 20))) };
}

async function tryAxAdjustElement(axTarget: AxTarget, adjustment: { action: "increment" | "decrement"; steps: number }, target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	if (adjustment.action === "increment" && !axTarget.canIncrement) return false;
	if (adjustment.action === "decrement" && !axTarget.canDecrement) return false;
	let performed = false;
	for (let index = 0; index < adjustment.steps; index += 1) {
		const result = await bridgeCommand<{ performed?: boolean }>(
			"axPerformActionElement",
			{ elementRef: axTarget.elementRef, pid: target.pid, action: adjustment.action },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => undefined);
		if (!toBoolean(result?.performed)) break;
		performed = true;
	}
	return performed;
}

async function dispatchDrag(
	params: DragParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const path = params.path ? normalizeDragPath(params.path, capture) : undefined;
	const ref = trimOrUndefined(params.ref);
	let adjustedViaAX = false;
	if (ref && path) {
		const axTarget = axTargetByRef(ref);
		const adjustment = dragAdjustment(path);
		if (adjustment) {
			adjustedViaAX = await tryAxAdjustElement(axTarget, adjustment, target, signal);
			if (!adjustedViaAX) {
				const reacquired = await reacquireAxTarget(axTarget, target, signal);
				if (reacquired) adjustedViaAX = await tryAxAdjustElement(reacquired, adjustment, target, signal);
			}
		}
	}
	if (adjustedViaAX) {
		return executionTrace("ax_action", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}
	if (isStrictAxMode()) {
		strictModeBlock(ref ? `AX adjustment could not be completed for ${ref}.` : "Drag is not AX-only.");
	}
	if (!path) {
		throw new Error("drag requires path points for pointer fallback or a ref plus path for AX adjustment.");
	}
	const delivery = nativeInputDelivery();
	await bridgeCommand(
		"mouseDrag",
		{ ...nativeWindowRequest(target), path, captureWidth: capture.width, captureHeight: capture.height, delivery },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return executionTrace(delivery === "pid" ? "pid_event_drag" : "coordinate_event_drag", "default", {
		axAttempted: Boolean(ref),
		axSucceeded: false,
		fallbackUsed: Boolean(ref),
		delivery,
		deliveryPolicy: currentDeliveryPolicy(),
		nonStealthReason: delivery === "pid" ? "pid_routed_drag" : "drag_requires_pointer_event",
	});
}

function confirmationToolResult(tool: string, target: ResolvedTarget, execution: ExecutionTrace, message: string): AgentToolResult<ConfirmationDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: {
			tool,
			status: "ok",
			target: {
				app: target.appName,
				bundleId: target.bundleId,
				pid: target.pid,
				windowTitle: target.windowTitle,
				windowId: target.windowId,
				windowRef: target.windowRef,
			},
			execution,
			message,
		},
	};
}

async function runActionTool(
	tool: string,
	signal: AbortSignal | undefined,
	dispatch: (target: ResolvedTarget) => Promise<ExecutionTrace>,
	summaryFactory: (target: ResolvedTarget, returnedState: boolean) => string,
	options: { responseMode?: WindowTargetParams["responseMode"] } = {},
): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	const currentTarget = await resolveCurrentTarget(signal);
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		return await withWindowWriteLock(readyTarget, async () => {
			const execution = await dispatch(readyTarget);
			stateMayHaveChanged = true;

			await sleep(settleMsForExecution(execution), signal);
			if (options.responseMode === "confirmation") {
				return confirmationToolResult(tool, readyTarget, execution, summaryFactory(readyTarget, false));
			}
			const captureResult = await captureCurrentTarget(signal);
			return await buildToolResult(tool, summaryFactory(captureResult.target, true), captureResult, execution, signal);
		});
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

async function performListApps(signal?: AbortSignal): Promise<AgentToolResult<ListAppsDetails>> {
	const apps = await listApps(signal);
	const config = getComputerUseConfig();
	const details: ListAppsDetails = {
		tool: "list_apps",
		apps: apps.map((app) => ({
			app: app.appName,
			bundleId: app.bundleId,
			pid: app.pid,
			isFrontmost: app.isFrontmost === true,
			browserUseAllowed: config.browser_use || !isBrowserApp(app.appName, app.bundleId),
		})),
		config,
		helper: runtimeState.helperDiagnostics,
	};
	const lines = details.apps.map(formatAppLine);
	const helperLine = details.helper ? `Helper protocol ${details.helper.protocolVersion}, pid ${details.helper.pid}, macOS ${details.helper.macOS ?? "unknown"}.\n` : "";
	const text = lines.length
		? `${helperLine}Found ${lines.length} running app${lines.length === 1 ? "" : "s"}. Use list_windows with app, bundleId, or pid to inspect target windows.\n${lines.join("\n")}`
		: `${helperLine}No running apps were available to pi-computer-use.`;
	return { content: [{ type: "text", text }], details };
}

// Side effect: stores stable @w refs for discovered windows in runtimeState.
async function collectWindowDetails(apps: HelperApp[], config: ReturnType<typeof getComputerUseConfig>, signal?: AbortSignal): Promise<ListWindowsDetails["windows"]> {
	const windows: ListWindowsDetails["windows"] = [];
	for (const app of apps) {
		const appWindows = await listWindows(app.pid, signal);
		for (const window of appWindows) {
			const storedRef = storeWindowRefForAppWindow(app, window);
			windows.push({
				app: app.appName,
				bundleId: app.bundleId,
				pid: app.pid,
				windowTitle: window.title || "(untitled)",
				windowId: window.windowId,
				windowRef: storedRef.ref,
				nativeWindowRef: window.windowRef,
				framePoints: window.framePoints,
				scaleFactor: window.scaleFactor,
				isMinimized: window.isMinimized,
				isOnscreen: window.isOnscreen,
				isMain: window.isMain,
				isFocused: window.isFocused,
				isModal: window.isModal,
				sheetCount: window.sheetCount,
				role: window.role,
				subrole: window.subrole,
				browserUseAllowed: config.browser_use || !isBrowserApp(app.appName, app.bundleId),
				score: scoreWindow(window),
			});
		}
	}
	windows.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle));
	return windows;
}

async function performListWindows(params: ListWindowsParams, signal?: AbortSignal): Promise<AgentToolResult<ListWindowsDetails>> {
	const rawParams = params ?? {};
	const query: ListWindowsParams = {
		app: trimOrUndefined(rawParams.app),
		bundleId: trimOrUndefined(rawParams.bundleId),
		pid: Number.isFinite(rawParams.pid) ? Math.trunc(rawParams.pid!) : undefined,
	};
	const matchingApps = (await listApps(signal)).filter((app) => appMatchesWindowQuery(app, query));
	if (matchingApps.length === 0) {
		throw new Error(
			`No running app matched list_windows query${query.app ? ` app='${query.app}'` : ""}${query.bundleId ? ` bundleId='${query.bundleId}'` : ""}${query.pid ? ` pid=${query.pid}` : ""}. Call list_apps to inspect running apps.`,
		);
	}

	const config = getComputerUseConfig();
	const windows = await collectWindowDetails(matchingApps, config, signal);
	const details: ListWindowsDetails = { tool: "list_windows", query, windows, config };
	const lines = windows.map(formatWindowLine);
	const text = lines.length
		? `Found ${lines.length} controllable window${lines.length === 1 ? "" : "s"}. Use the @w refs with screenshot({ window: "@wN" }) or action tools' optional window field.\n${lines.join("\n")}`
		: `No controllable windows matched the query. Try opening a window, or call list_apps to confirm the app is running.`;
	return { content: [{ type: "text", text }], details };
}

function normalizeImageMode(value: unknown): ImageMode {
	return value === "always" || value === "never" ? value : "auto";
}

function desktopContextId(windowRef: string): string {
	return `${DESKTOP_CONTEXT_PREFIX}${windowRef}`;
}

function isBrowserContextId(contextId: string | undefined): contextId is string {
	return Boolean(contextId?.startsWith(BROWSER_CONTEXT_PREFIX));
}

function desktopWindowRefFromContext(contextId: string): string | undefined {
	return contextId.startsWith(DESKTOP_CONTEXT_PREFIX) ? contextId.slice(DESKTOP_CONTEXT_PREFIX.length) : undefined;
}

async function performListContexts(signal?: AbortSignal): Promise<AgentToolResult<ContextDetails>> {
	const config = getComputerUseConfig();
	const windows = await collectWindowDetails(await listApps(signal), config, signal);
	const desktopContexts: ContextDetails["contexts"] = windows.map((window) => ({
		contextId: desktopContextId(window.windowRef),
		kind: "desktop_window",
		title: window.windowTitle,
		app: window.app,
		bundleId: window.bundleId,
		pid: window.pid,
		windowRef: window.windowRef,
		windowId: window.windowId,
		availableActions: ["snapshot", "read_text", "wait_for", "click", "double_click", "type_text", "set_text", "keypress", "scroll", "drag", "wait", "arrange_window"],
	}));
	const browserContexts: ContextDetails["contexts"] = (await listCdpPageContexts().catch(() => [])).map((page) => ({
		contextId: page.contextId,
		kind: "browser_page",
		title: page.title,
		url: page.url,
		availableActions: ["snapshot", "read_text", "wait_for", "click", "set_text", "scroll", "navigate_browser", "evaluate_browser"],
	}));
	const contexts = [...browserContexts, ...desktopContexts];
	const details: ContextDetails = { tool: "list_contexts", contexts, config };
	const lines = contexts.map((context) => {
		const label = context.kind === "browser_page" ? `${context.title} — ${context.url ?? ""}` : `${context.app} — ${context.title}`;
		return `- ${context.contextId} ${context.kind} ${label}`;
	});
	const text = lines.length
		? `Found ${lines.length} controllable context${lines.length === 1 ? "" : "s"}. Use snapshot({ contextId }) before acting.\n${lines.join("\n")}`
		: "No controllable contexts were found.";
	return { content: [{ type: "text", text }], details };
}

function browserSnapshotTarget(snapshotId: string | undefined, ref: string | undefined): { contextId: string; backendNodeId?: number } | undefined {
	if (!snapshotId || !ref) return undefined;
	const snapshot = runtimeState.browserSnapshots.get(snapshotId);
	const target = snapshot?.targets.find((candidate) => candidate.ref === ref);
	if (!snapshot || !target) return undefined;
	return { contextId: snapshot.contextId, backendNodeId: target.backendNodeId };
}

async function performBrowserClick(params: ClickParams, signal?: AbortSignal): Promise<AgentToolResult<SnapshotDetails> | undefined> {
	const contextId = trimOrUndefined(params.contextId);
	if (!isBrowserContextId(contextId)) return undefined;
	const target = browserSnapshotTarget(params.stateId, trimOrUndefined(params.ref));
	if (!target || target.contextId !== contextId || !Number.isFinite(target.backendNodeId)) {
		throw new Error("Browser click requires contextId, stateId from snapshot, and a clickable browser ref from that snapshot.");
	}
	const clickCount = Math.max(1, Math.min(3, Number.isFinite(params.clickCount) ? Math.trunc(params.clickCount!) : 1));
	for (let index = 0; index < clickCount; index += 1) {
		const clicked = await cdpClickForContext(contextId, target.backendNodeId!);
		if (!clicked) throw new Error(`Browser context '${contextId}' is no longer available. Call list_contexts and snapshot again.`);
	}
	return await performSnapshot({ contextId, image: params.image }, signal);
}

// Side effect: browser snapshots are cached so later click(contextId,stateId,ref) can resolve opaque @r refs.
async function refreshBrowserSnapshot(contextId: string, image?: ImageMode, signal?: AbortSignal): Promise<AgentToolResult<SnapshotDetails>> {
	return await performSnapshot({ contextId, image }, signal);
}

async function performBrowserSetText(params: SetTextParams, signal?: AbortSignal): Promise<AgentToolResult<SnapshotDetails> | undefined> {
	const contextId = trimOrUndefined(params.contextId);
	if (!isBrowserContextId(contextId)) return undefined;
	const target = browserSnapshotTarget(params.stateId, trimOrUndefined(params.ref));
	if (!target || target.contextId !== contextId || !Number.isFinite(target.backendNodeId)) {
		throw new Error("Browser set_text requires contextId, stateId from snapshot, and an editable browser ref from that snapshot.");
	}
	const ok = await cdpTypeForContext(contextId, target.backendNodeId!, typeof params.text === "string" ? params.text : "", true);
	if (!ok) throw new Error(`Browser context '${contextId}' is no longer available. Call list_contexts and snapshot again.`);
	return await refreshBrowserSnapshot(contextId, params.image, signal);
}

async function performBrowserScroll(params: ScrollParams, signal?: AbortSignal): Promise<AgentToolResult<SnapshotDetails> | undefined> {
	const contextId = trimOrUndefined(params.contextId);
	if (!isBrowserContextId(contextId)) return undefined;
	const target = browserSnapshotTarget(params.stateId, trimOrUndefined(params.ref));
	if (params.ref && (!target || target.contextId !== contextId)) throw new Error("Browser scroll ref must come from the supplied snapshot stateId.");
	const ok = await cdpScrollForContext(contextId, toFiniteNumber(params.scrollX, 0), toFiniteNumber(params.scrollY, 0), target?.backendNodeId);
	if (!ok) throw new Error(`Browser context '${contextId}' is no longer available. Call list_contexts and snapshot again.`);
	return await refreshBrowserSnapshot(contextId, params.image, signal);
}

function textPreview(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function sliceText(value: string, offsetValue: unknown, limitValue: unknown): Pick<ReadTextDetails, "offset" | "limit" | "totalChars" | "hasMore" | "text"> {
	const offset = Math.max(0, Math.trunc(toFiniteNumber(offsetValue, 0)));
	const limit = Math.max(1, Math.min(100_000, Math.trunc(toFiniteNumber(limitValue, 4_000))));
	const characters = Array.from(value);
	const end = Math.min(characters.length, offset + limit);
	return {
		offset,
		limit,
		totalChars: characters.length,
		hasMore: end < characters.length,
		text: offset >= characters.length ? "" : characters.slice(offset, end).join(""),
	};
}

async function performReadText(params: ReadTextParams, signal?: AbortSignal): Promise<AgentToolResult<ReadTextDetails>> {
	const contextId = trimOrUndefined(params.contextId);
	const ref = trimOrUndefined(params.ref);
	if (isBrowserContextId(contextId)) {
		const cached = params.stateId ? runtimeState.browserSnapshots.get(params.stateId) : undefined;
		const snapshot = cached?.contextId === contextId ? cached : await cdpSnapshotForContext(contextId);
		if (!snapshot) throw new Error(`Browser context '${contextId}' is no longer available. Call list_contexts and snapshot again.`);
		const sliced = sliceText(snapshot.text, params.offset, params.limit);
		const details: ReadTextDetails = { tool: "read_text", contextId, ref, ...sliced };
		return { content: [{ type: "text", text: sliced.text || "(empty text slice)" }], details };
	}

	const desktopWindowRef = contextId ? desktopWindowRefFromContext(contextId) : undefined;
	await selectWindowIfProvided(params.window ?? desktopWindowRef, signal);
	validateStateId(params.stateId);
	if (!ref) throw new Error("read_text requires ref for desktop contexts. Call screenshot/snapshot and use a text-bearing @e ref.");
	const target = axTargetByRef(ref);
	const raw = await bridgeCommand("axReadText", {
		elementRef: target.elementRef,
		offset: Math.max(0, Math.trunc(toFiniteNumber(params.offset, 0))),
		limit: Math.max(1, Math.min(100_000, Math.trunc(toFiniteNumber(params.limit, 4_000)))),
	}, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
	const record = isRecord(raw) ? raw : {};
	const text = toOptionalString(record.text) ?? "";
	const details: ReadTextDetails = {
		tool: "read_text",
		contextId,
		ref,
		offset: Math.max(0, Math.trunc(toFiniteNumber(record.offset, 0))),
		limit: Math.max(1, Math.trunc(toFiniteNumber(record.limit, 4_000))),
		totalChars: Math.max(0, Math.trunc(toFiniteNumber(record.totalChars, text.length))),
		hasMore: toBoolean(record.hasMore),
		text,
	};
	return { content: [{ type: "text", text: text || "(empty text slice)" }], details };
}

async function listAxTreeRaw(target: ResolvedTarget, params: SnapshotParams, signal?: AbortSignal): Promise<unknown> {
	const scope = trimOrUndefined(params.scopeRef) ? axTargetByRef(trimOrUndefined(params.scopeRef)!).elementRef : undefined;
	return await bridgeCommand("axSnapshotTree", {
		...nativeWindowRequest(target),
		elementRef: scope,
		maxNodes: Math.max(1, Math.min(500, Math.trunc(toFiniteNumber(params.maxNodes, 120)))),
		maxDepth: Math.max(1, Math.min(20, Math.trunc(toFiniteNumber(params.maxDepth, 4)))),
	}, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
}

function normalizeWaitTimeoutMs(value: unknown): number {
	return Math.max(100, Math.min(60_000, Math.trunc(toFiniteNumber(value, 10_000))));
}

async function performWaitFor(params: WaitForParams, signal?: AbortSignal): Promise<AgentToolResult<WaitForDetails>> {
	const contextId = trimOrUndefined(params.contextId);
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const timeoutMs = normalizeWaitTimeoutMs(params.timeoutMs);
	if (!text && !role) throw new Error("wait_for requires text or role.");

	if (isBrowserContextId(contextId)) {
		const deadline = Date.now() + timeoutMs;
		let lastSnapshot;
		do {
			lastSnapshot = await cdpSnapshotForContext(contextId);
			if (!lastSnapshot) throw new Error(`Browser context '${contextId}' is no longer available. Call list_contexts and snapshot again.`);
			const matchesText = !text || lastSnapshot.text.toLowerCase().includes(text.toLowerCase()) || lastSnapshot.targets.some((target) => target.name.toLowerCase().includes(text.toLowerCase()));
			const matchesRole = !role || lastSnapshot.targets.some((target) => target.role === role);
			const found = matchesText && matchesRole;
			if (found !== (params.gone === true)) {
				const details: WaitForDetails = { tool: "wait_for", contextId, found: true, gone: params.gone === true || undefined, nodeCount: lastSnapshot.targets.length, text, role };
				return { content: [{ type: "text", text: params.gone ? "Condition disappeared." : "Condition appeared." }], details };
			}
			await sleep(200, signal);
		} while (Date.now() < deadline);
		const details: WaitForDetails = { tool: "wait_for", contextId, found: false, timedOut: true, nodeCount: lastSnapshot?.targets.length, text, role };
		return { content: [{ type: "text", text: `Timed out after ${timeoutMs}ms waiting for condition.` }], details };
	}

	const desktopWindowRef = contextId ? desktopWindowRefFromContext(contextId) : undefined;
	await selectWindowIfProvided(params.window ?? desktopWindowRef, signal);
	let target = await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const raw = await bridgeCommand("axWaitFor", {
		...nativeWindowRequest(target),
		text,
		role,
		gone: params.gone === true,
		timeoutMs,
	}, { signal, timeoutMs: timeoutMs + 2_000 });
	const record = isRecord(raw) ? raw : {};
	const axTargets = parseAxTargets(isRecord(record.target) ? { targets: [record.target] } : []);
	const foundTarget = axTargets[0];
	if (foundTarget) runtimeState.currentAxTargets = axTargets;
	const details: WaitForDetails = {
		tool: "wait_for",
		contextId,
		found: toBoolean(record.found),
		gone: toBoolean(record.gone) || undefined,
		timedOut: toBoolean(record.timedOut) || undefined,
		target: foundTarget,
		nodeCount: Number.isFinite(record.nodeCount) ? Number(record.nodeCount) : undefined,
		text,
		role,
	};
	const message = details.found ? (details.gone ? "Condition disappeared." : "Condition appeared.") : `Timed out after ${timeoutMs}ms waiting for condition.`;
	return { content: [{ type: "text", text: message }], details };
}

async function performSnapshot(params: SnapshotParams, signal?: AbortSignal): Promise<AgentToolResult<SnapshotDetails>> {
	const contextId = trimOrUndefined(params.contextId);
	if (!contextId) throw new Error("snapshot.contextId must be a non-empty context id from list_contexts.");

	const browser = await cdpSnapshotForContext(contextId).catch(() => undefined);
	if (browser) {
		const targetText = browser.targets.length
			? `\n\nTargets:\n${browser.targets.map((target) => `${target.ref} ${target.role} \"${previewAxText(target.name)}\" [${target.actions.join(",")}]`).join("\n")}`
			: "";
		const browserTextPreview = textPreview(browser.text, BROWSER_SNAPSHOT_TEXT_PREVIEW_CHARS);
		const pageText = browserTextPreview ? `\n\nPage text preview (${browserTextPreview.length}/${browser.text.length} chars; use read_text for more):\n${browserTextPreview}` : "";
		runtimeState.browserSnapshots.set(browser.snapshotId, browser);
		const details: SnapshotDetails = {
			tool: "snapshot",
			contextId,
			kind: "browser_page",
			snapshotId: browser.snapshotId,
			availableActions: ["snapshot", "read_text", "wait_for", "click", "set_text", "scroll", "navigate_browser", "evaluate_browser"],
			browser: { ...browser, text: browserTextPreview },
		};
		return { content: [{ type: "text", text: `Captured browser context ${contextId}: ${browser.title}.${targetText}${pageText}` }], details };
	}

	const windowRef = desktopWindowRefFromContext(contextId);
	if (!windowRef) throw new Error(`Unknown context '${contextId}'. Call list_contexts and use a current contextId.`);
	await selectWindowIfProvided(windowRef, signal);
	let target = await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const capture = captureForTarget(target);
	setCurrentTarget(target);
	runtimeState.currentCapture = capture;
	runtimeState.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	const axResult = await listAxTreeRaw(target, params, signal);
	const axTargets = parseAxTargets(axResult);
	runtimeState.currentAxTargets = axTargets;
	const desktop: ComputerUseDetails = {
		tool: "snapshot",
		target: {
			app: target.appName,
			bundleId: target.bundleId,
			pid: target.pid,
			windowTitle: target.windowTitle,
			windowId: target.windowId,
			windowRef: target.windowRef,
			nativeWindowRef: target.nativeWindowRef,
		},
		capture: { ...capture, coordinateSpace: "window-relative-screenshot-pixels" },
		axTargets,
		activation: emptyActivation(),
		execution: executionTrace("screenshot", "stealth", { fallbackUsed: false }),
		axDiagnostics: axDiagnosticsFromResult(axResult, target),
		status: "ok",
		config: getComputerUseConfig(),
	};
	const details: SnapshotDetails = {
		tool: "snapshot",
		contextId,
		kind: "desktop_window",
		snapshotId: capture.stateId,
		availableActions: ["snapshot", "click", "double_click", "type_text", "set_text", "keypress", "scroll", "drag", "wait", "arrange_window", "read_text"],
		desktop,
	};
	const lines = axTargets.map((item) => `${"  ".repeat(Math.max(0, item.depth ?? 0))}${formatAxTargetLabel(item)}`);
	const scope = trimOrUndefined(params.scopeRef) ? ` scoped to ${params.scopeRef}` : "";
	return { content: [{ type: "text", text: `Captured desktop context ${contextId}${scope}. ${axTargets.length} AX node${axTargets.length === 1 ? "" : "s"}.\n${lines.join("\n")}` }], details };
}

async function performScreenshot(params: ScreenshotParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	const selection = {
		app: trimOrUndefined(params.app),
		windowTitle: trimOrUndefined(params.windowTitle),
		window: normalizeWindowSelector(params.window),
	};

	const requestedTarget = selection.window
		? await resolveTargetByWindowSelector(params.window!, signal)
		: await resolveTargetForScreenshot(selection, signal);
	const captureResult = await captureCurrentTarget(signal);
	if (!matchesScreenshotSelection(captureResult.target, selection)) {
		throw new Error(
			`Screenshot target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call screenshot again or specify a more exact window title.`,
		);
	}
	const summary = `Captured ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
	return await buildToolResult("screenshot", summary, captureResult, executionTrace("screenshot", "stealth", { fallbackUsed: false }), signal, normalizeImageMode(params.image));
}

async function performClick(params: ClickParams, signal?: AbortSignal, tool = "click"): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails | ConfirmationDetails>> {
	const browserResult = await performBrowserClick(params, signal);
	if (browserResult) return browserResult;
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	const button = normalizeMouseButton(params.button);
	const clickCount = normalizeClickCount(params.clickCount);

	const verb = clickCount > 1 ? "Double-clicked" : button === "left" ? "Clicked" : `${button}-clicked`;
	return await runActionTool(
		tool,
		signal,
		async (target) => await dispatchClick({ ...params, clickCount }, capture, target, signal),
		(target, returnedState) => {
			const suffix = returnedState ? " Returned the latest semantic window state." : " Call snapshot/screenshot if you need updated state.";
			if (ref) {
				const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
				return `${verb} ${axTarget ? formatAxTargetLabel(axTarget) : ref} in ${target.appName} — ${target.windowTitle}.${suffix}`;
			}
			return `${verb} at (${Math.round(x)},${Math.round(y)}) in ${target.appName} — ${target.windowTitle}.${suffix}`;
		},
		{ responseMode: params.responseMode },
	);
}

async function performTypeText(params: TypeTextParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	if (isBrowserContextId(trimOrUndefined(params.contextId))) {
		throw new Error("type_text is not supported for browser contexts because it has no ref parameter. Use set_text with a browser ref from snapshot instead.");
	}
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const text = typeof params.text === "string" ? params.text : "";
	return await runActionTool(
		"type_text",
		signal,
		async (target) => await dispatchTypeText(text, target, signal),
		(target, returnedState) => `Inserted text in ${target.appName} — ${target.windowTitle}.${returnedState ? " Returned the latest semantic window state." : " Call snapshot/screenshot if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performSetText(params: SetTextParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails | ConfirmationDetails>> {
	const browserResult = await performBrowserSetText(params, signal);
	if (browserResult) return browserResult;
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const text = typeof params.text === "string" ? params.text : "";
	return await runActionTool(
		"set_text",
		signal,
		async (target) => await dispatchSetText({ ...params, text }, target, signal),
		(target, returnedState) => `Set text value in ${target.appName} — ${target.windowTitle}.${returnedState ? " Returned the latest semantic window state." : " Call snapshot/screenshot if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performKeypress(params: KeypressParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const keys = normalizeKeyList(params.keys);
	return await runActionTool(
		"keypress",
		signal,
		async (target) => await dispatchKeypress({ keys }, target, signal),
		(target, returnedState) => `Pressed ${keys.length} key${keys.length === 1 ? "" : "s"} in ${target.appName} — ${target.windowTitle}.${returnedState ? " Returned the latest semantic window state." : " Call snapshot/screenshot if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performScroll(params: ScrollParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails | ConfirmationDetails>> {
	const browserResult = await performBrowserScroll(params, signal);
	if (browserResult) return browserResult;
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	return await runActionTool(
		"scroll",
		signal,
		async (target) => await dispatchScroll(params, capture, target, signal),
		(target, returnedState) => {
			const suffix = returnedState ? " Returned the latest semantic window state." : " Call snapshot/screenshot if you need updated state.";
			return ref
				? `Scrolled ${ref} in ${target.appName} — ${target.windowTitle}.${suffix}`
				: `Scrolled at (${Math.round(x)},${Math.round(y)}) in ${target.appName} — ${target.windowTitle}.${suffix}`;
		},
		{ responseMode: params.responseMode },
	);
}

async function performMoveMouse(params: MoveMouseParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	return await runActionTool(
		"move_mouse",
		signal,
		async (target) => await dispatchMoveMouse(params, capture, target, signal),
		(target, returnedState) =>
			`Moved mouse to (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}.${returnedState ? " Returned the latest semantic window state." : " Call snapshot/screenshot if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performDrag(params: DragParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	return await runActionTool(
		"drag",
		signal,
		async (target) => await dispatchDrag(params, capture, target, signal),
		(target, returnedState) => `Dragged in ${target.appName} — ${target.windowTitle}.${returnedState ? " Returned the latest semantic window state." : " Call snapshot/screenshot if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performDoubleClick(params: ClickParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails | ConfirmationDetails>> {
	return await performClick({ ...params, clickCount: 2 }, signal, "double_click");
}

async function dispatchComputerAction(
	action: ComputerAction,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	switch (action.type) {
		case "click":
			return await dispatchClick(action, capture, target, signal);
		case "double_click":
			return await dispatchClick({ ...action, clickCount: 2 }, capture, target, signal);
		case "move_mouse":
			return await dispatchMoveMouse(action, capture, target, signal);
		case "drag":
			return await dispatchDrag(action, capture, target, signal);
		case "scroll":
			return await dispatchScroll(action, capture, target, signal);
		case "keypress":
			return await dispatchKeypress(action, target, signal);
		case "type_text":
			return await dispatchTypeText(action.text, target, signal);
		case "set_text":
			return await dispatchSetText(action, target, signal);
		case "wait": {
			const msRaw = action.ms ?? DEFAULT_WAIT_MS;
			if (!Number.isFinite(msRaw) || msRaw < 0) {
				throw new Error("wait.ms must be a non-negative number.");
			}
			await sleep(Math.min(60_000, Math.round(msRaw)), signal);
			return executionTrace("wait", "stealth", { fallbackUsed: false });
		}
		default:
			throw new Error(`Unsupported computer action '${(action as any)?.type ?? "unknown"}'.`);
	}
}

function actionMayChangeState(action: ComputerAction | undefined): boolean {
	return action?.type !== "wait";
}

function actionWindowMatchesTarget(selector: WindowSelector | undefined, target: ResolvedTarget): boolean {
	const normalized = normalizeWindowSelector(selector);
	if (!normalized) return true;
	if (target.windowRef === normalized) return true;
	const numeric = Number(normalized);
	return Number.isInteger(numeric) && numeric > 0 && target.windowId === numeric;
}

function frameForArrangePreset(params: ArrangeWindowParams, target: ResolvedTarget): { x: number; y: number; width: number; height: number } {
	if (params.preset === "left_half") return { x: 0, y: 25, width: 720, height: 875 };
	if (params.preset === "right_half") return { x: 720, y: 25, width: 720, height: 875 };
	if (params.preset === "top_half") return { x: 80, y: 25, width: 1200, height: 440 };
	if (params.preset === "bottom_half") return { x: 80, y: 465, width: 1200, height: 435 };
	if (params.preset === "center_large") return { x: 80, y: 80, width: 1200, height: 800 };
	return {
		x: toFiniteNumber(params.x, target.framePoints.x),
		y: toFiniteNumber(params.y, target.framePoints.y),
		width: toFiniteNumber(params.width, target.framePoints.w),
		height: toFiniteNumber(params.height, target.framePoints.h),
	};
}

async function performArrangeWindow(params: ArrangeWindowParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
	const frame = frameForArrangePreset(params, target);
	if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width < 100 || frame.height < 80) {
		throw new Error("arrange_window requires finite x, y, width, and height values, or a supported preset.");
	}
	return await withWindowWriteLock(target, async () => {
		const result = await bridgeCommand<any>(
			"setWindowFrame",
			{ ...nativeWindowRequest(target), x: frame.x, y: frame.y, width: frame.width, height: frame.height },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		);
		if (!toBoolean(result?.ok)) {
			throw new Error(`Unable to arrange window${result?.reason ? `: ${result.reason}` : "."}`);
		}
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal);
		return await buildToolResult(
			"arrange_window",
			`Arranged ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`,
			captureResult,
			executionTrace("window_frame", "stealth", { fallbackUsed: false }),
			signal,
		);
	});
}

function managedBrowserExecutable(browser: "helium" | "chrome"): string {
	return browser === "helium" ? HELIUM_EXECUTABLE : CHROME_EXECUTABLE;
}

function freeTcpPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => port > 0 ? resolve(port) : reject(new Error("Could not allocate a local CDP port.")));
		});
	});
}

async function waitForCdpPort(port: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + MANAGED_BROWSER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Browser launch was aborted.");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
			if (response.ok) return;
		} catch {
			// Browser is still starting.
		}
		await sleep(200, signal);
	}
	throw new Error(`Managed browser did not expose CDP on port ${port} within ${MANAGED_BROWSER_READY_TIMEOUT_MS}ms.`);
}

// Side effects: starts a Pi-managed browser process, replaces any previous managed browser,
// and sets PI_COMPUTER_USE_CDP_PORT for subsequent CDP context discovery.
async function performLaunchBrowserContext(params: LaunchBrowserContextParams, signal?: AbortSignal): Promise<AgentToolResult<LaunchBrowserContextDetails>> {
	const browser = params.browser === "chrome" ? "chrome" : "helium";
	const executable = managedBrowserExecutable(browser);
	await access(executable, fsConstants.X_OK).catch(() => {
		throw new Error(`${browser} executable was not found at ${executable}.`);
	});
	const port = Number.isInteger(params.port) && params.port! > 0 ? Math.trunc(params.port!) : await freeTcpPort();
	const url = trimOrUndefined(params.url) ?? "about:blank";
	const profileDir = path.join(os.tmpdir(), `pi-${browser}-cdp-${port}`);
	runtimeState.managedBrowser?.kill("SIGTERM");
	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		url,
	];
	runtimeState.managedBrowser = spawn(executable, args, { stdio: "ignore", detached: false });
	process.env.PI_COMPUTER_USE_CDP_PORT = String(port);
	await waitForCdpPort(port, signal);
	const contextsResult = await performListContexts(signal);
	const contexts = contextsResult.details.contexts.filter((context) => context.kind === "browser_page");
	const details: LaunchBrowserContextDetails = { tool: "launch_browser_context", browser, port, url, contexts };
	const lines = contexts.map((context) => `- ${context.contextId} ${context.title}${context.url ? ` — ${context.url}` : ""}`);
	return { content: [{ type: "text", text: `Launched ${browser} with CDP on port ${port}. Use snapshot({ contextId }) on a browser context.\n${lines.join("\n")}` }], details };
}

async function performNavigateBrowser(params: NavigateBrowserParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails>> {
	const contextId = trimOrUndefined(params.contextId);
	const url = trimOrUndefined(params.url);
	if (!url) throw new Error("navigate_browser.url must be a non-empty URL or browser-search string.");
	if (isBrowserContextId(contextId)) {
		if (!/^https?:/i.test(url)) throw new Error("navigate_browser with browser contextId only supports http(s) URLs.");
		const ok = await cdpNavigateContext(contextId, url);
		if (!ok) throw new Error(`Browser context '${contextId}' is no longer available. Call list_contexts and snapshot again.`);
		return await refreshBrowserSnapshot(contextId, params.image, signal);
	}
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
	assertBrowserUseAllowed(target);
	if (!isBrowserApp(target.appName, target.bundleId)) {
		throw new Error(`navigate_browser requires a browser window, but the target is '${target.appName}'.`);
	}
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1];
	const looksLikeUrl = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.test(url) || !/\s/.test(url);
	// Script/local schemes are blocked even when whitespace makes the input
	// look like a search string: "javascript:var x = 1; alert(x)" is a valid,
	// dangerous URL despite containing spaces.
	const dangerousScheme = scheme !== undefined && /^(javascript|data|file|vbscript)$/i.test(scheme);
	if (scheme && (looksLikeUrl || dangerousScheme) && !/^https?$/i.test(scheme)) {
		throw new Error(`navigate_browser only supports http(s) URLs or browser-search strings; '${scheme}:' URLs are not allowed.`);
	}
	// Prefer CDP when available: event-driven page-load wait, no AppleScript,
	// and no focus change. Bare search strings keep the AppleScript path,
	// which has address-bar semantics.
	const cdpTab = /^https?:/i.test(url) && isChromeFamilyApp(target.appName, target.bundleId)
		? await cdpTabForWindow(target.windowTitle, target.framePoints)
		: undefined;
	if (cdpTab) {
		return await withWindowWriteLock(target, async () => {
			await cdpTab.navigate(url);
			const captureResult = await captureCurrentTarget(signal);
			return await buildToolResult(
				"navigate_browser",
				`Navigated ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`,
				captureResult,
				executionTrace("cdp_navigate", "stealth", { axAttempted: false, axSucceeded: false, fallbackUsed: false }),
				signal,
			);
		});
	}

	const script = browserOpenLocationAppleScript(target, url);
	if (!script) {
		throw new Error(`navigate_browser does not yet support direct URL navigation for '${target.appName}'. Use keypress Command+L, type_text, Enter instead.`);
	}
	return await withWindowWriteLock(target, async () => {
		await focusControlledWindow(target, signal);
		await runAppleScript(script, signal);
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal);
		return await buildToolResult(
			"navigate_browser",
			`Navigated ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`,
			captureResult,
			executionTrace("browser_open_location", "stealth", { axAttempted: false, axSucceeded: false, fallbackUsed: false }),
			signal,
		);
	});
}

async function performEvaluateBrowser(params: EvaluateBrowserParams): Promise<AgentToolResult<EvaluateBrowserDetails>> {
	const contextId = trimOrUndefined(params.contextId);
	const expression = typeof params.expression === "string" ? params.expression : "";
	if (!isBrowserContextId(contextId)) throw new Error("evaluate_browser.contextId must be a browser context id from list_contexts.");
	if (!expression.trim()) throw new Error("evaluate_browser.expression must be non-empty JavaScript.");
	const result = await cdpEvaluateForContext(contextId, expression);
	if (!result) throw new Error(`Browser context '${contextId}' is no longer available. Call list_contexts and snapshot again.`);
	const details: EvaluateBrowserDetails = { tool: "evaluate_browser", contextId, value: result.value };
	return { content: [{ type: "text", text: `Evaluated JavaScript in ${contextId}: ${JSON.stringify(result.value)}` }], details };
}

async function performComputerActions(params: ComputerActionsParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	const actions = Array.isArray(params.actions) ? params.actions : [];
	if (actions.length === 0) {
		throw new Error("computer_actions.actions must contain at least one action.");
	}
	if (actions.length > BATCH_MAX_ACTIONS) {
		throw new Error(`computer_actions supports at most ${BATCH_MAX_ACTIONS} actions per call.`);
	}

	const currentTarget = await resolveCurrentTarget(signal);
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		let axAttempted = false;
		let axSucceeded = false;
		let fallbackUsed = false;
		let stealthCompatible = true;
		let coordinateStateChanged = false;
		let coordinateVerification: ExecutionTrace["coordinateVerification"] | undefined;
		const nonStealthReasons = new Set<string>();
		const actionTraces: BatchActionTrace[] = [];

		for (let index = 0; index < actions.length; index += 1) {
			const action = actions[index];
			if (!action || typeof (action as any).type !== "string") {
				throw new Error(`computer_actions action ${index + 1} is missing a valid type.`);
			}
			if (!actionWindowMatchesTarget((action as any).window, readyTarget)) {
				throw new Error(
					`computer_actions action ${index + 1} targets a different window. Use one computer_actions call per window, or set the top-level window field to the intended target.`,
				);
			}
			const actionStateId = (action as any)?.stateId;
			if (actionStateId && actionStateId !== capture.stateId) {
				throw new Error(`computer_actions action ${index + 1} uses stale state '${actionStateId}'. Refresh with screenshot and retry.`);
			}
			let trace: ExecutionTrace;
			const startedAt = Date.now();
			try {
				trace = await dispatchComputerAction(action, capture, readyTarget, signal);
			} catch (error) {
				const actionType = (action as any)?.type ?? "unknown";
				throw new Error(`computer_actions action ${index + 1} (${actionType}) failed: ${normalizeError(error).message}`);
			}
			actionTraces.push({
				index: index + 1,
				type: action.type,
				strategy: trace.strategy,
				durationMs: Math.max(0, Date.now() - startedAt),
				axAttempted: trace.axAttempted,
				axSucceeded: trace.axSucceeded,
				fallbackUsed: trace.fallbackUsed,
				runtimeMode: trace.runtimeMode,
				variant: trace.variant,
				stealthCompatible: trace.stealthCompatible,
				nonStealthReason: trace.nonStealthReason,
				grounding: trace.grounding,
				delivery: trace.delivery,
				deliveryPolicy: trace.deliveryPolicy,
				coordinateStateChanged: trace.coordinateStateChanged,
				coordinateVerification: trace.coordinateVerification,
			});
			if (actionMayChangeState(action)) {
				stateMayHaveChanged = true;
			}
			axAttempted ||= trace.axAttempted === true;
			axSucceeded ||= trace.axSucceeded === true;
			fallbackUsed ||= trace.fallbackUsed === true;
			coordinateStateChanged ||= trace.coordinateStateChanged === true;
			coordinateVerification = trace.coordinateVerification ?? coordinateVerification;
			stealthCompatible &&= trace.stealthCompatible === true;
			if (trace.nonStealthReason) {
				nonStealthReasons.add(trace.nonStealthReason);
			}
			if (index + 1 < actions.length && action?.type !== "wait") {
				await sleep(BATCH_ACTION_GAP_MS, signal);
			}
		}

		const execution = executionTrace("batch", stealthCompatible ? "stealth" : "default", {
			actionCount: actions.length,
			completedActionCount: actionTraces.length,
			actions: actionTraces,
			axAttempted,
			axSucceeded,
			fallbackUsed,
			coordinateStateChanged: coordinateVerification ? coordinateStateChanged : undefined,
			coordinateVerification,
			nonStealthReason: nonStealthReasons.size > 0 ? [...nonStealthReasons].join(",") : undefined,
		});
		await sleep(settleMsForExecution(execution), signal);
		const captureResult = await captureCurrentTarget(signal);
		const summary = `Executed ${actions.length} computer action${actions.length === 1 ? "" : "s"} in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
		return await buildToolResult("computer_actions", summary, captureResult, execution, signal);
	} catch (error) {
		if (stateMayHaveChanged) {
			await sleep(ACTION_SETTLE_MS, signal).catch(() => undefined);
			await captureCurrentTarget(signal).catch(() => undefined);
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

async function performWait(params: WaitParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	if (!runtimeState.currentTarget) {
		throw new Error(MISSING_TARGET_ERROR);
	}

	const msRaw = params.ms ?? DEFAULT_WAIT_MS;
	if (!Number.isFinite(msRaw) || msRaw < 0) {
		throw new Error("wait.ms must be a non-negative number.");
	}

	const ms = Math.min(60_000, Math.round(msRaw));
	await sleep(ms, signal);
	const captureResult = await captureCurrentTarget(signal);
	const summary = `Waited ${ms}ms in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
	return await buildToolResult("wait", summary, captureResult, executionTrace("wait", "stealth", { fallbackUsed: false }), signal);
}

async function executeTool<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	return await withRuntimeLock(async () => {
		await ensureReady(ctx, signal);
		throwIfAborted(signal);

		return await run();
	});
}

function makeToolExecutor<P, D>(perform: (params: P, signal?: AbortSignal) => Promise<AgentToolResult<D>>) {
	return async (
		_toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback<D> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<D>> => await executeTool(ctx, signal, () => perform(params, signal));
}

export const executeListApps = makeToolExecutor((_params: Record<string, never>, signal) => performListApps(signal));
export const executeListWindows = makeToolExecutor(performListWindows);
export const executeListContexts = makeToolExecutor((_params: Record<string, never>, signal) => performListContexts(signal));
export const executeSnapshot = makeToolExecutor(performSnapshot);
export const executeReadText = makeToolExecutor(performReadText);
export const executeWaitFor = makeToolExecutor(performWaitFor);
export const executeScreenshot = makeToolExecutor(performScreenshot);
export const executeClick = makeToolExecutor<ClickParams, ComputerUseDetails | SnapshotDetails | ConfirmationDetails>(performClick);
export const executeDoubleClick = makeToolExecutor(performDoubleClick);
export const executeMoveMouse = makeToolExecutor(performMoveMouse);
export const executeDrag = makeToolExecutor(performDrag);
export const executeScroll = makeToolExecutor(performScroll);
export const executeKeypress = makeToolExecutor(performKeypress);
export const executeTypeText = makeToolExecutor(performTypeText);
export const executeSetText = makeToolExecutor(performSetText);
export const executeArrangeWindow = makeToolExecutor(performArrangeWindow);
export const executeNavigateBrowser = makeToolExecutor(performNavigateBrowser);
export const executeEvaluateBrowser = makeToolExecutor(performEvaluateBrowser);
export const executeLaunchBrowserContext = makeToolExecutor(performLaunchBrowserContext);
export const executeComputerActions = makeToolExecutor(performComputerActions);
export const executeWait = makeToolExecutor(performWait);

export function reconstructStateFromBranch(ctx: ExtensionContext): void {
	runtimeState.currentTarget = undefined;
	runtimeState.currentCapture = undefined;
	runtimeState.currentStateTarget = undefined;
	runtimeState.currentAxTargets = undefined;
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.nextWindowRefIndex = 1;

	let restoredCurrent = false;
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any).message;
		if (!message || message.role !== "toolResult") continue;
		if (!TOOL_NAMES.has(message.toolName)) continue;

		const rawDetails = message.details as any;
		if (rawDetails?.tool === "list_windows" && Array.isArray(rawDetails.windows)) {
			for (const window of rawDetails.windows) {
				if (typeof window?.windowRef !== "string" || !Number.isFinite(window?.pid)) continue;
				const record: WindowRefRecord = {
					ref: window.windowRef,
					appName: typeof window.app === "string" ? window.app : "Unknown App",
					bundleId: typeof window.bundleId === "string" ? window.bundleId : undefined,
					pid: Math.trunc(window.pid),
					windowTitle: typeof window.windowTitle === "string" ? window.windowTitle : "(untitled)",
					windowId: Number.isFinite(window.windowId) ? Math.trunc(window.windowId) : undefined,
					nativeWindowRef: typeof window.nativeWindowRef === "string" ? window.nativeWindowRef : undefined,
					framePoints: parseFramePoints({ framePoints: window.framePoints }),
					scaleFactor: Math.max(1, toFiniteNumber(window.scaleFactor, 1)),
					isMinimized: toBoolean(window.isMinimized),
					isOnscreen: toBoolean(window.isOnscreen),
					isMain: toBoolean(window.isMain),
					isFocused: toBoolean(window.isFocused),
				};
				runtimeState.windowRefs.set(record.ref, record);
				runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), record.ref);
				const match = /^@w(\d+)$/.exec(record.ref);
				if (match) runtimeState.nextWindowRefIndex = Math.max(runtimeState.nextWindowRefIndex, Number(match[1]) + 1);
			}
			continue;
		}

		if (restoredCurrent) continue;

		const details = rawDetails as Partial<ComputerUseDetails> | undefined;
		if (!details?.target || !details?.capture) continue;

		const app =
			typeof details.target.app === "string"
				? details.target.app
				: typeof (details.target as any).appName === "string"
					? (details.target as any).appName
					: undefined;

		if (!app) continue;
		if (!Number.isFinite(details.target.pid) || !Number.isFinite(details.target.windowId)) continue;
		if (typeof details.capture.stateId !== "string") continue;

		runtimeState.currentTarget = {
			appName: app,
			bundleId: details.target.bundleId,
			pid: Math.trunc(details.target.pid),
			windowTitle: details.target.windowTitle ?? "(untitled)",
			windowId: Math.trunc(details.target.windowId),
			windowRef: typeof details.target.windowRef === "string" ? details.target.windowRef : undefined,
			nativeWindowRef: typeof (details.target as any).nativeWindowRef === "string" ? (details.target as any).nativeWindowRef : undefined,
		};

		runtimeState.currentCapture = {
			stateId: details.capture.stateId,
			width: Math.max(1, Math.trunc(toFiniteNumber(details.capture.width, 1))),
			height: Math.max(1, Math.trunc(toFiniteNumber(details.capture.height, 1))),
			scaleFactor: Math.max(1, toFiniteNumber(details.capture.scaleFactor, 1)),
			timestamp: Number.isFinite(details.capture.timestamp) ? details.capture.timestamp : Date.now(),
		};
		runtimeState.currentAxTargets = Array.isArray(details.axTargets)
			? details.axTargets.filter((item): item is AxTarget => Boolean(item && typeof item.ref === "string" && typeof item.elementRef === "string"))
			: undefined;

		restoredCurrent = true;
		continue;
	}
}

export function stopBridge(): void {
	runtimeState.daemonAvailable = false;
}
