import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ensurePermissions, type PermissionStatus } from "./permissions.ts";

export interface ScreenshotParams {
	app?: string;
	windowTitle?: string;
}

export interface ClickParams {
	x?: number;
	y?: number;
	ref?: string;
	captureId?: string;
	button?: MouseButtonName;
	clickCount?: number;
}

export interface TypeTextParams {
	text: string;
}

export interface SetTextParams {
	text: string;
}

export interface KeypressParams {
	keys: string[];
}

export interface ScrollParams {
	x: number;
	y: number;
	scrollX?: number;
	scrollY?: number;
	captureId?: string;
}

export interface MoveMouseParams {
	x: number;
	y: number;
	captureId?: string;
}

export interface DragParams {
	path: Array<{ x: number; y: number } | [number, number]>;
	captureId?: string;
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

export interface ComputerActionsParams {
	actions: ComputerAction[];
	captureId?: string;
}

export interface WaitParams {
	ms?: number;
}

export interface CurrentTarget {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId: number;
}

export interface CurrentCapture {
	captureId: string;
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

interface ExecutionTrace {
	strategy:
		| "screenshot"
		| "wait"
		| "batch"
		| "ax_press"
		| "ax_focus"
		| "coordinate_event_click"
		| "coordinate_event_double_click"
		| "coordinate_event_move"
		| "coordinate_event_drag"
		| "coordinate_event_scroll"
		| "ax_set_value"
		| "raw_keypress"
		| "raw_key_text";
	axAttempted?: boolean;
	axSucceeded?: boolean;
	fallbackUsed?: boolean;
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
}

export interface ComputerUseDetails {
	tool: string;
	target: {
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId: number;
	};
	capture: {
		captureId: string;
		width: number;
		height: number;
		scaleFactor: number;
		timestamp: number;
		coordinateSpace: "window-relative-screenshot-pixels";
	};
	axTargets?: AxTarget[];
	activation: ActivationFlags;
	execution: ExecutionTrace;
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
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

interface FrontmostResult {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle?: string;
	windowId?: number;
}

interface RestoreUserFocusResult {
	restored: boolean;
	appRestored?: boolean;
	windowRestored?: boolean;
	appName?: string;
	windowTitle?: string;
}

interface ScreenshotPayload {
	pngBase64: string;
	width: number;
	height: number;
	scaleFactor: number;
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
	value?: string;
	actions?: string[];
	x?: number;
	y?: number;
	score?: number;
}

interface ResolvedTarget extends CurrentTarget {
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

interface PendingRequest {
	cmd: string;
	resolve: (value: any) => void;
	reject: (reason?: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
	abortListener?: () => void;
}

interface AxTarget {
	ref: string;
	elementRef: string;
	role: string;
	subrole: string;
	title: string;
	description: string;
	value: string;
	actions: string[];
	x: number;
	y: number;
	score?: number;
}

interface RuntimeState {
	currentTarget?: CurrentTarget;
	currentCapture?: CurrentCapture;
	currentAxTargets?: AxTarget[];
	helper?: ChildProcessWithoutNullStreams;
	helperStdoutBuffer: string;
	pending: Map<string, PendingRequest>;
	requestSequence: number;
	queueTail: Promise<void>;
	permissionStatus?: PermissionStatus;
	lastPermissionCheckAt: number;
	helperInstallChecked: boolean;
}

type MouseButtonName = "left" | "right" | "middle";

const TOOL_NAMES = new Set([
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
	"computer_actions",
]);

const MISSING_TARGET_ERROR = "No current controlled window. Call screenshot first to choose a target window.";
const CURRENT_TARGET_GONE_ERROR =
	"The current controlled window is no longer available. Call screenshot to choose a new target window.";
const STALE_CAPTURE_ERROR =
	"The coordinates were based on an older screenshot. Call screenshot again to refresh the current window state.";
const NON_MACOS_ERROR = "pi-computer-use currently supports macOS 15+ only.";

const COMMAND_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 25_000;
const HELPER_SETUP_TIMEOUT_MS = 60_000;
const ACTION_SETTLE_MS = 280;
const BATCH_ACTION_GAP_MS = 80;
const BATCH_MAX_ACTIONS = 20;
const DEFAULT_WAIT_MS = 1_000;

const RECOVERABLE_SCREENSHOT_ERROR_CODES = new Set(["screenshot_timeout", "window_not_found"]);
const STRICT_AX_MODE = process.env.PI_COMPUTER_USE_STEALTH === "1" || process.env.PI_COMPUTER_USE_STRICT_AX === "1";
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
const BROWSER_WINDOW_OPEN_POLL_MS = 200;
const BROWSER_WINDOW_OPEN_ATTEMPTS = 12;

export const HELPER_STABLE_PATH = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "bridge");

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");

const runtimeState: RuntimeState = {
	helperStdoutBuffer: "",
	pending: new Map(),
	requestSequence: 0,
	queueTail: Promise.resolve(),
	lastPermissionCheckAt: 0,
	helperInstallChecked: false,
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

function normalizeError(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error(String(error));
}

function isRecoverableScreenshotError(error: unknown): error is HelperCommandError {
	return error instanceof HelperCommandError && !!error.code && RECOVERABLE_SCREENSHOT_ERROR_CODES.has(error.code);
}

function strictModeBlock(message: string): never {
	throw new Error(`${message} Strict AX mode is enabled, so non-AX fallback is blocked.`);
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

function randomCaptureId(): string {
	try {
		return randomUUID();
	} catch {
		return `cap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

function validateCaptureId(captureId?: string): CurrentCapture {
	if (!runtimeState.currentTarget || !runtimeState.currentCapture) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	if (captureId && runtimeState.currentCapture.captureId !== captureId) {
		throw new Error(STALE_CAPTURE_ERROR);
	}
	return runtimeState.currentCapture;
}

function parseAxTargets(result: unknown): AxTarget[] {
	const items = Array.isArray(result) ? result : (result as any)?.targets;
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
				title: toOptionalString(target?.title) ?? "",
				description: toOptionalString(target?.description) ?? "",
				value: toOptionalString(target?.value) ?? "",
				actions,
				x: toFiniteNumber(target?.x, 0),
				y: toFiniteNumber(target?.y, 0),
				score: Number.isFinite(target?.score) ? Number(target.score) : undefined,
			} as AxTarget;
		})
		.filter((item): item is AxTarget => Boolean(item));
}

function formatAxTargetLabel(target: AxTarget): string {
	const label = target.title || target.description || target.value || "(unlabeled)";
	return `${target.ref} ${target.role}${target.subrole ? `/${target.subrole}` : ""} ${JSON.stringify(label)}`;
}

function imageFallbackReason(tool: string, result: CaptureResult, execution: ExecutionTrace): string | undefined {
	if (execution.fallbackUsed === true) {
		return "The action used a non-semantic fallback path, so an image is attached for recovery."
	}
	if (result.axTargets.length === 0) {
		return "No useful AX targets were found, so an image is attached for vision fallback."
	}
	if (result.axTargets.length < 3) {
		return "Only a few AX targets were found, so an image is attached for extra context."
	}

	const labels = result.axTargets.map((target) => normalizeText(target.title || target.description || target.value)).filter(Boolean)
	const unlabeledCount = result.axTargets.filter((target) => !normalizeText(target.title || target.description || target.value)).length
	const strongTextRoles = new Set(["AXTextField", "AXSearchField", "AXTextArea", "AXTextView", "AXEditableText"])
	const strongTargets = result.axTargets.filter((target) => {
		const label = normalizeText(target.title || target.description || target.value)
		return strongTextRoles.has(target.role) || (!!label && (target.actions.includes("AXPress") || target.role === "AXLink" || target.role === "AXButton"))
	})
	if (strongTargets.length === 0) {
		return "No strong AX targets were found, so an image is attached for vision fallback."
	}
	if (result.axTargets.length < 3 && !strongTargets.some((target) => strongTextRoles.has(target.role))) {
		return "Only a few AX targets were found, so an image is attached for extra context."
	}
	if (result.axTargets.length >= 3 && unlabeledCount * 2 > result.axTargets.length) {
		return "Most AX targets are unlabeled, so an image is attached for vision fallback."
	}
	if (labels.length > 3 && new Set(labels).size * 2 <= labels.length) {
		return "AX target labels are highly duplicated, so an image is attached for extra context."
	}
	if (tool === "wait" && isBrowserApp(result.target.appName, result.target.bundleId)) {
		return "Browser content may have changed visually during wait, so an image is attached for fallback."
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

function rejectAllPending(error: Error): void {
	for (const [id, pending] of runtimeState.pending) {
		clearTimeout(pending.timer);
		if (pending.abortListener) {
			pending.abortListener();
		}
		runtimeState.pending.delete(id);
		pending.reject(error);
	}
}

function handleHelperStdoutChunk(chunk: string): void {
	runtimeState.helperStdoutBuffer += chunk;

	while (true) {
		const newlineIndex = runtimeState.helperStdoutBuffer.indexOf("\n");
		if (newlineIndex < 0) break;

		const line = runtimeState.helperStdoutBuffer.slice(0, newlineIndex).trim();
		runtimeState.helperStdoutBuffer = runtimeState.helperStdoutBuffer.slice(newlineIndex + 1);
		if (!line) continue;

		let parsed: any;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		const id = typeof parsed?.id === "string" ? parsed.id : undefined;
		if (!id) continue;

		const pending = runtimeState.pending.get(id);
		if (!pending) continue;
		runtimeState.pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.abortListener) pending.abortListener();

		if (parsed.ok === true) {
			pending.resolve(parsed.result);
		} else {
			const message =
				typeof parsed?.error?.message === "string" ? parsed.error.message : `Helper command '${pending.cmd}' failed.`;
			const code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
			pending.reject(new HelperCommandError(message, code));
		}
	}
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
): Promise<void> {
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
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
	const helperAlreadyPresent = await isExecutable(HELPER_STABLE_PATH);
	if (helperAlreadyPresent && runtimeState.helperInstallChecked) {
		return;
	}

	await runProcess(process.execPath, [SETUP_HELPER_SCRIPT, "--runtime"], HELPER_SETUP_TIMEOUT_MS, signal);
	runtimeState.helperInstallChecked = true;

	if (!(await isExecutable(HELPER_STABLE_PATH))) {
		throw new Error(`Failed to install pi-computer-use helper at ${HELPER_STABLE_PATH}.`);
	}
}

async function startBridgeProcess(): Promise<ChildProcessWithoutNullStreams> {
	if (!(await isExecutable(HELPER_STABLE_PATH))) {
		throw new HelperTransportError(`Computer-use helper is missing at ${HELPER_STABLE_PATH}.`);
	}

	const child = spawn(HELPER_STABLE_PATH, [], {
		stdio: ["pipe", "pipe", "pipe"],
	});

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdin.setDefaultEncoding("utf8");

	child.stdout.on("data", (chunk: string) => {
		handleHelperStdoutChunk(chunk);
	});

	child.stderr.on("data", (_chunk: string) => {
		// helper diagnostics are intentionally not forwarded to tool output
	});

	child.on("error", (error) => {
		if (runtimeState.helper === child) {
			runtimeState.helper = undefined;
		}
		rejectAllPending(new HelperTransportError(`Computer-use helper crashed: ${error.message}`));
	});

	child.on("exit", (code, sig) => {
		if (runtimeState.helper === child) {
			runtimeState.helper = undefined;
		}
		const reason = sig ? `signal ${sig}` : `exit code ${code ?? "unknown"}`;
		rejectAllPending(new HelperTransportError(`Computer-use helper exited (${reason}).`));
	});

	runtimeState.helper = child;
	runtimeState.helperStdoutBuffer = "";
	return child;
}

async function ensureBridgeProcess(): Promise<ChildProcessWithoutNullStreams> {
	if (runtimeState.helper && runtimeState.helper.exitCode === null && !runtimeState.helper.killed) {
		return runtimeState.helper;
	}
	return await startBridgeProcess();
}

async function bridgeCommand<T>(
	cmd: string,
	args: Record<string, unknown> = {},
	options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
	const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		throwIfAborted(options?.signal);
		const helper = await ensureBridgeProcess();
		const id = `req_${++runtimeState.requestSequence}`;

		try {
			const result = await new Promise<T>((resolve, reject) => {
				const payload = `${JSON.stringify({ id, cmd, ...args })}\n`;
				const timer = setTimeout(() => {
					runtimeState.pending.delete(id);
					reject(new HelperTransportError(`Helper command '${cmd}' timed out after ${timeoutMs}ms.`));
				}, timeoutMs);

				const pending: PendingRequest = {
					cmd,
					resolve,
					reject,
					timer,
				};

				const abortListener = () => {
					if (runtimeState.pending.delete(id)) {
						clearTimeout(timer);
						reject(new Error("Operation aborted."));
					}
				};

				if (options?.signal) {
					options.signal.addEventListener("abort", abortListener, { once: true });
					pending.abortListener = () => options.signal?.removeEventListener("abort", abortListener);
				}

				runtimeState.pending.set(id, pending);

				helper.stdin.write(payload, (error) => {
					if (!error) return;
					const p = runtimeState.pending.get(id);
					if (!p) return;
					runtimeState.pending.delete(id);
					clearTimeout(p.timer);
					if (p.abortListener) p.abortListener();
					reject(new HelperTransportError(`Failed to send command '${cmd}': ${error.message}`));
				});
			});

			return result;
		} catch (error) {
			if (error instanceof HelperTransportError && attempt === 0) {
				stopBridge();
				continue;
			}
			throw normalizeError(error);
		}
	}

	throw new Error(`Helper command '${cmd}' failed.`);
}

async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
	const result = await bridgeCommand<any>("checkPermissions", {}, { signal });
	return {
		accessibility: toBoolean(result?.accessibility),
		screenRecording: toBoolean(result?.screenRecording),
	};
}

async function ensureReady(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error(NON_MACOS_ERROR);
	}

	throwIfAborted(signal);
	await ensureHelperInstalled(signal);
	await ensureBridgeProcess();

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
		status = await ensurePermissions(
			ctx,
			{
				checkPermissions: (permissionSignal) => checkPermissions(permissionSignal ?? signal),
				openPermissionPane: async (kind, permissionSignal) => {
					await bridgeCommand("openPermissionPane", { kind }, { signal: permissionSignal ?? signal });
				},
			},
			HELPER_STABLE_PATH,
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

function parseWindows(result: unknown): HelperWindow[] {
	const array = Array.isArray(result) ? result : (result as any)?.windows;
	if (!Array.isArray(array)) return [];

	return array.map((raw) => ({
		windowId: Number.isFinite((raw as any)?.windowId) ? Math.trunc((raw as any).windowId) : undefined,
		windowRef: toOptionalString((raw as any)?.windowRef),
		title: toOptionalString((raw as any)?.title) ?? "",
		framePoints: parseFramePoints(raw),
		scaleFactor: Math.max(1, toFiniteNumber((raw as any)?.scaleFactor, 1)),
		isMinimized: toBoolean((raw as any)?.isMinimized),
		isOnscreen: toBoolean((raw as any)?.isOnscreen),
		isMain: toBoolean((raw as any)?.isMain),
		isFocused: toBoolean((raw as any)?.isFocused),
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

async function beginInputSuppression(signal?: AbortSignal): Promise<void> {
	await bridgeCommand("beginInputSuppression", {}, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
}

async function endInputSuppression(signal?: AbortSignal): Promise<void> {
	await bridgeCommand("endInputSuppression", {}, { signal, timeoutMs: COMMAND_TIMEOUT_MS }).catch(() => undefined);
}

async function restoreUserFocus(target: FrontmostResult, signal?: AbortSignal): Promise<void> {
	const restoreResult = await bridgeCommand<RestoreUserFocusResult>(
		"restoreUserFocus",
		{ pid: target.pid, windowTitle: target.windowTitle },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => undefined);

	if (STRICT_AX_MODE || toBoolean(restoreResult?.windowRestored) || toBoolean(restoreResult?.appRestored)) {
		return;
	}

	const activateTarget = target.bundleId
		? `application id "${escapeAppleScriptString(target.bundleId)}"`
		: `application "${escapeAppleScriptString(target.appName)}"`;
	await runAppleScript([`tell ${activateTarget} to activate`], signal).catch(() => undefined);
}

async function focusControlledWindow(target: ResolvedTarget, signal?: AbortSignal): Promise<void> {
	const result = await bridgeCommand<FocusWindowResult>(
		"focusWindow",
		{ pid: target.pid, windowId: target.windowId },
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

function windowIdentity(window: HelperWindow): string {
	if (window.windowId && window.windowId > 0) {
		return `id:${window.windowId}`;
	}
	if (window.windowRef) {
		return `ref:${window.windowRef}`;
	}
	const { x, y, w, h } = window.framePoints;
	return `title:${normalizeText(window.title)}|frame:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

function escapeAppleScriptString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function buildBrowserNewWindowAppleScript(app: HelperApp): string[] | undefined {
	const normalizedName = normalizeText(app.appName);
	const target = app.bundleId
		? `application id "${escapeAppleScriptString(app.bundleId)}"`
		: `application "${escapeAppleScriptString(app.appName)}"`;

	if (app.bundleId === "com.apple.Safari" || normalizedName === "safari") {
		return [`tell ${target} to make new document`];
	}

	if (CHROME_FAMILY_BUNDLE_IDS.has(app.bundleId ?? "") || CHROME_FAMILY_APP_NAMES.has(normalizedName)) {
		return [`tell ${target} to make new window`];
	}

	if (app.bundleId === "org.mozilla.firefox" || normalizedName === "firefox") {
		return [
			`tell ${target} to activate`,
			'tell application "System Events" to keystroke "n" using command down',
		];
	}

	return undefined;
}

async function runAppleScript(lines: string[], signal?: AbortSignal): Promise<void> {
	const args = lines.flatMap((line) => ["-e", line]);
	await runProcess("osascript", args, BROWSER_WINDOW_OPEN_TIMEOUT_MS, signal);
}

function findNewWindow(before: HelperWindow[], after: HelperWindow[]): HelperWindow | undefined {
	const previous = new Set(before.map(windowIdentity));
	const added = after.filter((window) => !previous.has(windowIdentity(window)));
	if (added.length > 0) {
		return choosePreferredWindow(added, "browser");
	}

	const promoted = after.filter((window) => {
		const match = before.find((candidate) => windowIdentity(candidate) === windowIdentity(window));
		if (!match) return false;
		return (window.isFocused && !match.isFocused) || (window.isMain && !match.isMain);
	});
	if (promoted.length > 0) {
		return choosePreferredWindow(promoted, "browser");
	}

	return undefined;
}

async function openIsolatedBrowserWindow(app: HelperApp, signal?: AbortSignal): Promise<HelperWindow | undefined> {
	const script = buildBrowserNewWindowAppleScript(app);
	if (!script) {
		return undefined;
	}
	if (STRICT_AX_MODE) {
		strictModeBlock(
			`Strict AX mode cannot create an isolated browser window for '${app.appName}' because that bootstrap is not AX-only. Open a dedicated browser window first, then call screenshot again.`,
		);
	}

	const previousFrontmost = await getFrontmost(signal).catch(() => undefined);
	const before = await listWindows(app.pid, signal);
	await runAppleScript(script, signal);

	await beginInputSuppression(signal);
	try {
		for (let attempt = 0; attempt < BROWSER_WINDOW_OPEN_ATTEMPTS; attempt += 1) {
			await sleep(BROWSER_WINDOW_OPEN_POLL_MS, signal);
			const after = await listWindows(app.pid, signal);
			const created = findNewWindow(before, after);
			if (created) {
				return created;
			}
			const focused = after.find((window) => window.isFocused) ?? after.find((window) => window.isMain);
			if (focused && !before.some((window) => windowIdentity(window) === windowIdentity(focused))) {
				return focused;
			}
		}

		return undefined;
	} finally {
		if (previousFrontmost) {
			await restoreUserFocus(previousFrontmost, signal);
		}
		await endInputSuppression(signal);
	}
}

function choosePreferredWindow(windows: HelperWindow[], appName: string): HelperWindow {
	if (!windows.length) {
		throw new Error(`No controllable window was found in app '${appName}'.`);
	}

	const scored = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	return scored[0];
}

function scoreWindow(window: HelperWindow): number {
	let score = 0;
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
	return {
		appName: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		windowTitle: window.title || "(untitled)",
		windowId: typeof window.windowId === "number" ? window.windowId : 0,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
	};
}

function setCurrentTarget(target: ResolvedTarget): void {
	runtimeState.currentTarget = {
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
		windowTitle: target.windowTitle,
		windowId: target.windowId,
	};
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
		const isolated = await openIsolatedBrowserWindow(app, signal);
		if (isolated) {
			const resolved = toResolvedTarget(app, isolated);
			setCurrentTarget(resolved);
			return resolved;
		}
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
			if (currentBrowserWindow) {
				window = currentBrowserWindow;
			} else {
				const isolated = await openIsolatedBrowserWindow(app, signal);
				if (isolated) {
					window = isolated;
				} else {
					windows = await listWindows(app.pid, signal);
					window = choosePreferredWindow(windows, app.appName);
				}
			}
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

async function helperScreenshot(windowId: number, signal?: AbortSignal): Promise<ScreenshotPayload> {
	const result = await bridgeCommand<any>(
		"screenshot",
		{ windowId },
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
			const image = await helperScreenshot(candidateTarget.windowId, signal);
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
	activation: ActivationFlags;
}

function captureForTarget(target: ResolvedTarget): CurrentCapture {
	return {
		captureId: randomCaptureId(),
		width: Math.max(1, Math.round(target.framePoints.w * target.scaleFactor)),
		height: Math.max(1, Math.round(target.framePoints.h * target.scaleFactor)),
		scaleFactor: target.scaleFactor,
		timestamp: Date.now(),
	};
}

async function ensureCaptureImage(result: CaptureResult, signal?: AbortSignal): Promise<void> {
	if (result.image) return;
	try {
		result.image = await helperScreenshot(result.target.windowId, signal);
		result.capture.width = result.image.width;
		result.capture.height = result.image.height;
		result.capture.scaleFactor = result.image.scaleFactor;
	} catch (error) {
		if (!isRecoverableScreenshotError(error)) {
			throw normalizeError(error);
		}
		const recovered = await recoverCaptureFromHelperFailure(result.target, error, signal);
		result.target = recovered.target;
		result.image = recovered.image;
		result.capture.width = recovered.image.width;
		result.capture.height = recovered.image.height;
		result.capture.scaleFactor = recovered.image.scaleFactor;
		result.axTargets = parseAxTargets(
			await bridgeCommand(
				"axListTargets",
				{ pid: result.target.pid, windowId: result.target.windowId, limit: 12 },
				{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
			).catch(() => []),
		);
	}
	setCurrentTarget(result.target);
	runtimeState.currentCapture = result.capture;
	runtimeState.currentAxTargets = result.axTargets;
}

async function captureCurrentTarget(signal?: AbortSignal, priorActivation = emptyActivation()): Promise<CaptureResult> {
	let target = await resolveCurrentTarget(signal);
	let activation = { ...priorActivation };

	target = await ensureTargetWindowId(target, signal);

	const capture = captureForTarget(target);
	const axTargets = parseAxTargets(
		await bridgeCommand(
			"axListTargets",
			{ pid: target.pid, windowId: target.windowId, limit: 12 },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => []),
	);

	setCurrentTarget(target);
	runtimeState.currentCapture = capture;
	runtimeState.currentAxTargets = axTargets;

	return {
		target,
		capture,
		axTargets,
		activation,
	};
}

async function buildToolResult(
	tool: string,
	summary: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
	const fallbackReason = imageFallbackReason(tool, result, execution);
	if (fallbackReason) {
		await ensureCaptureImage(result, signal);
	}

	const details: ComputerUseDetails = {
		tool,
		target: {
			app: result.target.appName,
			bundleId: result.target.bundleId,
			pid: result.target.pid,
			windowTitle: result.target.windowTitle,
			windowId: result.target.windowId,
		},
		capture: {
			captureId: result.capture.captureId,
			width: result.capture.width,
			height: result.capture.height,
			scaleFactor: result.capture.scaleFactor,
			timestamp: result.capture.timestamp,
			coordinateSpace: "window-relative-screenshot-pixels",
		},
		axTargets: result.axTargets,
		activation: result.activation,
		execution,
	};
	const axTargetText = result.axTargets.length
		? `\n\nPrefer these AX targets over coordinate clicks when one matches your intent:\n${result.axTargets.map(formatAxTargetLabel).join("\n")}`
		: "";
	const fallbackText = fallbackReason ? `\n\n${fallbackReason}` : "";
	const content: AgentToolResult<ComputerUseDetails>["content"] = [{ type: "text", text: `${summary}${axTargetText}${fallbackText}` }];
	if (fallbackReason) {
		content.push({ type: "image", data: result.image!.pngBase64, mimeType: "image/png" });
	}

	return { content, details };
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

	if (ref) {
		if (button !== "left") {
			throw new Error(`AX target refs only support left-button clicks. Use coordinates for ${button}-click.`);
		}
		const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
		if (!axTarget) {
			throw new Error(`AX target '${ref}' is not available for the latest screenshot. Call screenshot again.`);
		}

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

		if (!clickedViaAX && !focusedViaAX) {
			throw new Error(`AX click/focus could not be completed for ${ref}.`);
		}

		return {
			strategy: clickedViaAX ? "ax_press" : "ax_focus",
			axAttempted: true,
			axSucceeded: true,
			fallbackUsed: false,
		};
	}

	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error("click requires either ref or both x and y.");
	}
	ensurePointIsInCapture(x, y, capture);

	let clickedViaAX = false;
	let focusedViaAX = false;
	const canTryAX = button === "left" && clickCount === 1;
	if (canTryAX) {
		try {
			const axResult = await bridgeCommand<AxPressAtPointResult>(
				"axPressAtPoint",
				{
					windowId: target.windowId,
					pid: target.pid,
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

		if (!clickedViaAX) {
			try {
				const focusResult = await bridgeCommand<AxFocusResult>(
					"axFocusAtPoint",
					{
						windowId: target.windowId,
						pid: target.pid,
						x,
						y,
						captureWidth: capture.width,
						captureHeight: capture.height,
					},
					{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
				);
				focusedViaAX = toBoolean(focusResult?.focused);
			} catch {
				focusedViaAX = false;
			}
		}
	}

	if (!clickedViaAX && !focusedViaAX) {
		if (STRICT_AX_MODE) {
			strictModeBlock(`AX click/focus could not be completed at (${Math.round(x)},${Math.round(y)}).`);
		}
		await bridgeCommand(
			"mouseClick",
			{
				windowId: target.windowId,
				pid: target.pid,
				x,
				y,
				button,
				clickCount,
				captureWidth: capture.width,
				captureHeight: capture.height,
			},
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		);
	}

	return {
		strategy: clickedViaAX ? "ax_press" : focusedViaAX ? "ax_focus" : clickCount > 1 ? "coordinate_event_double_click" : "coordinate_event_click",
		axAttempted: canTryAX,
		axSucceeded: clickedViaAX || focusedViaAX,
		fallbackUsed: canTryAX && !clickedViaAX && !focusedViaAX,
	};
}

async function dispatchTypeText(text: string, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	if (STRICT_AX_MODE) {
		strictModeBlock("Raw text insertion is not AX-only. Use set_text for AX value replacement.");
	}
	await focusControlledWindow(target, signal);
	await bridgeCommand(
		"typeText",
		{ text, pid: target.pid },
		{ signal, timeoutMs: Math.min(90_000, Math.max(COMMAND_TIMEOUT_MS, text.length * 25 + 4_000)) },
	);
	return { strategy: "raw_key_text", axAttempted: false, axSucceeded: false, fallbackUsed: false };
}

async function dispatchSetText(text: string, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	await focusControlledWindow(target, signal);
	const focused: FocusedElementResult = await bridgeCommand<FocusedElementResult>(
		"focusedElement",
		{ pid: target.pid, windowId: target.windowId },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => ({ exists: false } as FocusedElementResult));

	if (!focused.exists || !focused.isTextInput || !focused.canSetValue || !focused.elementRef) {
		throw new Error("AX value replacement requires a focused text control. Click a text field first, then call set_text.");
	}

	await bridgeCommand(
		"setValue",
		{
			elementRef: focused.elementRef,
			value: text,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return { strategy: "ax_set_value", axAttempted: true, axSucceeded: true, fallbackUsed: false };
}

async function dispatchKeypress(params: KeypressParams, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	if (STRICT_AX_MODE) {
		strictModeBlock("Keypress is not AX-only.");
	}
	const keys = normalizeKeyList(params.keys);
	if (keys.length === 0) {
		throw new Error("keypress.keys must contain at least one key.");
	}
	await focusControlledWindow(target, signal);
	await bridgeCommand("keyPress", { keys, pid: target.pid }, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
	return { strategy: "raw_keypress", axAttempted: false, axSucceeded: false, fallbackUsed: false };
}

async function dispatchScroll(
	params: ScrollParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	if (STRICT_AX_MODE) {
		strictModeBlock("Scroll is not AX-only.");
	}
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	ensurePointIsInCapture(x, y, capture);
	const scrollX = normalizeScrollDelta(params.scrollX);
	const scrollY = normalizeScrollDelta(params.scrollY);
	if (scrollX === 0 && scrollY === 0) {
		throw new Error("scroll requires a non-zero scrollX or scrollY.");
	}
	await bridgeCommand(
		"scrollWheel",
		{
			windowId: target.windowId,
			pid: target.pid,
			x,
			y,
			scrollX,
			scrollY,
			captureWidth: capture.width,
			captureHeight: capture.height,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return { strategy: "coordinate_event_scroll", axAttempted: false, axSucceeded: false, fallbackUsed: false };
}

async function dispatchMoveMouse(
	params: MoveMouseParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	if (STRICT_AX_MODE) {
		strictModeBlock("Mouse movement is not AX-only.");
	}
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	ensurePointIsInCapture(x, y, capture);
	await bridgeCommand(
		"mouseMove",
		{ windowId: target.windowId, pid: target.pid, x, y, captureWidth: capture.width, captureHeight: capture.height },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return { strategy: "coordinate_event_move", axAttempted: false, axSucceeded: false, fallbackUsed: false };
}

async function dispatchDrag(
	params: DragParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	if (STRICT_AX_MODE) {
		strictModeBlock("Drag is not AX-only.");
	}
	const path = normalizeDragPath(params.path, capture);
	await bridgeCommand(
		"mouseDrag",
		{ windowId: target.windowId, pid: target.pid, path, captureWidth: capture.width, captureHeight: capture.height },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return { strategy: "coordinate_event_drag", axAttempted: false, axSucceeded: false, fallbackUsed: false };
}

async function runCoordinateAction(
	tool: string,
	capture: CurrentCapture,
	signal: AbortSignal | undefined,
	dispatch: (target: ResolvedTarget) => Promise<ExecutionTrace>,
	summaryFactory: (target: ResolvedTarget) => string,
): Promise<AgentToolResult<ComputerUseDetails>> {
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		const execution = await dispatch(readyTarget);
		stateMayHaveChanged = true;

		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal, activation);
		return await buildToolResult(tool, summaryFactory(captureResult.target), captureResult, execution, signal);
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

async function performScreenshot(params: ScreenshotParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const selection = {
		app: trimOrUndefined(params.app),
		windowTitle: trimOrUndefined(params.windowTitle),
	};

	const requestedTarget = await resolveTargetForScreenshot(selection, signal);
	const captureResult = await captureCurrentTarget(signal);
	if (!matchesScreenshotSelection(captureResult.target, selection)) {
		throw new Error(
			`Screenshot target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call screenshot again or specify a more exact window title.`,
		);
	}
	const summary = `Captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
	return await buildToolResult("screenshot", summary, captureResult, { strategy: "screenshot", fallbackUsed: false }, signal);
}

async function performClick(params: ClickParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const capture = validateCaptureId(params.captureId);
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	const button = normalizeMouseButton(params.button);
	const clickCount = normalizeClickCount(params.clickCount);

	return await runCoordinateAction(
		"click",
		capture,
		signal,
		async (target) => await dispatchClick({ ...params, clickCount }, capture, target, signal),
		(target) => {
			if (ref) {
				const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
				return `Clicked ${axTarget ? formatAxTargetLabel(axTarget) : ref} in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
			}
			return `${clickCount > 1 ? "Double-clicked" : button === "left" ? "Clicked" : `${button}-clicked`} at (${Math.round(x)},${Math.round(y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
		},
	);
}

async function performTypeText(params: TypeTextParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const text = typeof params.text === "string" ? params.text : "";
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		const execution = await dispatchTypeText(text, readyTarget, signal);

		stateMayHaveChanged = true;
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal, activation);
		const summary = `Inserted text in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
		return await buildToolResult("type_text", summary, captureResult, execution, signal);
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

async function performSetText(params: SetTextParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const text = typeof params.text === "string" ? params.text : "";
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		const execution = await dispatchSetText(text, readyTarget, signal);

		stateMayHaveChanged = true;
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal, activation);
		const summary = `Set focused text value in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
		return await buildToolResult("set_text", summary, captureResult, execution, signal);
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

async function performKeypress(params: KeypressParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const keys = normalizeKeyList(params.keys);
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		const execution = await dispatchKeypress({ keys }, readyTarget, signal);

		stateMayHaveChanged = true;
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal, activation);
		const summary = `Pressed ${keys.length} key${keys.length === 1 ? "" : "s"} in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
		return await buildToolResult("keypress", summary, captureResult, execution, signal);
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

async function performScroll(params: ScrollParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const capture = validateCaptureId(params.captureId);
	return await runCoordinateAction(
		"scroll",
		capture,
		signal,
		async (target) => await dispatchScroll(params, capture, target, signal),
		(target) =>
			`Scrolled at (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`,
	);
}

async function performMoveMouse(params: MoveMouseParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const capture = validateCaptureId(params.captureId);
	return await runCoordinateAction(
		"move_mouse",
		capture,
		signal,
		async (target) => await dispatchMoveMouse(params, capture, target, signal),
		(target) =>
			`Moved mouse to (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`,
	);
}

async function performDrag(params: DragParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const capture = validateCaptureId(params.captureId);
	return await runCoordinateAction(
		"drag",
		capture,
		signal,
		async (target) => await dispatchDrag(params, capture, target, signal),
		(target) => `Dragged in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`,
	);
}

async function performDoubleClick(params: ClickParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const capture = validateCaptureId(params.captureId);
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	return await runCoordinateAction(
		"double_click",
		capture,
		signal,
		async (target) => await dispatchClick({ ...params, clickCount: 2 }, capture, target, signal),
		(target) => {
			if (ref) {
				const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
				return `Double-clicked ${axTarget ? formatAxTargetLabel(axTarget) : ref} in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
			}
			return `Double-clicked at (${Math.round(x)},${Math.round(y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
		},
	);
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
			return await dispatchSetText(action.text, target, signal);
		case "wait": {
			const msRaw = action.ms ?? DEFAULT_WAIT_MS;
			if (!Number.isFinite(msRaw) || msRaw < 0) {
				throw new Error("wait.ms must be a non-negative number.");
			}
			await sleep(Math.min(60_000, Math.round(msRaw)), signal);
			return { strategy: "wait", fallbackUsed: false };
		}
		default:
			throw new Error(`Unsupported computer action '${(action as any)?.type ?? "unknown"}'.`);
	}
}

function actionMayChangeState(action: ComputerAction | undefined): boolean {
	return action?.type !== "wait";
}

async function performComputerActions(params: ComputerActionsParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const capture = validateCaptureId(params.captureId);
	const actions = Array.isArray(params.actions) ? params.actions : [];
	if (actions.length === 0) {
		throw new Error("computer_actions.actions must contain at least one action.");
	}
	if (actions.length > BATCH_MAX_ACTIONS) {
		throw new Error(`computer_actions supports at most ${BATCH_MAX_ACTIONS} actions per call.`);
	}

	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		let axAttempted = false;
		let axSucceeded = false;
		let fallbackUsed = false;
		const actionTraces: BatchActionTrace[] = [];

		for (let index = 0; index < actions.length; index += 1) {
			const action = actions[index];
			if (!action || typeof (action as any).type !== "string") {
				throw new Error(`computer_actions action ${index + 1} is missing a valid type.`);
			}
			if ((action as any)?.captureId && (action as any).captureId !== capture.captureId) {
				throw new Error(STALE_CAPTURE_ERROR);
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
			});
			if (actionMayChangeState(action)) {
				stateMayHaveChanged = true;
			}
			axAttempted ||= trace.axAttempted === true;
			axSucceeded ||= trace.axSucceeded === true;
			fallbackUsed ||= trace.fallbackUsed === true;
			if (index + 1 < actions.length && action?.type !== "wait") {
				await sleep(BATCH_ACTION_GAP_MS, signal);
			}
		}

		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal, activation);
		const execution: ExecutionTrace = {
			strategy: "batch",
			actionCount: actions.length,
			completedActionCount: actionTraces.length,
			actions: actionTraces,
			axAttempted,
			axSucceeded,
			fallbackUsed,
		};
		const summary = `Executed ${actions.length} computer action${actions.length === 1 ? "" : "s"} in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
		return await buildToolResult("computer_actions", summary, captureResult, execution, signal);
	} catch (error) {
		if (stateMayHaveChanged) {
			await sleep(ACTION_SETTLE_MS, signal).catch(() => undefined);
			await captureCurrentTarget(signal, activation).catch(() => undefined);
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

async function performWait(params: WaitParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
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
	return await buildToolResult("wait", summary, captureResult, { strategy: "wait", fallbackUsed: false }, signal);
}

async function executeTool<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	return await withRuntimeLock(async () => {
		await ensureReady(ctx, signal);
		throwIfAborted(signal);

		return await run();
	});
}

export async function executeScreenshot(
	_toolCallId: string,
	params: ScreenshotParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performScreenshot(params, signal));
}

export async function executeClick(
	_toolCallId: string,
	params: ClickParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performClick(params, signal));
}

export async function executeDoubleClick(
	_toolCallId: string,
	params: ClickParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performDoubleClick(params, signal));
}

export async function executeMoveMouse(
	_toolCallId: string,
	params: MoveMouseParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performMoveMouse(params, signal));
}

export async function executeDrag(
	_toolCallId: string,
	params: DragParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performDrag(params, signal));
}

export async function executeScroll(
	_toolCallId: string,
	params: ScrollParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performScroll(params, signal));
}

export async function executeKeypress(
	_toolCallId: string,
	params: KeypressParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performKeypress(params, signal));
}

export async function executeTypeText(
	_toolCallId: string,
	params: TypeTextParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performTypeText(params, signal));
}

export async function executeSetText(
	_toolCallId: string,
	params: SetTextParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performSetText(params, signal));
}

export async function executeComputerActions(
	_toolCallId: string,
	params: ComputerActionsParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performComputerActions(params, signal));
}

export async function executeWait(
	_toolCallId: string,
	params: WaitParams,
	signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails>> {
	return await executeTool(ctx, signal, () => performWait(params, signal));
}

export function reconstructStateFromBranch(ctx: ExtensionContext): void {
	runtimeState.currentTarget = undefined;
	runtimeState.currentCapture = undefined;
	runtimeState.currentAxTargets = undefined;

	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any).message;
		if (!message || message.role !== "toolResult") continue;
		if (!TOOL_NAMES.has(message.toolName)) continue;

		const details = message.details as Partial<ComputerUseDetails> | undefined;
		if (!details?.target || !details?.capture) continue;

		const app =
			typeof details.target.app === "string"
				? details.target.app
				: typeof (details.target as any).appName === "string"
					? (details.target as any).appName
					: undefined;

		if (!app) continue;
		if (!Number.isFinite(details.target.pid) || !Number.isFinite(details.target.windowId)) continue;
		if (typeof details.capture.captureId !== "string") continue;

		runtimeState.currentTarget = {
			appName: app,
			bundleId: details.target.bundleId,
			pid: Math.trunc(details.target.pid),
			windowTitle: details.target.windowTitle ?? "(untitled)",
			windowId: Math.trunc(details.target.windowId),
		};

		runtimeState.currentCapture = {
			captureId: details.capture.captureId,
			width: Math.max(1, Math.trunc(toFiniteNumber(details.capture.width, 1))),
			height: Math.max(1, Math.trunc(toFiniteNumber(details.capture.height, 1))),
			scaleFactor: Math.max(1, toFiniteNumber(details.capture.scaleFactor, 1)),
			timestamp: Number.isFinite(details.capture.timestamp) ? details.capture.timestamp : Date.now(),
		};
		runtimeState.currentAxTargets = Array.isArray(details.axTargets)
			? details.axTargets.filter((item): item is AxTarget => Boolean(item && typeof item.ref === "string" && typeof item.elementRef === "string"))
			: undefined;

		break;
	}
}

export function stopBridge(): void {
	rejectAllPending(new HelperTransportError("Computer-use helper stopped."));

	const helper = runtimeState.helper;
	runtimeState.helper = undefined;
	runtimeState.helperStdoutBuffer = "";
	runtimeState.currentAxTargets = undefined;

	if (helper && helper.exitCode === null && !helper.killed) {
		helper.kill("SIGTERM");
	}
}
