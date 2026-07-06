import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cdpEvaluateForContext, cdpNavigateContext, cdpScrollForContext, cdpSnapshotForContext, cdpTabForWindow, cdpTypeForContext, listCdpPageContexts, type CdpConsoleEntry, type CdpPageSnapshot } from "./cdp.ts";
import { getComputerUseConfig, isBrowserUseEnabled, isStrictAxMode, loadComputerUseConfig } from "./config.ts";
import { noteAfterAct, noteFromLook, noteRegionKeyForRef, renderNote, type WindowNote } from "./note.ts";
import { foldToBudget, graftScopedOutline, nodeByRef, outlineNodeLabel, outlineNodePath, restoreOutline, searchOutline, serializeOutline, serializeOutlineNode, type LookResponse, type Outline, type OutlineNode, type OutlineSearchMatch, type SerializedOutline, type SerializedOutlineNode } from "./outline.ts";
import { AGENT_TOOL_NAMES, type ActParams, type DragParams, type EvaluateBrowserParams, type ExpandUiParams, type ImageMode, type InspectUiParams, type KeypressParams, type LaunchBrowserContextParams, type FindParams, type MouseButtonName, type MoveMouseParams, type NavigateBrowserParams, type ObserveParams, type ObserveTargetParams, type ReadTextParams, type RootSelector, type ScrollParams, type SearchUiParams, type SetTextParams, type SnapshotParams, type TypeTextParams, type WaitForParams, type WaitParams, type WindowSelector, type WindowTargetParams } from "./contract.ts";
import { toFiniteNumber } from "./platform/coerce.ts";
import { currentPlatformBackend } from "./platform/index.ts";
import type { FramePoints, HelperActPerformed, HelperActResult, NativeInputDelivery, PlatformActRequest, PlatformApp as HelperApp, PlatformDiagnostics, PlatformFrontmostResult as FrontmostResult, PlatformRoot as HelperWindow } from "./platform/types.ts";
import type { PermissionStatus } from "./permissions.ts";
export type { ActParams, DragParams, EvaluateBrowserParams, ExpandUiParams, ImageMode, InspectUiParams, KeypressParams, LaunchBrowserContextParams, FindParams, MouseButtonName, MoveMouseParams, NavigateBrowserParams, ObserveParams, ObserveTargetParams, ReadTextParams, RootSelector, ScrollParams, SearchUiParams, SetTextParams, SnapshotParams, TypeTextParams, WaitForParams, WaitParams, WindowSelector, WindowTargetParams } from "./contract.ts";

interface StateTargetSnapshot {
	pid: number;
	windowId: number;
	windowRef?: string;
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
type ActionDelivery = "ax" | NativeInputDelivery;
type DeliveryPolicy = "ax_only" | "background" | "default";
type ActOutcome = "worked" | "didnt" | "unknown";

interface ExecutionTrace {
	strategy:
		| "look"
		| "act"
		| "wait"
		| "browser_open_location"
		| "cdp_navigate";
	runtimeMode?: ExecutionVariant;
	variant?: ExecutionVariant;
	stealthCompatible?: boolean;
	delivery?: ActionDelivery;
	deliveryPolicy?: DeliveryPolicy;
	outcome?: ActOutcome;
	performed?: HelperActPerformed;
	evidence?: Record<string, unknown>;
	error?: HelperActResult["error"];
	rootDelta?: HelperActResult["rootDelta"];
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
	lookId?: string;
	renderedOutline?: string;
	outline?: SerializedOutline;
	note?: WindowNote;
	activation: ActivationFlags;
	execution: ExecutionTrace;
	config?: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
	helper?: PlatformDiagnostics;
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

export interface ListWindowsDetails {
	tool: "find";
	query: FindParams;
	windows: Array<{
		app: string;
		bundleId?: string;
		pid: number;
		kind: string;
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
		sheetCount?: number;
		role?: string;
		subrole?: string;
		pairing?: { confidence: "exact" | "high" | "low"; score: number };
		zOrder: number;
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
	target?: OutlineSearchMatch;
	nodeCount?: number;
	text?: string;
	role?: string;
}

export interface OutlineToolDetails {
	tool: "search_ui" | "expand_ui" | "inspect_ui";
	stateId?: string;
	lookId?: string;
	outline?: SerializedOutline;
	renderedOutline?: string;
	matches?: Array<Omit<OutlineSearchMatch, "node"> & { node?: SerializedOutlineNode }>;
	target?: SerializedOutlineNode;
	raw?: unknown;
	note?: WindowNote;
}

interface ResolvedTarget extends CurrentTarget {
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
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
	currentLook?: LookResponse;
	currentOutline?: Outline;
	currentNote?: WindowNote;
	browserSnapshots: Map<string, CdpPageSnapshot>;
	windowRefs: Map<string, WindowRefRecord>;
	windowRefByIdentity: Map<string, string>;
	windowWriteQueues: Map<string, Promise<void>>;
	nextRootRefIndex: number;
	allowNextTypeTextAxReplacement?: boolean;
	pendingBrowserAddress?: PendingBrowserAddress;
	managedBrowser?: ChildProcess;
	queueTail: Promise<void>;
	permissionStatus?: PermissionStatus;
	helperDiagnostics?: PlatformDiagnostics;
	lastPermissionCheckAt: number;
}


const MISSING_TARGET_ERROR = "No current controlled window. Call observe first to choose a target window.";
const CURRENT_TARGET_GONE_ERROR =
	"The current controlled window is no longer available. Call observe to choose a new target window.";

const COMMAND_TIMEOUT_MS = 15_000;
const LOOK_TIMEOUT_MS = 33_000;

const SCREENSHOT_TIMEOUT_MS = 25_000;
const ACTION_SETTLE_MS = 280;
const DEFAULT_WAIT_MS = 1_000;

const BROWSER_CONTEXT_PREFIX = "browser:";
const DESKTOP_CONTEXT_PREFIX = "desktop:";
const MANAGED_BROWSER_READY_TIMEOUT_MS = 15_000;
const AUTO_IMAGE_MAX_DIMENSION = 900;
const EXPLICIT_IMAGE_MAX_DIMENSION = 1_600;
const OUTLINE_TARGET_TEXT_PREVIEW_CHARS = 240;
const BROWSER_SNAPSHOT_TEXT_PREVIEW_CHARS = 2_000;
const HELIUM_EXECUTABLE = "/Applications/Helium.app/Contents/MacOS/Helium";
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const runtimeState: RuntimeState = {
	queueTail: Promise.resolve(),
	lastPermissionCheckAt: 0,
	allowNextTypeTextAxReplacement: false,
	browserSnapshots: new Map(),
	windowRefs: new Map(),
	windowRefByIdentity: new Map(),
	windowWriteQueues: new Map(),
	nextRootRefIndex: 1,
};

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
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
		...metadata,
	};
}

function settleMsForExecution(execution: ExecutionTrace): number {
	// Any deltaSource means the helper already awaited UI quiescence; the
	// bridge must not double-pay with its own settle sleep.
	if (execution.performed?.deltaSource) return 0;
	if (execution.variant === "stealth") {
		switch (execution.strategy) {
			case "browser_open_location":
				return 120;
			default:
				return 120;
		}
	}
	return ACTION_SETTLE_MS;
}

function addRefreshHint(error: unknown): Error {
	const message = normalizeError(error).message;
	if (/call (screenshot|observe)/i.test(message)) return new Error(message);
	return new Error(`${message} Call observe again to refresh the current window state.`);
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

function outlineNodeCenter(node: OutlineNode): { x: number; y: number } {
	if (!node.rect) {
		throw new Error(`Outline ref '${node.ref}' has no full-look coordinates after scoped expansion. Re-observe for coordinates.`);
	}
	return { x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2 };
}

function validateStateId(stateId?: string): CurrentCapture {
	if (!runtimeState.currentTarget || !runtimeState.currentCapture) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	const supplied = stateId;
	if (supplied && runtimeState.currentCapture.stateId !== supplied) {
		throw new Error(
			`Stale state '${supplied}'. The latest state is '${runtimeState.currentCapture.stateId}' for ${runtimeState.currentTarget.windowRef ?? "the current window"}. Call observe${runtimeState.currentTarget.windowRef ? `({ root: "${runtimeState.currentTarget.windowRef}" })` : ""} again and retry.`,
		);
	}
	const stateTarget = runtimeState.currentStateTarget;
	if (stateTarget && (stateTarget.pid !== runtimeState.currentTarget.pid || stateTarget.windowId !== runtimeState.currentTarget.windowId)) {
		throw new Error("The latest state belongs to a different window. Call observe for the target window and retry.");
	}
	return runtimeState.currentCapture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatOutlineNodeLabel(node: OutlineNode): string {
	const label = outlineNodeLabel(node) || "(unlabeled)";
	const identifier = node.identifier ? ` id=${JSON.stringify(node.identifier)}` : "";
	const capabilities = [
		node.canSetValue ? "setValue" : undefined,
		node.canPress ? "press" : undefined,
		node.canFocus ? "focus" : undefined,
		node.canScroll ? "scroll" : undefined,
		node.canIncrement || node.canDecrement ? "adjust" : undefined,
		node.pictureOnly ? "pictureOnly" : undefined,
	].filter((item): item is string => Boolean(item));
	return `${node.ref} ${node.role}${node.subrole ? `/${node.subrole}` : ""}${identifier} ${JSON.stringify(label)}${capabilities.length ? ` [${capabilities.join(",")}]` : ""}`;
}

function outlineNodeByRef(ref: string): OutlineNode {
	const outline = runtimeState.currentOutline;
	const node = outline ? nodeByRef(outline, ref) : undefined;
	if (!node) {
		const windowHint = runtimeState.currentTarget?.windowRef ? `({ root: "${runtimeState.currentTarget.windowRef}" })` : "";
		throw new Error(`Outline ref '${ref}' is stale or not available for the latest state. Call observe${windowHint} again and choose a current @e ref.`);
	}
	return node;
}

function wireRefForNode(node: OutlineNode): string {
	if (node.pictureOnly || !node.wireRef) {
		throw new Error(`Outline ref '${node.ref}' is pictureOnly and has no semantic element. It can be clicked by coordinates, but semantic-only actions are not available.`);
	}
	return node.wireRef;
}

function imageFallbackReason(
	tool: string,
	result: CaptureResult,
	imageMode: ImageMode = "auto",
): { reason: NonNullable<ComputerUseDetails["imageReason"]>; message: string } | undefined {
	if (imageMode === "never") return undefined;
	if (imageMode === "always") return { reason: "fallback_recovery", message: "An image was requested explicitly for visual verification." };
	const outline = result.outline;
	const labeled = outline.nodes.filter((node) => outlineNodeLabel(node)).length;
	if (outline.nodes.length < 3) {
		return { reason: "sparse_ax_targets", message: "Only a few outline nodes were found, so the look image is attached for context." }
	}
	if (labeled * 3 < outline.nodes.length) {
		return { reason: "unlabeled_ax_targets", message: "Most outline nodes are unlabeled, so the look image is attached for context." }
	}
	if (tool === "wait" && currentPlatformBackend.isBrowserApp(result.target.appName, result.target.bundleId)) {
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

async function ensureReady(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	loadComputerUseConfig(ctx.cwd);

	throwIfAborted(signal);
	const ready = await currentPlatformBackend.ensureReady(
		ctx,
		{
			permissionStatus: runtimeState.permissionStatus,
			lastPermissionCheckAt: runtimeState.lastPermissionCheckAt,
			helperDiagnostics: runtimeState.helperDiagnostics,
		},
		signal,
	);
	runtimeState.permissionStatus = ready.permissionStatus;
	runtimeState.lastPermissionCheckAt = ready.lastPermissionCheckAt;
	runtimeState.helperDiagnostics = ready.helperDiagnostics;
}

export async function ensureComputerUseSetup(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	await ensureReady(ctx, signal);
}

async function listApps(signal?: AbortSignal): Promise<HelperApp[]> {
	return await currentPlatformBackend.listApps(signal);
}

async function listWindows(pid: number, signal?: AbortSignal): Promise<HelperWindow[]> {
	return await currentPlatformBackend.listRoots({ pid }, signal);
}

function appMatchesWindowQuery(app: HelperApp, query: FindParams): boolean {
	const appQuery = trimOrUndefined(query.app);
	const bundleQuery = trimOrUndefined(query.bundleId);
	const pidQuery = Number.isFinite(query.pid) ? Math.trunc(query.pid!) : undefined;

	if (pidQuery !== undefined && app.pid !== pidQuery) return false;
	if (bundleQuery && normalizeText(app.bundleId ?? "") !== normalizeText(bundleQuery)) return false;
	if (appQuery && !normalizeText(app.appName).includes(normalizeText(appQuery))) return false;
	return true;
}

function platformRootSheetCount(window: Pick<HelperWindow, "metadata">): number | undefined {
	const value = window.metadata?.sheetCount;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function platformRootPairing(window: Pick<HelperWindow, "metadata">): { confidence: "exact" | "high" | "low"; score: number } | undefined {
	const value = window.metadata?.pairing;
	if (!value || typeof value !== "object") return undefined;
	const pairing = value as { confidence?: unknown; score?: unknown };
	if (pairing.confidence !== "exact" && pairing.confidence !== "high" && pairing.confidence !== "low") return undefined;
	return { confidence: pairing.confidence, score: typeof pairing.score === "number" && Number.isFinite(pairing.score) ? pairing.score : Number.NEGATIVE_INFINITY };
}

function formatWindowLine(window: ListWindowsDetails["windows"][number]): string {
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isModal ? "modal" : undefined,
		window.sheetCount ? `sheets=${window.sheetCount}` : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
		window.browserUseAllowed ? undefined : "browser_use_disabled",
	]
		.filter(Boolean)
		.join(", ");
	const frame = `${Math.round(window.framePoints.x)},${Math.round(window.framePoints.y)} ${Math.round(window.framePoints.w)}x${Math.round(window.framePoints.h)}`;
	const id = window.windowId ? `windowId ${window.windowId}` : window.nativeWindowRef ? `nativeRootRef ${window.nativeWindowRef}` : "unstable root id";
	const pairing = window.pairing ? `, pairing ${window.pairing.confidence}/${Math.round(window.pairing.score)}` : "";
	return `- ${window.windowRef} ${window.kind} ${window.app} pid ${window.pid} — ${window.windowTitle || "(untitled)"} (z ${window.zOrder}, ${id}, frame ${frame}${pairing}${flags ? `, ${flags}` : ""})`;
}

async function getFrontmost(signal?: AbortSignal): Promise<FrontmostResult> {
	return await currentPlatformBackend.getFrontmost(signal);
}

async function focusControlledWindow(target: ResolvedTarget, signal?: AbortSignal): Promise<void> {
	const result = await currentPlatformBackend.focusWindow(nativeWindowRequest(target), signal);
	if (!toBoolean(result?.focused)) {
		throw new Error(
			`Unable to focus controlled window '${target.windowTitle}' before input${result?.reason ? `: ${result.reason}` : "."}`,
		);
	}
}

function assertBrowserUseAllowed(target: { appName: string; bundleId?: string }): void {
	if (!isBrowserUseEnabled() && currentPlatformBackend.isBrowserApp(target.appName, target.bundleId)) {
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

	const ref = `@r${runtimeState.nextRootRefIndex++}`;
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
	if (!currentPlatformBackend.isBrowserApp(target.appName, target.bundleId)) return false;
	runtimeState.pendingBrowserAddress = undefined;
	return await currentPlatformBackend.openBrowserLocation(target, pending.text, signal);
}

function choosePreferredWindow(windows: HelperWindow[], appName: string): HelperWindow {
	if (!windows.length) {
		throw new Error(`No controllable root was found in app '${appName}'.`);
	}

	const scored = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	return scored[0];
}

function scoreWindow(window: HelperWindow): number {
	let score = 0;
	if (window.isModal) score += 180;
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
		throw new Error("root target must be a non-empty @r ref or numeric windowId.");
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
			throw new Error(`Root ref '${normalized}' is stale. Call find again and choose a current window.`);
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
		throw new Error(`Window id '${numericWindowId}' was not found. Call find again and choose a current window.`);
	}

	if (normalized.startsWith("@r")) {
		throw new Error(`Root ref '${normalized}' is not available in this session. Call find first.`);
	}

	const config = getComputerUseConfig();
	const candidates = await collectWindowDetails(await listApps(signal), config, signal);
	const query = normalizeText(normalized);
	const exact = candidates.filter((candidate) => normalizeText(candidate.app) === query || normalizeText(candidate.windowTitle) === query);
	const fuzzy = exact.length > 0 ? exact : candidates.filter((candidate) => `${normalizeText(candidate.app)} ${normalizeText(candidate.windowTitle)}`.includes(query));
	const match = fuzzy.sort((a, b) => Number(b.isFocused) - Number(a.isFocused) || a.zOrder - b.zOrder)[0];
	if (!match) throw new Error(`Root query '${normalized}' did not match any current root. Call find to inspect roots.`);
	const app: HelperApp = { appName: match.app, bundleId: match.bundleId, pid: match.pid };
	const roots = await listWindows(match.pid, signal);
	const helperRoot = roots.find((root) => root.rootRef === match.nativeWindowRef || root.windowRef === match.nativeWindowRef || root.windowId === match.windowId) ?? roots[0];
	const resolved = toResolvedTarget(app, helperRoot);
	setCurrentTarget(resolved);
	return resolved;
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
		runtimeState.currentLook = undefined;
		runtimeState.currentOutline = undefined;
		delete runtimeState.currentNote;
	}
}

function shouldPreferForegroundModalWindow(current: HelperWindow, candidate: HelperWindow): boolean {
	if (candidate.windowId === current.windowId && candidate.windowRef === current.windowRef) return false;
	if (!candidate.isOnscreen || candidate.isMinimized) return false;
	if (candidate.isModal) return scoreWindow(candidate) >= scoreWindow(current);
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
	let match = current.nativeWindowRef ? windows.find((window) => window.windowRef === current.nativeWindowRef || window.rootRef === current.nativeWindowRef) : undefined;
	match ??= hadStableWindowId ? windows.find((window) => window.windowId !== undefined && window.windowId === current.windowId) : undefined;
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
		throw new Error("No frontmost controllable root was found. Open an app window and call observe again.");
	}

	if (currentPlatformBackend.isBrowserApp(app.appName, app.bundleId)) {
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

function matchesObserveSelection(target: ResolvedTarget, selection: ObserveTargetParams): boolean {
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

async function resolveTargetForObserve(selection: ObserveTargetParams, signal?: AbortSignal): Promise<ResolvedTarget> {
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
			throw new Error(`No controllable root was found in app '${app.appName}'.`);
		}

		let window: HelperWindow;
		if (windowTitleQuery) {
			window = chooseWindowByTitle(windows, windowTitleQuery, app.appName);
		} else if (currentPlatformBackend.isBrowserApp(app.appName, app.bundleId)) {
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
	if (target.windowId > 0 || target.nativeWindowRef) {
		return target;
	}

	const refreshed = await resolveCurrentTarget(signal);
	if (refreshed.windowId <= 0 && !refreshed.nativeWindowRef) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}
	return refreshed;
}

interface CaptureResult {
	target: ResolvedTarget;
	capture: CurrentCapture;
	look: LookResponse;
	outline: Outline;
	activation: ActivationFlags;
}

function captureForLook(look: LookResponse): CurrentCapture {
	return {
		stateId: randomUUID(),
		width: look.image?.width ?? 0,
		height: look.image?.height ?? 0,
		scaleFactor: look.window.scaleFactor,
		timestamp: Date.now(),
	};
}

async function performLook(target: ResolvedTarget, options: { readText: "auto" | "always" | "never"; scopeRef?: string; maxDimension?: number }, signal?: AbortSignal): Promise<LookResponse> {
	if ((!Number.isFinite(target.windowId) || target.windowId <= 0) && !target.nativeWindowRef) throw new Error(`Current platform requires a stable root id to observe '${target.windowTitle}'. Call find and select a root with a stable id.`);
	return await currentPlatformBackend.observe({
		target: nativeWindowRequest(target),
		readText: options.readText,
		scopeRef: options.scopeRef,
		maxDimension: options.maxDimension,
	}, { signal, timeoutMs: LOOK_TIMEOUT_MS });
}

function noteWindowForTarget(target: ResolvedTarget | CurrentTarget, look?: LookResponse) {
	return {
		windowRef: target.windowRef,
		title: target.windowTitle,
		pairing: look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object" ? (look.window.metadata.pairing as { confidence?: "exact" | "high" | "low" }).confidence : undefined,
		pairingScore: look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object" ? (look.window.metadata.pairing as { score?: number }).score : undefined,
	};
}

function actTargetPublicRef(params: { ref?: string }): string | undefined {
	return trimOrUndefined(params.ref);
}

async function captureCurrentTarget(signal?: AbortSignal, readText: "auto" | "always" | "never" = "auto", maxDimension = AUTO_IMAGE_MAX_DIMENSION, targetOverride?: ResolvedTarget): Promise<CaptureResult> {
	let target = targetOverride ?? await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const look = await performLook(target, { maxDimension, readText }, signal);
	const outline = look.parsedOutline!;
	const capture = captureForLook(look);

	setCurrentTarget(target);
	runtimeState.currentCapture = capture;
	runtimeState.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	runtimeState.currentLook = look;
	runtimeState.currentOutline = outline;
	runtimeState.currentNote = noteFromLook(runtimeState.currentNote, outline, noteWindowForTarget(target, look));

	return {
		target,
		capture,
		look,
		outline,
		activation: emptyActivation(),
	};
}

async function refreshCurrentTargetAfterAct(target: ResolvedTarget, targetRef: string | undefined, signal?: AbortSignal): Promise<CaptureResult> {
	const outline = runtimeState.currentOutline;
	if (!outline || !targetRef) return await captureCurrentTarget(signal);
	const targetNode = nodeByRef(outline, targetRef);
	if (!targetNode?.wireRef || targetNode.pictureOnly) return await captureCurrentTarget(signal);
	const look = await performLook(target, { maxDimension: AUTO_IMAGE_MAX_DIMENSION, readText: "auto", scopeRef: targetNode.wireRef }, signal);
	graftScopedOutline(outline, targetNode.ref, look.parsedOutline!);
	outline.lookId = look.lookId;
	const capture = captureForLook(look);

	setCurrentTarget(target);
	runtimeState.currentCapture = capture;
	runtimeState.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	runtimeState.currentLook = look;
	runtimeState.currentOutline = outline;

	return {
		target,
		capture,
		look,
		outline,
		activation: emptyActivation(),
	};
}

async function buildToolResult(
	tool: string,
	summary: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	_signal?: AbortSignal,
	imageMode: ImageMode = runtimeState.currentImageMode ?? "auto",
): Promise<AgentToolResult<ComputerUseDetails>> {
	const fallbackReason = imageFallbackReason(tool, result, imageMode);
	const folded = foldToBudget(result.outline);
	const renderedNote = renderNote(runtimeState.currentNote);

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
		lookId: result.look.lookId,
		renderedOutline: folded.text,
		outline: serializeOutline(result.outline),
		note: runtimeState.currentNote,
		activation: result.activation,
		execution,
		status: "ok",
		config: getComputerUseConfig(),
		helper: runtimeState.helperDiagnostics,
		imageReason: fallbackReason?.reason,
	};

	// Console piggyback: when a CDP connection is active for this browser
	// window, surface console output collected since the last tool result.
	let consoleText = "";
	if (currentPlatformBackend.isChromeFamilyApp(result.target.appName, result.target.bundleId)) {
		const tab = await cdpTabForWindow(result.target.windowTitle, result.target.framePoints);
		const entries = tab?.drainConsole() ?? [];
		if (entries.length > 0) {
			details.console = entries;
			consoleText = `\n\nBrowser console since the last action:\n${entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`;
		}
	}

	const noteText = renderedNote ? `\n\n${renderedNote}` : "";
	const outlineText = `\n\nOutline (${folded.nodeCount} nodes, lookId ${result.look.lookId}${folded.truncated ? ", folded output truncated" : ""}):\n${folded.text}`;
	const fallbackText = fallbackReason ? `\n\n${fallbackReason.message}` : "";
	const deltaText = rootDeltaLines(execution).join("\n");
	const content: AgentToolResult<ComputerUseDetails>["content"] = [{ type: "text", text: `${summary}${deltaText ? `\n${deltaText}` : ""}${consoleText}${noteText}${outlineText}${fallbackText}` }];
	if (fallbackReason && result.look.image?.jpegBase64) {
		content.push({ type: "image", data: result.look.image.jpegBase64, mimeType: "image/jpeg" });
	}

	return { content, details };
}

type HelperActAction = "press" | "click" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse";
type HelperActTarget = { ref: string } | { x: number; y: number };
type HelperActInput =
	| { action: "press" | "click"; params: { button?: MouseButtonName; clickCount?: number } }
	| { action: "setText"; params: { text: string } }
	| { action: "typeText"; params: { text: string } }
	| { action: "keypress"; params: { keys: string[] } }
	| { action: "scroll"; params: { scrollX: number; scrollY: number } }
	| { action: "drag"; params: { path: Array<{ x: number; y: number }> } }
	| { action: "moveMouse"; params: Record<string, never> };

function currentLookOrThrow(): LookResponse {
	if (!runtimeState.currentLook || !runtimeState.currentCapture) {
		throw new Error("No current look. Call observe first, then act using refs or coordinates from that look.");
	}
	return runtimeState.currentLook;
}

function ensurePointIsInLookImage(x: number, y: number, look: LookResponse, errorPrefix = "Coordinates"): void {
	if (!look.image?.jpegBase64) {
		throw new Error(`${errorPrefix} require an image-bearing root. This look is outline-only; use an @e ref with a semantic action or observe an image-bearing root.`);
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${errorPrefix} must be finite numbers.`);
	}
	if (x < 0 || y < 0 || x >= look.image.width || y >= look.image.height) {
		throw new Error(`${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest look image bounds (${look.image.width}x${look.image.height}). Call observe again and retry.`);
	}
}

function normalizeActPath(path: DragParams["path"], look: LookResponse): Array<{ x: number; y: number }> {
	if (!Array.isArray(path) || path.length < 2) {
		throw new Error("drag.path must contain at least two points.");
	}
	return path.map((point, index) => {
		const x = Array.isArray(point) ? toFiniteNumber(point[0], NaN) : toFiniteNumber(point?.x, NaN);
		const y = Array.isArray(point) ? toFiniteNumber(point[1], NaN) : toFiniteNumber(point?.y, NaN);
		ensurePointIsInLookImage(x, y, look, `Drag point ${index + 1}`);
		return { x, y };
	});
}

function actTargetFromParams(params: { ref?: string; x?: number; y?: number }, look: LookResponse, action: HelperActAction): HelperActTarget {
	const ref = trimOrUndefined(params.ref);
	if (ref) {
		const node = outlineNodeByRef(ref);
		if (node.wireRef && !node.pictureOnly) return { ref: node.wireRef };
		const point = outlineNodeCenter(node);
		ensurePointIsInLookImage(point.x, point.y, look);
		return point;
	}
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	if (Number.isFinite(x) && Number.isFinite(y)) {
		ensurePointIsInLookImage(x, y, look);
		return { x, y };
	}
	if (action === "typeText" || action === "keypress") {
		if (!look.image) throw new Error(`${action} requires an image-bearing root when no ref is provided.`);
		return { x: Math.floor(look.image.width / 2), y: Math.floor(look.image.height / 2) };
	}
	throw new Error(`${action} requires either ref or both x and y.`);
}

function modelRefForRootDelta(delta: NonNullable<HelperActResult["rootDelta"]>[number]): string | undefined {
	if (!delta.ref) return undefined;
	if (delta.ref.startsWith("@r")) return delta.ref;
	for (const record of runtimeState.windowRefs.values()) {
		if (record.nativeWindowRef === delta.ref || record.ref === delta.ref) return record.ref;
	}
	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	const current = runtimeState.currentTarget;
	const record: WindowRefRecord = {
		ref,
		appName: current?.pid === delta.pid ? current.appName : "Unknown App",
		bundleId: current?.pid === delta.pid ? current.bundleId : undefined,
		pid: delta.pid,
		windowTitle: delta.title ?? "(untitled)",
		nativeWindowRef: delta.ref,
		framePoints: { x: 0, y: 0, w: 1, h: 1 },
		scaleFactor: 1,
		isMinimized: false,
		isOnscreen: true,
		isMain: false,
		isFocused: delta.change === "focused",
	};
	runtimeState.windowRefs.set(ref, record);
	runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), ref);
	return ref;
}

function executionTraceFromAct(result: HelperActResult): ExecutionTrace {
	const rootDelta = result.rootDelta?.map((delta) => ({ ...delta, ref: modelRefForRootDelta(delta) }));
	return executionTrace("act", result.performed?.delivery === "ax" ? "stealth" : "default", {
		outcome: result.outcome,
		performed: result.performed,
		evidence: result.evidence,
		error: result.error,
		rootDelta,
		delivery: result.performed?.delivery,
		deliveryPolicy: currentDeliveryPolicy(),
	});
}

async function helperAct(
	target: ResolvedTarget,
	actTarget: HelperActTarget,
	input: HelperActInput,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const look = currentLookOrThrow();
	const delivery = nativeInputDelivery();
	const base = { lookId: look.lookId, pid: target.pid, target: actTarget, policy: currentDeliveryPolicy() };
	const request: PlatformActRequest = (() => {
		switch (input.action) {
			case "press":
			case "click": return { ...base, action: input.action, params: { ...input.params, delivery } };
			case "setText": return { ...base, action: input.action, params: { text: input.params.text, delivery } };
			case "typeText": return { ...base, action: input.action, params: { text: input.params.text, delivery } };
			case "keypress": return { ...base, action: input.action, params: { keys: input.params.keys, delivery } };
			case "scroll": return { ...base, action: input.action, params: { scrollX: input.params.scrollX, scrollY: input.params.scrollY, delivery } };
			case "drag": return { ...base, action: input.action, params: { path: input.params.path, delivery } };
			case "moveMouse": return { ...base, action: input.action, params: { delivery } };
		}
	})();
	const textTimeout = "text" in input.params ? input.params.text.length * 25 + 4_000 : COMMAND_TIMEOUT_MS;
	const result = await currentPlatformBackend.act(request, { signal, timeoutMs: Math.max(COMMAND_TIMEOUT_MS, textTimeout) });
	if (!result || !["worked", "didnt", "unknown"].includes(result.outcome)) {
		throw new Error("Helper act returned an invalid result without an outcome.");
	}
	return executionTraceFromAct(result);
}

function actOutcomeText(execution: ExecutionTrace): string {
	if (execution.outcome === "worked") return " Helper verified it worked.";
	if (execution.outcome === "didnt") return " Helper verified it did not work.";
	return " Helper could not verify the result.";
}

function rootDeltaLines(execution: ExecutionTrace): string[] {
	return (execution.rootDelta ?? []).map((delta) => {
		const quotedTitle = delta.title ? ` ${JSON.stringify(delta.title)}` : "";
		const ref = delta.ref ? ` (${delta.ref.startsWith("@") ? delta.ref : `@${delta.ref}`})` : "";
		const sheetCount = typeof delta.metadata?.sheetCount === "number" && Number.isFinite(delta.metadata.sheetCount) ? Math.max(0, Math.trunc(delta.metadata.sheetCount)) : undefined;
		const flags = [delta.isModal ? "modal" : undefined, sheetCount ? `sheets=${sheetCount}` : undefined].filter(Boolean).join(", ");
		const suffix = `${quotedTitle}${flags ? ` (${flags})` : ""}${ref}`;
		if (delta.change === "appeared") return `New root: ${delta.kind}${suffix}`;
		if (delta.change === "closed") return `Root closed: ${delta.kind}${suffix}`;
		return `Root focused: ${delta.kind}${suffix}`;
	});
}

function appendRootDeltaText(message: string, execution: ExecutionTrace): string {
	const lines = rootDeltaLines(execution);
	return lines.length ? `${message}\n${lines.join("\n")}` : message;
}

function confirmationToolResult(tool: string, target: ResolvedTarget, execution: ExecutionTrace, message: string): AgentToolResult<ConfirmationDetails> {
	return {
		content: [{ type: "text", text: appendRootDeltaText(message, execution) }],
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
			message: appendRootDeltaText(message, execution),
		},
	};
}

async function runActionTool(
	tool: string,
	signal: AbortSignal | undefined,
	dispatch: (target: ResolvedTarget) => Promise<ExecutionTrace>,
	summaryFactory: (target: ResolvedTarget, returnedState: boolean, execution: ExecutionTrace) => string,
	options: { responseMode?: WindowTargetParams["responseMode"]; targetRef?: string } = {},
): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	const currentTarget = await resolveCurrentTarget(signal);
	let stateMayHaveChanged = false;
	const noteBeforeAct = runtimeState.currentNote;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		return await withWindowWriteLock(readyTarget, async () => {
			const execution = await dispatch(readyTarget);
			stateMayHaveChanged = true;

			await sleep(settleMsForExecution(execution), signal);
			if (options.responseMode === "confirmation") {
				return confirmationToolResult(tool, readyTarget, execution, summaryFactory(readyTarget, false, execution));
			}
			const captureResult = await refreshCurrentTargetAfterAct(readyTarget, options.targetRef, signal);
			runtimeState.currentNote = noteAfterAct(noteBeforeAct, options.targetRef, captureResult.outline, {
				window: noteWindowForTarget(captureResult.target, captureResult.look),
				windowChanged: execution.evidence?.windowChanged === true,
				rootDelta: execution.rootDelta,
			});
			if (execution.rootDelta?.some((delta) => delta.change === "closed" && (delta.ref === readyTarget.windowRef || delta.ref === readyTarget.nativeWindowRef))) {
				runtimeState.currentLook = undefined;
				runtimeState.currentCapture = undefined;
			}
			return await buildToolResult(tool, summaryFactory(captureResult.target, true, execution), captureResult, execution, signal);
		});
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

// Side effect: stores stable @r refs for discovered windows in runtimeState.
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
				kind: window.kind,
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
				sheetCount: platformRootSheetCount(window),
				role: window.role,
				subrole: window.subrole,
				pairing: platformRootPairing(window),
				zOrder: window.zOrder,
				browserUseAllowed: config.browser_use || !currentPlatformBackend.isBrowserApp(app.appName, app.bundleId),
				score: scoreWindow(window),
			});
		}
	}
	windows.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle));
	return windows;
}

async function performListWindows(params: FindParams, signal?: AbortSignal): Promise<AgentToolResult<ListWindowsDetails>> {
	const rawParams = params ?? {};
	const query: FindParams = {
		query: trimOrUndefined(rawParams.query),
		app: trimOrUndefined(rawParams.app),
		bundleId: trimOrUndefined(rawParams.bundleId),
		pid: Number.isFinite(rawParams.pid) ? Math.trunc(rawParams.pid!) : undefined,
		kind: rawParams.kind,
	};
	const matchingApps = (await listApps(signal)).filter((app) => appMatchesWindowQuery(app, query));
	const config = getComputerUseConfig();
	const forest = (await collectWindowDetails(matchingApps, config, signal)).filter((root) => !query.kind || root.kind === query.kind);
	const normalizedQuery = normalizeText(query.query ?? "");
	const exact = normalizedQuery ? forest.filter((root) => normalizeText(root.app) === normalizedQuery || normalizeText(root.windowTitle) === normalizedQuery) : [];
	const fuzzy = normalizedQuery && exact.length === 0
		? forest.filter((root) => `${normalizeText(root.app)} ${normalizeText(root.windowTitle)}`.includes(normalizedQuery))
		: [];
	const windows = (exact.length > 0 ? exact : fuzzy.length > 0 ? fuzzy : forest)
		.sort((a, b) => Number(b.isFocused) - Number(a.isFocused) || a.zOrder - b.zOrder || a.app.localeCompare(b.app));
	const details: ListWindowsDetails = { tool: "find", query, windows, config };
	const lines = windows.map(formatWindowLine);
	const text = lines.length
		? `Found ${lines.length} root${lines.length === 1 ? "" : "s"}${query.query ? ` for ${JSON.stringify(query.query)}` : ""}. Use @r refs with observe({ root: "@rN" }).\n${lines.join("\n")}`
		: `No roots are currently visible to pi-computer-use.`;
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
		availableActions: ["observe", "search_ui", "expand_ui", "inspect_ui", "act", "read_text", "wait_for"],
	}));
	const browserContexts: ContextDetails["contexts"] = (await listCdpPageContexts().catch(() => [])).map((page) => ({
		contextId: page.contextId,
		kind: "browser_page",
		title: page.title,
		url: page.url,
		availableActions: ["observe", "read_text", "wait_for", "act", "navigate_browser", "evaluate_browser"],
	}));
	const contexts = [...browserContexts, ...desktopContexts];
	const details: ContextDetails = { tool: "list_contexts", contexts, config };
	const lines = contexts.map((context) => {
		const label = context.kind === "browser_page" ? `${context.title} — ${context.url ?? ""}` : `${context.app} — ${context.title}`;
		return `- ${context.contextId} ${context.kind} ${label}`;
	});
	const text = lines.length
		? `Found ${lines.length} controllable context${lines.length === 1 ? "" : "s"}. Use observe before acting.\n${lines.join("\n")}`
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

// Side effect: browser snapshots are cached so later browser tools can resolve opaque @r refs.
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
	await selectWindowIfProvided((params.root ?? params.window) ?? desktopWindowRef, signal);
	validateStateId(params.stateId);
	if (!ref) throw new Error("read_text requires ref for desktop contexts. Call observe/inspect_ui and use a text-bearing outline ref.");
	const node = outlineNodeByRef(ref);
	const raw = await currentPlatformBackend.readText({
		elementRef: wireRefForNode(node),
		offset: Math.max(0, Math.trunc(toFiniteNumber(params.offset, 0))),
		limit: Math.max(1, Math.min(100_000, Math.trunc(toFiniteNumber(params.limit, 4_000)))),
	}, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
	const text = raw.text;
	const details: ReadTextDetails = {
		tool: "read_text",
		contextId,
		ref,
		offset: raw.offset,
		limit: raw.limit,
		totalChars: raw.totalChars,
		hasMore: raw.hasMore,
		text,
	};
	return { content: [{ type: "text", text: text || "(empty text slice)" }], details };
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
	await selectWindowIfProvided((params.root ?? params.window) ?? desktopWindowRef, signal);
	let target = await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const raw = await currentPlatformBackend.waitFor({
		...nativeWindowRequest(target),
		text,
		role,
		gone: params.gone === true,
		timeoutMs,
	}, { signal, timeoutMs: timeoutMs + 2_000 });
	const refreshed = await captureCurrentTarget(signal, "auto");
	const matches = searchOutline(refreshed.outline, text, role, undefined, 1);
	const foundTarget = matches[0];
	const details: WaitForDetails = {
		tool: "wait_for",
		contextId,
		found: raw.found,
		gone: raw.gone || undefined,
		timedOut: raw.timedOut || undefined,
		target: foundTarget,
		nodeCount: Number.isFinite(raw.nodeCount) ? Number(raw.nodeCount) : refreshed.outline.nodes.length,
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
			? `\n\nTargets:\n${browser.targets.map((target) => `${target.ref} ${target.role} \"${textPreview(target.name, OUTLINE_TARGET_TEXT_PREVIEW_CHARS)}\" [${target.actions.join(",")}]`).join("\n")}`
			: "";
		const browserTextPreview = textPreview(browser.text, BROWSER_SNAPSHOT_TEXT_PREVIEW_CHARS);
		const pageText = browserTextPreview ? `\n\nPage text preview (${browserTextPreview.length}/${browser.text.length} chars; use read_text for more):\n${browserTextPreview}` : "";
		runtimeState.browserSnapshots.set(browser.snapshotId, browser);
		const details: SnapshotDetails = {
			tool: "snapshot",
			contextId,
			kind: "browser_page",
			snapshotId: browser.snapshotId,
			availableActions: ["observe", "read_text", "wait_for", "act", "navigate_browser", "evaluate_browser"],
			browser: { ...browser, text: browserTextPreview },
		};
		return { content: [{ type: "text", text: `Captured browser context ${contextId}: ${browser.title}.${targetText}${pageText}` }], details };
	}

	const windowRef = desktopWindowRefFromContext(contextId);
	if (!windowRef) throw new Error(`Unknown context '${contextId}'. Call list_contexts and use a current contextId.`);
	await selectWindowIfProvided(windowRef, signal);
	const scopeRef = trimOrUndefined(params.scopeRef);
	const result = await captureCurrentTarget(signal, "never", AUTO_IMAGE_MAX_DIMENSION);
	const folded = foldToBudget(result.outline, { maxDepth: Math.max(1, Math.trunc(toFiniteNumber(params.maxDepth, 2))), maxNodes: Math.max(1, Math.min(2_000, Math.trunc(toFiniteNumber(params.maxNodes, 150)))) }, scopeRef ? [scopeRef] : []);
	const desktop: ComputerUseDetails = {
		tool: "snapshot",
		target: {
			app: result.target.appName,
			bundleId: result.target.bundleId,
			pid: result.target.pid,
			windowTitle: result.target.windowTitle,
			windowId: result.target.windowId,
			windowRef: result.target.windowRef,
			nativeWindowRef: result.target.nativeWindowRef,
		},
		capture: { ...result.capture, coordinateSpace: "window-relative-screenshot-pixels" },
		lookId: result.look.lookId,
		renderedOutline: folded.text,
		outline: serializeOutline(result.outline),
		note: runtimeState.currentNote,
		activation: emptyActivation(),
		execution: executionTrace("look", "stealth"),
		status: "ok",
		config: getComputerUseConfig(),
	};
	const details: SnapshotDetails = {
		tool: "snapshot",
		contextId,
		kind: "desktop_window",
		snapshotId: result.capture.stateId,
		availableActions: ["observe", "search_ui", "expand_ui", "inspect_ui", "act", "read_text", "wait_for"],
		desktop,
	};
	const scope = scopeRef ? ` scoped to ${scopeRef}` : "";
	return { content: [{ type: "text", text: `Captured desktop context ${contextId}${scope}. ${result.outline.nodes.length} outline node${result.outline.nodes.length === 1 ? "" : "s"}.\n${folded.text}` }], details };
}

function sameRootIdentity(a: CurrentTarget, b: CurrentTarget): boolean {
	if (a.pid !== b.pid) return false;
	if (a.windowId > 0 && b.windowId > 0) return a.windowId === b.windowId;
	if (a.nativeWindowRef && b.nativeWindowRef) return a.nativeWindowRef === b.nativeWindowRef;
	return normalizeText(a.windowTitle) === normalizeText(b.windowTitle);
}

/** Side effects: captures/updates current target, capture state, look, and parsed outline. */
async function performObserve(params: ObserveParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const mode = params.mode ?? "fused";
	const image = params.image ?? (mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto");
	const readText = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
	runtimeState.currentImageMode = normalizeImageMode(image);
	const selection = {
		app: trimOrUndefined(params.app),
		windowTitle: trimOrUndefined(params.windowTitle),
		window: normalizeWindowSelector(params.root ?? params.window),
	};
	const requestedTarget = selection.window
		? await resolveTargetByWindowSelector((params.root ?? params.window)!, signal)
		: await resolveTargetForObserve(selection, signal);
	const captureResult = await captureCurrentTarget(signal, readText, normalizeImageMode(image) === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION, requestedTarget);
	// Model @r refs are re-minted on re-resolution, so ref string equality
	// alone false-positives as drift for the same root; compare stable
	// identity against the resolved request too.
	if (!matchesObserveSelection(captureResult.target, selection) && !sameRootIdentity(captureResult.target, requestedTarget)) {
		throw new Error(
			`Observation target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call observe again or specify a more exact window title.`,
		);
	}
	const summary = `Observed ${mode} ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`;
	return await buildToolResult("observe", summary, captureResult, executionTrace("look", "stealth"), signal, normalizeImageMode(image));
}

function currentOutlineOrThrow(stateId?: string): Outline {
	validateStateId(stateId);
	if (!runtimeState.currentOutline) throw new Error("No current outline. Call observe first.");
	return runtimeState.currentOutline;
}

/** Pure outline query unless a window selector is supplied, in which case current target selection may change. */
async function performSearchUi(params: SearchUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	const outline = currentOutlineOrThrow(params.stateId);
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const action = trimOrUndefined(params.action);
	const limit = Math.max(1, Math.min(50, Math.trunc(toFiniteNumber(params.limit, 12))));
	const matches = searchOutline(outline, text, role, action, limit);
	const detailMatches = matches.map((match) => ({ ...match, node: serializeOutlineNode(match.node) }));
	const details: OutlineToolDetails = { tool: "search_ui", stateId: runtimeState.currentCapture?.stateId, lookId: outline.lookId, outline: serializeOutline(outline), matches: detailMatches, note: runtimeState.currentNote };
	const lines = matches.map((match) => `${match.ref} ${match.role || "Unknown"} ${JSON.stringify(match.label || "(unlabeled)")}\n  path: ${match.path}`);
	const noteHeader = renderNote(runtimeState.currentNote);
	const noteText = noteHeader ? `${noteHeader}\n\n` : "";
	return { content: [{ type: "text", text: `${noteText}Found ${matches.length} outline match${matches.length === 1 ? "" : "es"}.\n${lines.join("\n")}` }], details };
}

/** Reads cached outline; truncated refs trigger a scoped look. */
async function performExpandUi(params: ExpandUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	let outline = currentOutlineOrThrow(params.stateId);
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("expand_ui.ref is required.");
	let target = nodeByRef(outline, ref);
	if (!target) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	const depth = Math.max(1, Math.min(8, Math.trunc(toFiniteNumber(params.depth, 3))));
	const regionKey = noteRegionKeyForRef(outline, ref);
	const regionChanged = Boolean(regionKey && runtimeState.currentNote?.regions.some((region) => region.key === regionKey && region.status === "changed"));
	if (target.truncated || regionChanged) {
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		const scoped = await performLook(currentTarget, { readText: "auto", scopeRef: wireRefForNode(target), maxDimension: 1 }, signal);
		target = graftScopedOutline(outline, target.ref, scoped.parsedOutline!);
	}
	const folded = foldToBudget(outline, { maxDepth: depth, maxNodes: 150 }, [target.ref]);
	const details: OutlineToolDetails = { tool: "expand_ui", stateId: runtimeState.currentCapture?.stateId, lookId: outline.lookId, outline: serializeOutline(outline), target: serializeOutlineNode(target), renderedOutline: folded.text, note: runtimeState.currentNote };
	return { content: [{ type: "text", text: `${formatOutlineNodeLabel(target)}\npath: ${outlineNodePath(target)}\n\n${folded.text}` }], details };
}

/** Pure cached-outline inspection unless a window selector is supplied. */
async function performInspectUi(params: InspectUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	const outline = currentOutlineOrThrow(params.stateId);
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("inspect_ui.ref is required.");
	const target = nodeByRef(outline, ref);
	if (!target) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	const details: OutlineToolDetails = { tool: "inspect_ui", stateId: runtimeState.currentCapture?.stateId, lookId: outline.lookId, outline: serializeOutline(outline), target: serializeOutlineNode(target), raw: params.includeRaw ? serializeOutlineNode(target) : undefined, note: runtimeState.currentNote };
	const fields = [
		formatOutlineNodeLabel(target),
		`path: ${outlineNodePath(target)}`,
		`rect: ${JSON.stringify(target.rect)}`,
		`actions: ${target.actions.join(",") || "none"}`,
		`capabilities: ${[
			target.canPress ? "press" : undefined,
			target.canFocus ? "focus" : undefined,
			target.canSetValue ? "setValue" : undefined,
			target.canScroll ? "scroll" : undefined,
			target.canIncrement ? "increment" : undefined,
			target.canDecrement ? "decrement" : undefined,
			target.isTextInput ? "textInput" : undefined,
		].filter(Boolean).join(",") || "none"}`,
		`annotations: ${[
			target.offscreen ? "offscreen" : undefined,
			target.pictureOnly ? "pictureOnly" : undefined,
			target.truncated ? "truncated" : undefined,
			target.scrollExtent ? `scrollable ${target.scrollExtent.seen}/${target.scrollExtent.total}` : undefined,
		].filter(Boolean).join(",") || "none"}`,
	];
	return { content: [{ type: "text", text: fields.join("\n") }], details };
}

async function performAct(params: ActParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails | ConfirmationDetails>> {
	switch (params.action) {
		case "press": return await performHelperAct(params, "press", "press", signal);
		case "click": return await performHelperAct(params, "click", "click", signal);
		case "doubleClick": return await performHelperAct({ ...params, clickCount: 2 }, "click", "double_click", signal);
		case "setText": return await performSetText({ ...params, text: params.text ?? "" }, signal);
		case "typeText": return await performTypeText({ ...params, text: params.text ?? "" }, signal);
		case "keypress": return await performKeypress({ ...params, keys: params.keys ?? [] }, signal);
		case "scroll": return await performScroll(params, signal);
		case "drag": return await performDrag(params, signal);
		case "moveMouse": return await performMoveMouse({ ...params, x: toFiniteNumber(params.x, NaN), y: toFiniteNumber(params.y, NaN) }, signal);
		case "wait": return await performWait(params, signal);
	}
}

async function performHelperAct(
	params: WindowTargetParams & { ref?: string; x?: number; y?: number; button?: MouseButtonName; clickCount?: number },
	action: "press" | "click",
	tool: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const actTarget = actTargetFromParams(params, look, action);
	const label = trimOrUndefined(params.ref) ?? ("x" in actTarget ? `(${Math.round(actTarget.x)},${Math.round(actTarget.y)})` : "target");
	return await runActionTool(
		tool,
		signal,
		async (target) => await helperAct(target, actTarget, {
			action,
			params: {
				button: normalizeMouseButton(params.button),
				clickCount: normalizeClickCount(params.clickCount),
			},
		}, signal),
		(target, returnedState, execution) => `${tool.replace(/_/g, " ")} ${label} in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${returnedState ? " Returned the latest outline state." : " Call observe if you need updated state."}`,
		{ responseMode: params.responseMode, targetRef: actTargetPublicRef(params) },
	);
}

async function performTypeText(params: TypeTextParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	if (isBrowserContextId(trimOrUndefined(params.contextId))) {
		throw new Error("type_text is not supported for browser contexts because it has no ref parameter. Use set_text with a browser ref from snapshot instead.");
	}
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const text = typeof params.text === "string" ? params.text : "";
	const actTarget = actTargetFromParams({}, look, "typeText");
	return await runActionTool(
		"type_text",
		signal,
		async (target) => await helperAct(target, actTarget, { action: "typeText", params: { text } }, signal),
		(target, returnedState, execution) => `Inserted text in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${returnedState ? " Returned the latest outline state." : " Call observe if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performSetText(params: SetTextParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails | ConfirmationDetails>> {
	const browserResult = await performBrowserSetText(params, signal);
	if (browserResult) return browserResult;
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const text = typeof params.text === "string" ? params.text : "";
	const actTarget = actTargetFromParams(params, look, "setText");
	return await runActionTool(
		"set_text",
		signal,
		async (target) => await helperAct(target, actTarget, { action: "setText", params: { text } }, signal),
		(target, returnedState, execution) => `Set text value in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${returnedState ? " Returned the latest outline state." : " Call observe if you need updated state."}`,
		{ responseMode: params.responseMode, targetRef: actTargetPublicRef(params) },
	);
}

async function performKeypress(params: KeypressParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const keys = normalizeKeyList(params.keys);
	if (keys.length === 0) throw new Error("keypress.keys must contain at least one key.");
	const openedPendingBrowserLocation = await openBrowserLocationFromPendingAddress(keys, await resolveCurrentTarget(signal), signal);
	if (openedPendingBrowserLocation) {
		return confirmationToolResult("keypress", await resolveCurrentTarget(signal), executionTrace("browser_open_location", "stealth", { outcome: "worked" }), "Opened pending browser location through CDP.");
	}
	const actTarget = actTargetFromParams({}, look, "keypress");
	return await runActionTool(
		"keypress",
		signal,
		async (target) => await helperAct(target, actTarget, { action: "keypress", params: { keys } }, signal),
		(target, returnedState, execution) => `Pressed ${keys.length} key${keys.length === 1 ? "" : "s"} in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${returnedState ? " Returned the latest outline state." : " Call observe if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performScroll(params: ScrollParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | SnapshotDetails | ConfirmationDetails>> {
	const browserResult = await performBrowserScroll(params, signal);
	if (browserResult) return browserResult;
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const ref = trimOrUndefined(params.ref);
	const actTarget = actTargetFromParams(params, look, "scroll");
	const scrollX = normalizeScrollDelta(params.scrollX);
	const scrollY = normalizeScrollDelta(params.scrollY);
	if (scrollX === 0 && scrollY === 0) throw new Error("scroll requires a non-zero scrollX or scrollY.");
	return await runActionTool(
		"scroll",
		signal,
		async (target) => await helperAct(target, actTarget, { action: "scroll", params: { scrollX, scrollY } }, signal),
		(target, returnedState, execution) => {
			const suffix = returnedState ? " Returned the latest outline state." : " Call observe if you need updated state.";
			return ref
				? `Scrolled ${ref} in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${suffix}`
				: `Scrolled in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${suffix}`;
		},
		{ responseMode: params.responseMode, targetRef: actTargetPublicRef(params) },
	);
}

async function performMoveMouse(params: MoveMouseParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const actTarget = actTargetFromParams(params, look, "moveMouse");
	return await runActionTool(
		"move_mouse",
		signal,
		async (target) => await helperAct(target, actTarget, { action: "moveMouse", params: {} }, signal),
		(target, returnedState, execution) =>
			`Moved mouse in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${returnedState ? " Returned the latest outline state." : " Call observe if you need updated state."}`,
		{ responseMode: params.responseMode },
	);
}

async function performDrag(params: DragParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | ConfirmationDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const actTarget = actTargetFromParams(params, look, "drag");
	const path = normalizeActPath(params.path, look);
	return await runActionTool(
		"drag",
		signal,
		async (target) => await helperAct(target, actTarget, { action: "drag", params: { path } }, signal),
		(target, returnedState, execution) => `Dragged in ${target.appName} — ${target.windowTitle}.${actOutcomeText(execution)}${returnedState ? " Returned the latest outline state." : " Call observe if you need updated state."}`,
		{ responseMode: params.responseMode, targetRef: actTargetPublicRef(params) },
	);
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
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
	assertBrowserUseAllowed(target);
	if (!currentPlatformBackend.isBrowserApp(target.appName, target.bundleId)) {
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
	// Prefer CDP when available: event-driven page-load wait and no focus
	// change. Bare search strings keep the platform browser-open path, which
	// has address-bar semantics.
	const cdpTab = /^https?:/i.test(url) && currentPlatformBackend.isChromeFamilyApp(target.appName, target.bundleId)
		? await cdpTabForWindow(target.windowTitle, target.framePoints)
		: undefined;
	if (cdpTab) {
		return await withWindowWriteLock(target, async () => {
			await cdpTab.navigate(url);
			const captureResult = await captureCurrentTarget(signal);
			return await buildToolResult(
				"navigate_browser",
				`Navigated ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`,
				captureResult,
				executionTrace("cdp_navigate", "stealth"),
				signal,
			);
		});
	}

	if (!currentPlatformBackend.isBrowserApp(target.appName, target.bundleId)) {
		throw new Error(`navigate_browser does not yet support direct URL navigation for '${target.appName}'. Use keypress Command+L, type_text, Enter instead.`);
	}
	return await withWindowWriteLock(target, async () => {
		await focusControlledWindow(target, signal);
		const opened = await currentPlatformBackend.openBrowserLocation(target, url, signal);
		if (!opened) throw new Error(`navigate_browser does not yet support direct URL navigation for '${target.appName}'. Use keypress Command+L, type_text, Enter instead.`);
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal);
		return await buildToolResult(
			"navigate_browser",
			`Navigated ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`,
			captureResult,
			executionTrace("browser_open_location", "stealth"),
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

async function performWait(params: WaitParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(((params as any).root ?? params.window), signal);
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
	const summary = `Waited ${ms}ms in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`;
	return await buildToolResult("wait", summary, captureResult, executionTrace("wait", "stealth"), signal);
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

export const executeFind = makeToolExecutor(performListWindows);
export const executeListContexts = makeToolExecutor((_params: Record<string, never>, signal) => performListContexts(signal));
export const executeReadText = makeToolExecutor(performReadText);
export const executeWaitFor = makeToolExecutor(performWaitFor);
export const executeObserve = makeToolExecutor(performObserve);
export const executeSearchUi = makeToolExecutor(performSearchUi);
export const executeExpandUi = makeToolExecutor(performExpandUi);
export const executeInspectUi = makeToolExecutor(performInspectUi);
export const executeAct = makeToolExecutor<ActParams, ComputerUseDetails | SnapshotDetails | ConfirmationDetails>(performAct);
export const executeNavigateBrowser = makeToolExecutor(performNavigateBrowser);
export const executeEvaluateBrowser = makeToolExecutor(performEvaluateBrowser);
export const executeLaunchBrowserContext = makeToolExecutor(performLaunchBrowserContext);

export function reconstructStateFromBranch(ctx: ExtensionContext): void {
	runtimeState.currentTarget = undefined;
	runtimeState.currentCapture = undefined;
	runtimeState.currentStateTarget = undefined;
	runtimeState.currentLook = undefined;
	runtimeState.currentOutline = undefined;
	runtimeState.currentNote = undefined;
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.nextRootRefIndex = 1;

	let restoredCurrent = false;
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any).message;
		if (!message || message.role !== "toolResult") continue;
		if (!AGENT_TOOL_NAMES.has(message.toolName)) continue;

		const rawDetails = message.details as any;
		if (rawDetails?.tool === "find" && Array.isArray(rawDetails.windows)) {
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
					framePoints: {
						x: toFiniteNumber(window.framePoints?.x, 0),
						y: toFiniteNumber(window.framePoints?.y, 0),
						w: Math.max(1, toFiniteNumber(window.framePoints?.w, 1)),
						h: Math.max(1, toFiniteNumber(window.framePoints?.h, 1)),
					},
					scaleFactor: Math.max(1, toFiniteNumber(window.scaleFactor, 1)),
					isMinimized: toBoolean(window.isMinimized),
					isOnscreen: toBoolean(window.isOnscreen),
					isMain: toBoolean(window.isMain),
					isFocused: toBoolean(window.isFocused),
				};
				runtimeState.windowRefs.set(record.ref, record);
				runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), record.ref);
				const match = /^@r(\d+)$/.exec(record.ref);
				if (match) runtimeState.nextRootRefIndex = Math.max(runtimeState.nextRootRefIndex, Number(match[1]) + 1);
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
		if (details.outline?.root && typeof details.outline.lookId === "string") {
			runtimeState.currentOutline = restoreOutline(details.outline);
			runtimeState.currentLook = {
				lookId: details.outline.lookId,
				capturedAt: details.capture.timestamp / 1000,
				window: {
					windowId: Math.trunc(details.target.windowId),
					framePoints: { x: 0, y: 0, w: details.capture.width, h: details.capture.height },
					scaleFactor: details.capture.scaleFactor,
					isModal: false,
					role: "",
					subrole: "",
				},
				image: { jpegBase64: "", width: details.capture.width, height: details.capture.height },
				outline: runtimeState.currentOutline.root,
				timings: {},
				parsedOutline: runtimeState.currentOutline,
			};
		}
		if (details.note) runtimeState.currentNote = details.note;

		restoredCurrent = true;
		continue;
	}
}
