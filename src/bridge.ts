import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canRetryInForeground, outcomeAfterCheck, outcomeAfterObservedValues, prepareAction, type ActionState, type PreparedAction } from "./actions.ts";
import { cdpClickForContext, cdpDragForContext, cdpEvaluateForContext, cdpKeypressForContext, cdpMouseForContext, cdpNavigateContext, cdpScrollForContext, cdpSnapshotForContext, cdpTabForWindow, cdpTypeFocusedForContext, cdpTypeForContext, disconnectCdp, listCdpPageContexts, type CdpConsoleEntry, type CdpPageSnapshot } from "./cdp.ts";
import { getComputerUseConfig, isBrowserUseEnabled, isHeadlessMode, loadComputerUseConfig } from "./config.ts";
import { noteAfterAct, noteFromLook, noteRegionKeyForRef, renderNote, type WindowNote } from "./note.ts";
import { foldToBudget, graftScopedOutline, nodeByRef, outlineNodeLabel, outlineNodePath, rankedTextMatch, restoreOutline, searchOutline, searchOutlineRanked, serializeOutline, serializeOutlineNodeShallow, serializeOutlineSearchMatch, type LookResponse, type Outline, type OutlineChange, type OutlineNode, type OutlineSearchMatch, type SerializedOutline, type SerializedOutlineNode, type SerializedOutlineSearchMatch } from "./outline.ts";
import { applyOutputEnvelope, boundToolError, clearStoredOutputs, OUTPUT_PAGE_BYTES, readStoredOutput, UI_TEXT_PAGE_CHARS } from "./output.ts";
import { AGENT_TOOL_NAMES, type ActParams, type EvaluateBrowserParams, type ExpandUiParams, type ImageMode, type InspectUiParams, type LaunchBrowserParams, type FindParams, type MouseButtonName, type NavigateBrowserParams, type ObserveParams, type ObserveTargetParams, type ReadTextParams, type RootSelector, type SearchUiParams, type StateTargetParams, type UiAction, type WaitForParams } from "./contract.ts";
import { toFiniteNumber } from "./platform/coerce.ts";
import { currentPlatformBackend } from "./platform/index.ts";
import type { FramePoints, HelperActPerformed, HelperActResult, NativeInputDelivery, PlatformActRequest, PlatformApp as HelperApp, PlatformDiagnostics, PlatformFrontmostResult as FrontmostResult, PlatformRoot as HelperWindow } from "./platform/types.ts";
import type { PermissionStatus } from "./permissions.ts";
import { ResourceScheduler } from "./runtime.ts";
import { SavedStates, type CurrentCapture, type CurrentTarget, type OperationState } from "./state.ts";
import { changesBetween, renderChanges, stabilizeRefs } from "./view.ts";
export type { ActParams, EvaluateBrowserParams, ExpandUiParams, ImageMode, InspectUiParams, LaunchBrowserParams, FindParams, MouseButtonName, NavigateBrowserParams, ObserveParams, ObserveTargetParams, ReadTextParams, RootSelector, SearchUiParams, StateTargetParams, UiAction, WaitForParams } from "./contract.ts";

interface ActivationFlags {
	activated: boolean;
	unminimized: boolean;
	raised: boolean;
}

type ExecutionVariant = "stealth" | "default";
type ActionDelivery = "ax" | NativeInputDelivery;
type DeliveryPolicy = "ax_only" | "background" | "default" | "foreground";
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
	steps?: ExecutionTrace[];
	actionCount?: number;
	stoppedAt?: number;
	backgroundFirst?: boolean;
	escalatedToForeground?: boolean;
	escalationReason?: string;
	backgroundAttempt?: { outcome: "foreground_required" | "didnt"; reason: string };
	verification?: {
		status: "verified" | "preexisting" | "failed";
		text?: string;
		role?: string;
		value?: string;
		gone?: boolean;
		timeoutMs: number;
	};
}

interface ComputerUseDetails {
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
	view: "full" | "diff";
	baseStateId?: string;
	changes?: OutlineChange[];
	viewReason?: "root_replaced" | "change_budget_exceeded" | "identity_confidence_low";
	renderedOutline?: string;
	outline?: SerializedOutline;
	note?: WindowNote;
	activation: ActivationFlags;
	execution: ExecutionTrace;
	config?: {
		browser_use: boolean;
		headless: boolean;
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

interface ListWindowsDetails {
	tool: "find_roots";
	query: FindParams;
	totalMatches?: number;
	returned?: number;
	hasMore?: boolean;
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
		url?: string;
	}>;
	config: {
		browser_use: boolean;
		headless: boolean;
	};
}

interface BrowserObservationDetails {
	tool: string;
	kind: "browser_page";
	stateId: string;
	baseStateId?: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	root: { ref: string; kind: "browser_page"; title: string; url: string };
	outline: SerializedOutline;
	renderedOutline: string;
}

interface EvaluateBrowserDetails {
	tool: "evaluate_browser";
	baseStateId: string;
	stateId: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	outline: SerializedOutline;
	renderedOutline: string;
}

interface ReadTextDetails {
	tool: "read_text";
	ref?: string;
	offset: number;
	limit: number;
	totalChars?: number;
	totalBytes?: number;
	hasMore: boolean;
	complete?: boolean;
	text: string;
}

interface WaitForDetails {
	tool: "wait_for";
	stateId: string;
	baseStateId?: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	found: boolean;
	gone?: boolean;
	timedOut?: boolean;
	target?: SerializedOutlineSearchMatch;
	nodeCount?: number;
	text?: string;
	role?: string;
	value?: string;
	scopeRef?: string;
	outline: SerializedOutline;
	renderedOutline: string;
}

interface OutlineToolDetails {
	tool: "search_ui" | "expand_ui" | "inspect_ui";
	stateId?: string;
	lookId?: string;
	outline?: SerializedOutline;
	renderedOutline?: string;
	totalMatches?: number;
	returned?: number;
	hasMore?: boolean;
	matches?: SerializedOutlineSearchMatch[];
	target?: SerializedOutlineNode;
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
	windowRefs: Map<string, WindowRefRecord>;
	windowRefByIdentity: Map<string, string>;
	browserRootByContext: Map<string, string>;
	browserContextByRoot: Map<string, string>;
	nextRootRefIndex: number;
	managedBrowser?: ChildProcess;
	managedBrowserCdpPort?: string;
	previousCdpPort?: string;
	permissionStatus?: PermissionStatus;
	helperDiagnostics?: PlatformDiagnostics;
	lastPermissionCheckAt: number;
}


const MISSING_TARGET_ERROR = "No current controlled window. Call observe_ui first to choose a target window.";
const CURRENT_TARGET_GONE_ERROR =
	"The current controlled window is no longer available. Call observe_ui to choose a new target window.";

const COMMAND_TIMEOUT_MS = 15_000;
const LOOK_TIMEOUT_MS = 33_000;

const SCREENSHOT_TIMEOUT_MS = 25_000;
const ACTION_SETTLE_MS = 280;
const DEFAULT_WAIT_MS = 1_000;

const BROWSER_CONTEXT_PREFIX = "browser:";
const MANAGED_BROWSER_READY_TIMEOUT_MS = 15_000;
const AUTO_IMAGE_MAX_DIMENSION = 900;
const EXPLICIT_IMAGE_MAX_DIMENSION = 1_600;
const BROWSER_TRANSACTION_ACTIONS = new Set<UiAction["action"]>(["press", "click", "setText", "typeText", "keypress", "scroll", "drag", "moveMouse"]);
const HELIUM_EXECUTABLE = "/Applications/Helium.app/Contents/MacOS/Helium";
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const runtimeState: RuntimeState = {
	lastPermissionCheckAt: 0,
	windowRefs: new Map(),
	windowRefByIdentity: new Map(),
	browserRootByContext: new Map(),
	browserContextByRoot: new Map(),
	nextRootRefIndex: 1,
};

const savedStates = new SavedStates();
let resourceScheduler = new ResourceScheduler();

function operationState(): OperationState {
	return savedStates.current();
}

function desktopResourceKey(target: Pick<CurrentTarget, "pid">): string {
	return `desktop-pid:${target.pid}`;
}

function persistOperation(state: OperationState): void {
	if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline) return;
	const resourceKey = state.resourceKey ?? desktopResourceKey(state.currentTarget);
	const epoch = state.epoch ?? resourceScheduler.epoch(resourceKey);
	savedStates.saveDesktop(state, resourceKey, epoch);
}

/** Release handles and state owned by the current Pi session. */
export async function shutdownComputerUseSession(): Promise<void> {
	await resourceScheduler.close();
	resourceScheduler = new ResourceScheduler();
	disconnectCdp();

	const managedBrowser = runtimeState.managedBrowser;
	runtimeState.managedBrowser = undefined;
	if (managedBrowser) {
		managedBrowser.kill("SIGTERM");
		managedBrowser.unref();
	}
	if (runtimeState.managedBrowserCdpPort && process.env.PI_COMPUTER_USE_CDP_PORT === runtimeState.managedBrowserCdpPort) {
		if (runtimeState.previousCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
		else process.env.PI_COMPUTER_USE_CDP_PORT = runtimeState.previousCdpPort;
	}
	runtimeState.managedBrowserCdpPort = undefined;
	runtimeState.previousCdpPort = undefined;

	savedStates.clear();
	clearStoredOutputs();
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.browserRootByContext.clear();
	runtimeState.browserContextByRoot.clear();
	runtimeState.nextRootRefIndex = 1;
	runtimeState.permissionStatus = undefined;
	runtimeState.helperDiagnostics = undefined;
	runtimeState.lastPermissionCheckAt = 0;
	await currentPlatformBackend.shutdown?.();
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function currentRuntimeMode(): ExecutionVariant {
	return isHeadlessMode() ? "stealth" : "default";
}

function currentDeliveryPolicy(): DeliveryPolicy {
	if (isHeadlessMode()) return "background";
	const value = (process.env.PI_COMPUTER_USE_DELIVERY_POLICY ?? process.env.PI_COMPUTER_USE_EVENT_DELIVERY ?? "default").toLowerCase();
	return value === "background" || value === "pid" ? "background" : value === "foreground" || value === "hid" ? "foreground" : value === "ax_only" || value === "ax-only" ? "ax_only" : "default";
}

function nativeInputDelivery(policy = currentDeliveryPolicy()): NativeInputDelivery {
	return policy === "foreground" ? "hid" : "pid";
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

async function withWindowWriteLock<T>(target: ResolvedTarget | CurrentTarget, work: () => Promise<T>): Promise<T> {
	const state = operationState();
	const key = desktopResourceKey(target);
	const baseEpoch = state.epoch ?? resourceScheduler.epoch(key);
	const result = await resourceScheduler.write(key, baseEpoch, async (nextEpoch) => {
		state.resourceKey = key;
		state.epoch = nextEpoch;
		return await work();
	});
	return result.value;
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

function outlineNodeCenter(node: OutlineNode): { x: number; y: number } {
	if (!node.rect) {
		throw new Error(`Outline ref '${node.ref}' has no full-look coordinates after scoped expansion. Re-observe for coordinates.`);
	}
	return { x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2 };
}

function validateStateId(stateId?: string): CurrentCapture {
	const state = operationState();
	if (!state.currentCapture) {
		throw new Error("No observation state is available. Call observe_ui first.");
	}
	const supplied = stateId;
	if (supplied && state.currentCapture.stateId !== supplied) {
		throw new Error(
			`Stale state '${supplied}'. The active operation state is '${state.currentCapture.stateId}'. Observe the root again and retry.`,
		);
	}
	const stateTarget = state.currentStateTarget;
	if (stateTarget && state.currentTarget && (stateTarget.pid !== state.currentTarget.pid || stateTarget.windowId !== state.currentTarget.windowId)) {
		throw new Error("The latest state belongs to a different window. Call observe_ui for the target window and retry.");
	}
	return state.currentCapture;
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
	const state = operationState();
	const outline = state.currentOutline;
	const node = outline ? nodeByRef(outline, ref) : undefined;
	if (!node) {
		const windowHint = state.currentTarget?.windowRef ? `({ root: "${state.currentTarget.windowRef}" })` : "";
		throw new Error(`Outline ref '${ref}' is stale or not available for the latest state. Call observe_ui${windowHint} again and choose a current @e ref.`);
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
	const target = operationState().currentTarget;
	if (!target) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	return target;
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
	if (appQuery && normalizeText(app.appName) !== normalizeText(appQuery)) return false;
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
	if (window.kind === "browser_page") return `- ${window.windowRef} browser_page ${JSON.stringify(window.windowTitle)}${window.url ? ` — ${window.url}` : ""}`;
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

function storeBrowserRootRef(contextId: string): string {
	const existing = runtimeState.browserRootByContext.get(contextId);
	if (existing) return existing;
	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	runtimeState.browserRootByContext.set(contextId, ref);
	runtimeState.browserContextByRoot.set(ref, contextId);
	return ref;
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
	operationState().currentTarget = {
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
		windowTitle: target.windowTitle,
		windowId: target.windowId,
		windowRef,
		nativeWindowRef: target.nativeWindowRef,
	};
}

function normalizeWindowSelector(selector: RootSelector | undefined): string | undefined {
	if (typeof selector === "number" && Number.isFinite(selector)) return String(Math.trunc(selector));
	if (typeof selector === "string") return trimOrUndefined(selector);
	return undefined;
}

async function resolveTargetByWindowSelector(selector: RootSelector, signal?: AbortSignal): Promise<ResolvedTarget> {
	const normalized = normalizeWindowSelector(selector);
	if (!normalized) {
		throw new Error("root target must be a non-empty @r ref or numeric windowId.");
	}

	const current = operationState().currentTarget;
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
			throw new Error(`Root ref '${normalized}' is stale. Call find_roots again and choose a current window.`);
		}
		const resolved = toResolvedTarget(app, match);
		setCurrentTarget(resolved);
		return resolved;
	}

	const numericWindowId = Number(normalized);
	if (normalized.startsWith("@r")) {
		throw new Error(`Root ref '${normalized}' is not available in this session. Call find_roots first.`);
	}

	const config = getComputerUseConfig();
	const candidates = collectWindowDetails(await currentPlatformBackend.listRoots({}, signal), config);
	if (Number.isInteger(numericWindowId) && numericWindowId > 0) {
		const match = candidates.find((candidate) => candidate.windowId === numericWindowId);
		if (!match) {
			throw new Error(`Window id '${numericWindowId}' was not found. Call find_roots again and choose a current window.`);
		}
		const app: HelperApp = { appName: match.app, bundleId: match.bundleId, pid: match.pid };
		assertBrowserUseAllowed(app);
		const roots = await listWindows(match.pid, signal);
		const helperRoot = roots.find((root) => root.windowId === numericWindowId) ?? roots[0];
		if (!helperRoot) {
			throw new Error(`Window id '${numericWindowId}' disappeared during resolution. Call find_roots again.`);
		}
		const resolved = toResolvedTarget(app, helperRoot);
		setCurrentTarget(resolved);
		return resolved;
	}
	const query = normalizeText(normalized);
	const exact = candidates.filter((candidate) => normalizeText(candidate.app) === query || normalizeText(candidate.windowTitle) === query);
	const fuzzy = exact.length > 0 ? exact : candidates.filter((candidate) => `${normalizeText(candidate.app)} ${normalizeText(candidate.windowTitle)}`.includes(query));
	const match = fuzzy.sort((a, b) => Number(b.isFocused) - Number(a.isFocused) || a.zOrder - b.zOrder)[0];
	if (!match) throw new Error(`Root query '${normalized}' did not match any current root. Call find_roots to inspect roots.`);
	const app: HelperApp = { appName: match.app, bundleId: match.bundleId, pid: match.pid };
	const roots = await listWindows(match.pid, signal);
	const helperRoot = roots.find((root) => root.rootRef === match.nativeWindowRef || root.windowRef === match.nativeWindowRef || root.windowId === match.windowId) ?? roots[0];
	const resolved = toResolvedTarget(app, helperRoot);
	setCurrentTarget(resolved);
	return resolved;
}

async function selectWindowIfProvided(selector: RootSelector | undefined, signal?: AbortSignal): Promise<void> {
	if (!normalizeWindowSelector(selector)) return;
	const state = operationState();
	const previous = state.currentTarget;
	const selected = await resolveTargetByWindowSelector(selector!, signal);
	const changedWindow =
		!previous ||
		previous.pid !== selected.pid ||
		(previous.windowId > 0 && selected.windowId > 0 ? previous.windowId !== selected.windowId : previous.windowRef !== selected.windowRef);
	if (changedWindow) {
		state.currentCapture = undefined;
		state.currentLook = undefined;
		state.currentOutline = undefined;
		delete state.currentNote;
		state.resourceKey = undefined;
		state.epoch = undefined;
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
		throw new Error("No frontmost controllable root was found. Open an app window and call observe_ui again.");
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
	const root = normalizeWindowSelector(selection.root);
	return !root || target.windowRef === root;
}

async function resolveTargetForObserve(signal?: AbortSignal): Promise<ResolvedTarget> {
	return operationState().currentTarget ? await resolveCurrentTarget(signal) : await resolveFrontmostTarget(signal);
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

async function performLook(target: ResolvedTarget, options: { readText: "auto" | "always" | "never"; baseLookId?: string; scopeRef?: string; maxDimension?: number; includeImage?: boolean }, signal?: AbortSignal): Promise<LookResponse> {
	if ((!Number.isFinite(target.windowId) || target.windowId <= 0) && !target.nativeWindowRef) throw new Error(`Current platform requires a stable root id to observe '${target.windowTitle}'. Call find_roots and select a root with a stable id.`);
	return await currentPlatformBackend.observe({
		target: nativeWindowRequest(target),
		baseLookId: options.baseLookId,
		readText: options.readText,
		scopeRef: options.scopeRef,
		maxDimension: options.maxDimension,
		includeImage: options.includeImage,
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

async function captureCurrentTarget(signal?: AbortSignal, readText: "auto" | "always" | "never" = "auto", maxDimension = AUTO_IMAGE_MAX_DIMENSION, targetOverride?: ResolvedTarget, includeImage = true): Promise<CaptureResult> {
	const state = operationState();
	const baseOutline = state.currentOutline;
	const baseTarget = state.currentTarget;
	let target = targetOverride ?? await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const look = await performLook(target, { maxDimension, readText, includeImage }, signal);
	const outline = stabilizeRefs(baseTarget && sameRootIdentity(baseTarget, target) ? baseOutline : undefined, look.parsedOutline!);
	look.parsedOutline = outline;
	look.outline = outline.root;
	const capture = captureForLook(look);

	setCurrentTarget(target);
	state.currentCapture = capture;
	state.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	state.currentLook = look;
	state.currentOutline = outline;
	state.currentNote = noteFromLook(state.currentNote, outline, noteWindowForTarget(target, look));
	state.resourceKey = desktopResourceKey(target);
	state.epoch ??= resourceScheduler.epoch(state.resourceKey);

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
	imageMode: ImageMode = operationState().currentImageMode ?? "auto",
	base?: { stateId: string; outline: Outline },
): Promise<AgentToolResult<ComputerUseDetails>> {
	const state = operationState();
	const fallbackReason = imageFallbackReason(tool, result, imageMode);
	const transition = base ? changesBetween(base.outline, result.outline) : undefined;
	const useDiff = Boolean(transition && !transition.useFullView);
	const folded = foldToBudget(result.outline);
	const renderedNote = renderNote(state.currentNote);

	const details: ComputerUseDetails = {
		tool,
		target: {
			app: result.target.appName,
			bundleId: result.target.bundleId,
			pid: result.target.pid,
			windowTitle: result.target.windowTitle,
			windowId: result.target.windowId,
			windowRef: result.target.windowRef ?? state.currentTarget?.windowRef,
			nativeWindowRef: result.target.nativeWindowRef ?? state.currentTarget?.nativeWindowRef,
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
		view: useDiff ? "diff" : "full",
		baseStateId: transition ? base?.stateId : undefined,
		changes: useDiff ? transition?.changes : undefined,
		viewReason: transition?.useFullView ? transition.reason : undefined,
		renderedOutline: folded.text,
		outline: serializeOutline(result.outline),
		note: state.currentNote,
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
	// The model must echo capture.stateId into follow-up tools. Exposing only the
	// helper-internal lookId here makes a plausible but invalid stateId easy to use.
	const renderedChanges = useDiff ? renderChanges(transition!.changes) : "";
	const outlineText = useDiff
		? `\n\nChanges (${transition!.changedNodeCount}, ${base!.stateId} → ${result.capture.stateId}):\n${renderedChanges || "(no element changes)"}\nUse stateId ${result.capture.stateId} for subsequent actions and queries.`
		: `\n\nOutline (${folded.nodeCount} nodes, stateId ${result.capture.stateId}${transition?.reason ? `, full view: ${transition.reason}` : ""}${folded.truncated ? ", folded output truncated" : ""}):\n${folded.text}`;
	const fallbackText = fallbackReason ? `\n\n${fallbackReason.message}` : "";
	const deltaText = rootDeltaLines(execution).join("\n");
	const content: AgentToolResult<ComputerUseDetails>["content"] = [{ type: "text", text: `${summary}${deltaText ? `\n${deltaText}` : ""}${consoleText}${noteText}${outlineText}${fallbackText}` }];
	if (fallbackReason && result.look.image?.jpegBase64) {
		content.push({ type: "image", data: result.look.image.jpegBase64, mimeType: result.look.image.mimeType ?? "image/jpeg" });
	}

	return { content, details };
}

type NativePreparedAction = Exclude<PreparedAction, { action: "wait" }>;

function currentLookOrThrow(): LookResponse {
	const state = operationState();
	if (!state.currentLook || !state.currentCapture) {
		throw new Error("No current look. Call observe_ui first, then act using refs or coordinates from that look.");
	}
	return state.currentLook;
}

function ensurePointIsInLookImage(x: number, y: number, look: LookResponse, errorPrefix = "Coordinates"): void {
	if (!look.image?.jpegBase64) {
		throw new Error(`${errorPrefix} require an image-bearing root. This look is outline-only; use an @e ref with a semantic action or observe an image-bearing root.`);
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${errorPrefix} must be finite numbers.`);
	}
	if (x < 0 || y < 0 || x >= look.image.width || y >= look.image.height) {
		throw new Error(`${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest look image bounds (${look.image.width}x${look.image.height}). Call observe_ui again and retry.`);
	}
}

function modelRefForRootDelta(delta: NonNullable<HelperActResult["rootDelta"]>[number]): string | undefined {
	if (!delta.ref) return undefined;
	if (delta.ref.startsWith("@r")) return delta.ref;
	for (const record of runtimeState.windowRefs.values()) {
		if (record.nativeWindowRef === delta.ref || record.ref === delta.ref) return record.ref;
	}
	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	const current = operationState().currentTarget;
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

function executionTraceFromAct(result: HelperActResult, policy = currentDeliveryPolicy()): ExecutionTrace {
	const rootDelta = result.rootDelta?.map((delta) => ({ ...delta, ref: modelRefForRootDelta(delta) }));
	return executionTrace("act", result.performed?.delivery === "ax" ? "stealth" : "default", {
		outcome: result.outcome,
		performed: result.performed,
		evidence: result.evidence,
		error: result.error,
		stoppedAt: result.stoppedAt,
		rootDelta,
		delivery: result.performed?.delivery,
		deliveryPolicy: policy,
	});
}

async function helperAct(
	target: ResolvedTarget,
	action: NativePreparedAction,
	headless: boolean,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const checked = (candidate: HelperActResult): HelperActResult => {
		if (!candidate || !["worked", "didnt", "unknown"].includes(candidate.outcome)) {
			throw new Error("Helper act returned an invalid result without an outcome.");
		}
		return candidate;
	};
	const textTimeout = "text" in action.params ? action.params.text.length * 25 + 4_000 : COMMAND_TIMEOUT_MS;
	const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, textTimeout);
	if ((action.usesCurrentFocus || action.needsForeground) && !headless) {
		const foreground = checked(await currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }));
		const trace = executionTraceFromAct(foreground, "foreground");
		trace.backgroundFirst = false;
		return trace;
	}
	try {
		const initialPolicy = headless ? "ax_only" : "background";
		const result = checked(await currentPlatformBackend.act(helperActRequest(target, action, initialPolicy), { signal, timeoutMs }));
		if (canRetryInForeground(action, result.outcome, headless)) {
			const foreground = checked(await currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }));
			const trace = executionTraceFromAct(foreground, "foreground");
			trace.backgroundFirst = true;
			trace.escalatedToForeground = true;
			trace.escalationReason = "side_effect_free_didnt";
			trace.backgroundAttempt = { outcome: "didnt", reason: "Background input produced no observable value change; a foreground retry was safe." };
			return trace;
		}
		const trace = executionTraceFromAct(result, "background");
		trace.backgroundFirst = true;
		return trace;
	} catch (error) {
		const code = (error as Error & { code?: string })?.code;
		if (code !== "foreground_required" || headless) throw error;
		const foreground = checked(await currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }));
		const trace = executionTraceFromAct(foreground, "foreground");
		trace.backgroundFirst = true;
		trace.escalatedToForeground = true;
		trace.escalationReason = code;
		trace.backgroundAttempt = { outcome: "foreground_required", reason: error instanceof Error ? error.message : String(error) };
		return trace;
	}
}

function helperActRequest(target: ResolvedTarget, action: NativePreparedAction, policy = currentDeliveryPolicy()): PlatformActRequest {
	const look = currentLookOrThrow();
	const delivery = nativeInputDelivery(policy);
	const base = { lookId: look.lookId, pid: target.pid, target: action.target, policy };
	return (() => {
		switch (action.action) {
			case "press":
			case "click": return { ...base, action: action.action, params: { ...action.params, delivery } };
			case "setText": return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "typeText": return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "keypress": return { ...base, action: action.action, params: { keys: action.params.keys, delivery } };
			case "scroll": return { ...base, action: action.action, params: { scrollX: action.params.scrollX, scrollY: action.params.scrollY, delivery } };
			case "drag": return { ...base, action: action.action, params: { path: action.params.path, delivery } };
			case "moveMouse": return { ...base, action: action.action, params: { delivery } };
		}
	})();
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

// Side effect: stores stable @r refs for discovered windows in runtimeState.
function collectWindowDetails(roots: HelperWindow[], config: ReturnType<typeof getComputerUseConfig>): ListWindowsDetails["windows"] {
	const windows: ListWindowsDetails["windows"] = [];
	for (const window of roots) {
		if (!window.pid) continue;
		const app: HelperApp = {
			appName: window.appName ?? "Unknown App",
			bundleId: window.bundleId,
			pid: window.pid,
		};
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
	windows.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle));
	return windows;
}

async function rootsForFind(query: FindParams, signal?: AbortSignal): Promise<HelperWindow[]> {
	if (Number.isFinite(query.pid)) {
		return await currentPlatformBackend.listRoots({ pid: query.pid }, signal);
	}
	if (!query.app && !query.bundleId) {
		return await currentPlatformBackend.listRoots({}, signal);
	}

	let apps = (await listApps(signal)).filter((app) => appMatchesWindowQuery(app, query));
	if (query.app) {
		const normalizedApp = normalizeText(query.app);
		const exact = apps.filter((app) => normalizeText(app.appName) === normalizedApp);
		if (exact.length > 0) apps = exact;
	}
	const roots: HelperWindow[] = [];
	for (const app of apps) roots.push(...await listWindows(app.pid, signal));
	return roots;
}

async function performListWindows(params: FindParams, signal?: AbortSignal): Promise<AgentToolResult<ListWindowsDetails>> {
	const rawParams = params ?? {};
	const query: FindParams = {
		text: trimOrUndefined(rawParams.text),
		app: trimOrUndefined(rawParams.app),
		bundleId: trimOrUndefined(rawParams.bundleId),
		pid: Number.isFinite(rawParams.pid) ? Math.trunc(rawParams.pid!) : undefined,
		kind: rawParams.kind,
	};
	const config = getComputerUseConfig();
	const nativeRoots = await rootsForFind(query, signal);
	const desktopForest = collectWindowDetails(nativeRoots, config).filter((root) => appMatchesWindowQuery({
		appName: root.app,
		bundleId: root.bundleId,
		pid: root.pid,
	}, query));
	const includeBrowserPages = !query.pid && !query.bundleId && (!query.app || normalizeText(query.app) === "browser") && config.browser_use;
	const browserForest: ListWindowsDetails["windows"] = !includeBrowserPages ? [] : (await listCdpPageContexts().catch(() => []))
		.map((page) => ({
			app: "Browser",
			pid: 0,
			kind: "browser_page",
			windowTitle: page.title || page.url,
			windowRef: storeBrowserRootRef(page.contextId),
			framePoints: { x: 0, y: 0, w: 1, h: 1 },
			scaleFactor: 1,
			isMinimized: false,
			isOnscreen: true,
			isMain: false,
			isFocused: false,
			isModal: false,
			zOrder: Number.MAX_SAFE_INTEGER,
			browserUseAllowed: true,
			score: 0,
			url: page.url,
		}));
	const allRoots = [...desktopForest, ...browserForest];
	const forest = allRoots.filter((root) => !query.kind || root.kind === query.kind);
	const ranked = forest.map((root, order) => ({ root, order, match: query.text ? rankedTextMatch([root.app, root.windowTitle], query.text) : { reason: "filter" as const, score: 1 } }))
		.filter((entry) => entry.match)
		.sort((a, b) => b.match!.score - a.match!.score || Number(b.root.isFocused) - Number(a.root.isFocused) || a.root.zOrder - b.root.zOrder || a.order - b.order);
	const totalMatches = ranked.length;
	const windows = ranked.slice(0, 12).map((entry) => entry.root);
	const details: ListWindowsDetails = { tool: "find_roots", query, windows, totalMatches, returned: windows.length, hasMore: totalMatches > windows.length, config };
	const lines = windows.map(formatWindowLine);
	const text = lines.length
		? `Found ${totalMatches} matching root${totalMatches === 1 ? "" : "s"}; returned ${windows.length}${totalMatches > windows.length ? ". Refine the filters for additional roots" : ""}. Use @r refs with observe_ui({ root: "@rN" }).\n${lines.join("\n")}`
		: query.text || query.app || query.bundleId || query.pid || query.kind
			? "No roots matched the supplied filters."
			: "No roots are currently visible to pi-computer-use.";
	return { content: [{ type: "text", text }], details };
}

function normalizeImageMode(value: unknown): ImageMode {
	return value === "always" || value === "never" ? value : "auto";
}

function isBrowserContextId(contextId: string | undefined): contextId is string {
	return Boolean(contextId?.startsWith(BROWSER_CONTEXT_PREFIX));
}

function browserSnapshotTarget(snapshotId: string | undefined, ref: string | undefined): { contextId: string; backendNodeId?: number } | undefined {
	if (!snapshotId || !ref) return undefined;
	const record = savedStates.get(snapshotId);
	const snapshot = record?.value.kind === "browser" ? record.value.snapshot : undefined;
	const target = snapshot?.targets.find((candidate) => candidate.ref === ref);
	if (!snapshot || !target) return undefined;
	return { contextId: snapshot.contextId, backendNodeId: target.backendNodeId };
}

function browserContextForOperation(): string | undefined {
	const contextId = operationState().contextId;
	return isBrowserContextId(contextId) ? contextId : undefined;
}

async function withBrowserWrite<T>(contextId: string, work: () => Promise<T>): Promise<T> {
	const state = operationState();
	const targetId = contextId.slice(BROWSER_CONTEXT_PREFIX.length);
	const resourceKey = `cdp:${targetId}`;
	const baseEpoch = state.epoch ?? resourceScheduler.epoch(resourceKey);
	const result = await resourceScheduler.write(resourceKey, baseEpoch, async (nextEpoch) => {
		state.resourceKey = resourceKey;
		state.epoch = nextEpoch;
		return await work();
	});
	return result.value;
}

function browserObservationResult(browser: CdpPageSnapshot, resourceKey: string, epoch: number, tool: string, base?: { stateId: string; outline: SerializedOutline }): AgentToolResult<BrowserObservationDetails> {
	savedStates.set({ stateId: browser.snapshotId, resourceKey, epoch, value: { kind: "browser", snapshot: browser, outline: browser.outline } });
	const currentOutline = restoreOutline(browser.outline);
	const transition = base ? changesBetween(restoreOutline(base.outline), currentOutline) : undefined;
	const useDiff = Boolean(transition && !transition.useFullView);
	const folded = foldToBudget(currentOutline);
	const root = { ref: storeBrowserRootRef(browser.contextId), kind: "browser_page" as const, title: browser.title, url: browser.url };
	const details: BrowserObservationDetails = { tool, kind: "browser_page", stateId: browser.snapshotId, baseStateId: base?.stateId, view: useDiff ? "diff" : "full", changes: useDiff ? transition?.changes : undefined, root, outline: browser.outline, renderedOutline: folded.text };
	const viewText = useDiff
		? `Changes (${transition!.changedNodeCount}, ${base!.stateId} → ${browser.snapshotId}):\n${renderChanges(transition!.changes) || "(no element changes)"}\nUse stateId ${browser.snapshotId} for subsequent actions and queries.`
		: folded.text;
	return { content: [{ type: "text", text: `${tool} completed for ${root.ref} ${JSON.stringify(browser.title)}. State ${browser.snapshotId}.\n${viewText}` }], details };
}

async function refreshBrowserSnapshot(contextId: string, tool: string, base?: { stateId: string; outline: SerializedOutline }): Promise<AgentToolResult<BrowserObservationDetails>> {
	const browser = await cdpSnapshotForContext(contextId);
	if (!browser) throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
	const state = operationState();
	const resourceKey = state.resourceKey ?? `cdp:${browser.targetId}`;
	return browserObservationResult(browser, resourceKey, state.epoch ?? resourceScheduler.epoch(resourceKey), tool, base);
}

function sliceText(value: string, offsetValue: unknown, _limitValue?: unknown): Pick<ReadTextDetails, "offset" | "limit" | "totalChars" | "hasMore" | "text"> {
	const offset = Math.max(0, Math.trunc(toFiniteNumber(offsetValue, 0)));
	const limit = UI_TEXT_PAGE_CHARS;
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
	const ref = trimOrUndefined(params.ref);
	if (ref?.startsWith("@o")) {
		const page = readStoredOutput(ref, params.offset);
		if (!page) throw new Error(`Output ref '${ref}' is unavailable or was evicted. Rerun the focused query.`);
		const details: ReadTextDetails = { tool: "read_text", ref, ...page };
		const suffix = page.hasMore
			? `\n\ncontinue: read_text({ ref: "${ref}", offset: ${page.offset + page.limit} })`
			: page.complete ? "" : "\n\ncontinuation storage limit reached; rerun a more focused query for the remainder";
		return { content: [{ type: "text", text: `${page.text || "(empty output page)"}${suffix}` }], details };
	}
	const contextId = operationState().contextId;
	if (isBrowserContextId(contextId)) {
		const snapshot = operationState().browserSnapshot;
		if (!snapshot || snapshot.contextId !== contextId) throw new Error(`Browser state '${params.stateId}' is unavailable. Observe the browser root again.`);
		if (!ref) throw new Error("read_text requires an @e ref for browser contexts; use the outline root ref for whole-page text.");
		const outline = restoreOutline(snapshot.outline);
		const node = nodeByRef(outline, ref);
		if (!node) throw new Error(`Browser text ref '${ref}' is unavailable in this state.`);
		const collect = (current: OutlineNode): string[] => [outlineNodeLabel(current), ...current.text.map((item) => item.string), ...current.children.flatMap(collect)].filter(Boolean);
		const value = node === outline.root ? snapshot.text : [...new Set(collect(node))].join("\n");
		const sliced = sliceText(value, params.offset);
		const details: ReadTextDetails = { tool: "read_text", ref, ...sliced };
		return { content: [{ type: "text", text: sliced.text || "(empty text slice)" }], details };
	}

	validateStateId(params.stateId);
	if (!ref) throw new Error("read_text requires ref for desktop contexts. Call observe_ui/inspect_ui and use a text-bearing outline ref.");
	const node = outlineNodeByRef(ref);
	const state = operationState();
	if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
	const raw = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await currentPlatformBackend.readText({
		lookId: state.currentOutline!.lookId,
		elementRef: wireRefForNode(node),
		offset: Math.max(0, Math.trunc(toFiniteNumber(params.offset, 0))),
		limit: UI_TEXT_PAGE_CHARS,
	}, { signal, timeoutMs: COMMAND_TIMEOUT_MS }))).value;
	const text = raw.text;
	const details: ReadTextDetails = {
		tool: "read_text",
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

function conditionScopeRef(params: WaitForParams | NonNullable<ActParams["expect"]>): string | undefined {
	const ref = trimOrUndefined(params.ref);
	const scopeRef = trimOrUndefined(params.scopeRef);
	if (ref && scopeRef) throw new Error("A UI condition accepts ref or scopeRef, not both.");
	return ref ?? scopeRef;
}

function validateCondition(params: WaitForParams | NonNullable<ActParams["expect"]>): { text?: string; role?: string; value?: string; scopeRef?: string; scopeExact: boolean; gone: boolean; timeoutMs: number } {
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const value = trimOrUndefined(params.value);
	const scopeRef = conditionScopeRef(params);
	if (!text && !role && !value) throw new Error("A UI condition requires text, role, or value.");
	if (role && !text && !value && !scopeRef) throw new Error("A role-only UI condition requires ref or scopeRef.");
	if (value && !params.ref) throw new Error("A value UI condition requires an exact ref.");
	return { text, role, value, scopeRef, scopeExact: Boolean(params.ref), gone: params.until === "absent", timeoutMs: normalizeWaitTimeoutMs(params.timeoutMs) };
}

function nodeWithinScope(node: OutlineNode, scopeRef: string | undefined, scopeExact: boolean): boolean {
	if (!scopeRef) return true;
	if (scopeExact) return node.ref === scopeRef;
	let current: OutlineNode | undefined = node;
	while (current) {
		if (current.ref === scopeRef) return true;
		current = current.parent;
	}
	return false;
}

function normalizedRole(value: string): string {
	return value.toLowerCase().replace(/^ax/, "").replace(/[ _-]+/g, "");
}

function platformRole(outline: Outline, role: string | undefined): string | undefined {
	if (!role) return undefined;
	return outline.nodes.find((node) => normalizedRole(node.role) === normalizedRole(role))?.role ?? role;
}

function outlineConditionPresent(outline: Outline, condition: ReturnType<typeof validateCondition>): boolean {
	return searchOutline(outline, condition.text, undefined, undefined, outline.nodes.length)
		.some((match) => (!condition.role || normalizedRole(match.node.role) === normalizedRole(condition.role)) && nodeWithinScope(match.node, condition.scopeRef, condition.scopeExact) && (!condition.value || normalizeText(match.node.value) === normalizeText(condition.value)));
}

function conditionScopeNode(outline: Outline, condition: ReturnType<typeof validateCondition>): OutlineNode | undefined {
	const scopeNode = condition.scopeRef ? nodeByRef(outline, condition.scopeRef) : undefined;
	if (condition.scopeRef && !scopeNode) throw new Error(`Condition scope ref '${condition.scopeRef}' is unavailable in this state.`);
	return scopeNode;
}

async function performWaitFor(params: WaitForParams, signal?: AbortSignal): Promise<AgentToolResult<WaitForDetails>> {
	const contextId = operationState().contextId;
	const condition = validateCondition(params);
	const { text, role, value, scopeRef, scopeExact, gone, timeoutMs } = condition;

	if (isBrowserContextId(contextId)) {
		const state = operationState();
		if (!state.resourceKey) throw new Error("The browser observation has no live resource identity. Observe again.");
		const baseSnapshot = state.browserSnapshot;
		if (!baseSnapshot) throw new Error("Browser wait requires a complete base observation.");
		conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
		const deadline = Date.now() + timeoutMs;
		let lastSnapshot: CdpPageSnapshot | undefined;
		let lastEpoch = state.epoch ?? resourceScheduler.epoch(state.resourceKey);
		const finish = (found: boolean, timedOut?: boolean): AgentToolResult<WaitForDetails> => {
			if (!lastSnapshot) throw new Error("Browser wait completed without an observation.");
			savedStates.set({ stateId: lastSnapshot.snapshotId, resourceKey: state.resourceKey!, epoch: lastEpoch, value: { kind: "browser", snapshot: lastSnapshot, outline: lastSnapshot.outline } });
			const successorOutline = restoreOutline(lastSnapshot.outline);
			const transition = changesBetween(restoreOutline(baseSnapshot.outline), successorOutline);
			const useDiff = !transition.useFullView;
			const renderedOutline = foldToBudget(successorOutline).text;
			const details: WaitForDetails = { tool: "wait_for", stateId: lastSnapshot.snapshotId, baseStateId: baseSnapshot.snapshotId, view: useDiff ? "diff" : "full", changes: useDiff ? transition.changes : undefined, found, gone: found && gone || undefined, timedOut, nodeCount: lastSnapshot.targets.length, text, role, value, scopeRef, outline: lastSnapshot.outline, renderedOutline };
			const message = found ? (gone ? "Condition disappeared." : "Condition appeared.") : `Timed out after ${timeoutMs}ms waiting for condition.`;
			const viewText = useDiff ? `${renderChanges(transition.changes) || "(no element changes)"}\nUse stateId ${lastSnapshot.snapshotId} for subsequent actions and queries.` : renderedOutline;
			return { content: [{ type: "text", text: `${message}\n${viewText}` }], details };
		};
		do {
			const scheduled = await resourceScheduler.read(state.resourceKey, async () => await cdpSnapshotForContext(contextId));
			lastSnapshot = scheduled.value;
			lastEpoch = scheduled.epoch;
			if (!lastSnapshot) throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
			const present = outlineConditionPresent(restoreOutline(lastSnapshot.outline), condition);
			if (present !== gone) return finish(true);
			await sleep(200, signal);
		} while (Date.now() < deadline);
		return finish(false, true);
	}

	const state = operationState();
	const baseView = { stateId: state.currentCapture!.stateId, outline: state.currentOutline! };
	let target = await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const scopeNode = conditionScopeNode(state.currentOutline!, condition);
	const raw = await currentPlatformBackend.waitFor({
		...nativeWindowRequest(target),
		lookId: state.currentOutline!.lookId,
		text,
		role: platformRole(state.currentOutline!, role),
		value,
		scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
		scopeExact,
		gone,
		timeoutMs,
	}, { signal, timeoutMs: timeoutMs + 2_000 });
	if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
	const refreshed = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await captureCurrentTarget(signal, "auto"))).value;
	const transition = changesBetween(baseView.outline, refreshed.outline);
	const useDiff = !transition.useFullView;
	const matches = searchOutline(refreshed.outline, text, role, undefined, 1);
	const foundTarget = matches[0];
	const details: WaitForDetails = {
		tool: "wait_for",
		stateId: refreshed.capture.stateId,
		baseStateId: baseView.stateId,
		view: useDiff ? "diff" : "full",
		changes: useDiff ? transition.changes : undefined,
		found: raw.found,
		gone: raw.gone || undefined,
		timedOut: raw.timedOut || undefined,
		target: foundTarget ? serializeOutlineSearchMatch(foundTarget) : undefined,
		nodeCount: Number.isFinite(raw.nodeCount) ? Number(raw.nodeCount) : refreshed.outline.nodes.length,
		text,
		role,
		value,
		scopeRef,
		outline: serializeOutline(refreshed.outline),
		renderedOutline: foldToBudget(refreshed.outline).text,
	};
	const message = details.found ? (details.gone ? "Condition disappeared." : "Condition appeared.") : `Timed out after ${timeoutMs}ms waiting for condition.`;
	const viewText = useDiff ? `${renderChanges(transition.changes) || "(no element changes)"}\nUse stateId ${refreshed.capture.stateId} for subsequent actions and queries.` : details.renderedOutline;
	return { content: [{ type: "text", text: `${message}\n${viewText}` }], details };
}

function sameRootIdentity(a: CurrentTarget, b: CurrentTarget): boolean {
	if (a.pid !== b.pid) return false;
	if (a.windowId > 0 && b.windowId > 0) return a.windowId === b.windowId;
	if (a.nativeWindowRef && b.nativeWindowRef) return a.nativeWindowRef === b.nativeWindowRef;
	return normalizeText(a.windowTitle) === normalizeText(b.windowTitle);
}

/** Side effects: captures/updates current target, capture state, look, and parsed outline. */
async function performObserve(params: ObserveParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | BrowserObservationDetails>> {
	const requestedRoot = typeof params.root === "string" ? params.root : undefined;
	if (requestedRoot && !/^@r\d+$/.test(requestedRoot)) throw new Error("observe_ui.root must be an exact @r ref issued by find_roots.");
	const browserContextId = requestedRoot ? runtimeState.browserContextByRoot.get(requestedRoot) : undefined;
	if (isBrowserContextId(browserContextId)) {
		const targetId = browserContextId.slice(BROWSER_CONTEXT_PREFIX.length);
		const resourceKey = `cdp:${targetId}`;
		const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(browserContextId));
		const browser = scheduled.value;
		if (!browser) throw new Error(`Browser context '${browserContextId}' is no longer available. Call find_roots again.`);
		return browserObservationResult(browser, resourceKey, scheduled.epoch, "observe_ui");
	}
	const state = operationState();
	const mode = params.mode ?? "fused";
	const image = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
	const defaultReadText = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
	const readText = params.readText ?? defaultReadText;
	state.currentImageMode = normalizeImageMode(image);
	const selection: ObserveTargetParams = { root: normalizeWindowSelector(params.root) };
	const requestedTarget = selection.root
		? await resolveTargetByWindowSelector(params.root!, signal)
		: await resolveTargetForObserve(signal);
	const imageMode = normalizeImageMode(image);
	const resourceKey = desktopResourceKey(requestedTarget);
	const scheduled = await resourceScheduler.read(resourceKey, async (epoch) => {
		state.resourceKey = resourceKey;
		state.epoch = epoch;
		return await captureCurrentTarget(signal, readText, imageMode === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION, requestedTarget, imageMode !== "never");
	});
	const captureResult = scheduled.value;
	// Model @r refs are re-minted on re-resolution, so ref string equality
	// alone false-positives as drift for the same root; compare stable
	// identity against the resolved request too.
	if (!matchesObserveSelection(captureResult.target, selection) && !sameRootIdentity(captureResult.target, requestedTarget)) {
		throw new Error(
			`Observation target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call observe_ui again or specify a more exact window title.`,
		);
	}
	const summary = `Observed ${mode} ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`;
	return await buildToolResult("observe_ui", summary, captureResult, executionTrace("look", "stealth"), signal, imageMode);
}

function currentOutlineOrThrow(stateId?: string): Outline {
	validateStateId(stateId);
	const outline = operationState().currentOutline;
	if (!outline) throw new Error("No observation outline is available. Call observe_ui first.");
	return outline;
}

function matchIsNonActionableStatic(match: OutlineSearchMatch): boolean {
	const node = match.node;
	return !node.canPress && !node.canFocus && !node.canSetValue && node.actions.length === 0 && !node.pictureOnly;
}

function shouldEscalateSearchOCR(matches: OutlineSearchMatch[], _text?: string): boolean {
	return matches.length === 0 || matches.every(matchIsNonActionableStatic);
}

/** Pure outline query unless a window selector is supplied, in which case current target selection may change. */
async function performSearchUi(params: SearchUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	let outline = currentOutlineOrThrow(params.stateId);
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const capability = trimOrUndefined(params.capability);
	if (!text && !role && !capability) throw new Error("search_ui requires text, role, or capability. Use observe_ui for a bounded overview.");
	const limit = 12;
	let ranked = searchOutlineRanked(outline, text, role, capability, limit);
	let matches = ranked.matches;
	let escalatedOCR = false;
	const look = state.currentLook;
	if (shouldEscalateSearchOCR(matches, text) && look && look.readText?.requested !== "never" && !look.readText?.executed && state.lastSearchOcrEscalatedLookId !== look.lookId) {
		state.lastSearchOcrEscalatedLookId = look.lookId;
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		// captureCurrentTarget adopts the new look/outline/capture into
		// runtimeState, so refs in these matches stay actable. Keep the image
		// payload: OCR-only matches are clicked by coordinate, and coordinate
		// acts require the current look to be image-bearing.
		if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
		const captureResult = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await captureCurrentTarget(signal, "always", AUTO_IMAGE_MAX_DIMENSION, currentTarget))).value;
		outline = captureResult.outline;
		ranked = searchOutlineRanked(outline, text, role, capability, limit);
		matches = ranked.matches;
		escalatedOCR = true;
	}
	const detailMatches = matches.map(serializeOutlineSearchMatch);
	const details: OutlineToolDetails = { tool: "search_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, matches: detailMatches, totalMatches: ranked.totalMatches, returned: matches.length, hasMore: ranked.totalMatches > matches.length, note: state.currentNote };
	const lines = matches.map((match) => `${match.ref} ${match.role || "Unknown"} ${JSON.stringify(match.label || "(unlabeled)")} [${match.matchReason}${match.matchReason === "fuzzy" ? ` ${match.score?.toFixed(2)}` : ""}]\n  path: ${match.path}`);
	const noteHeader = renderNote(state.currentNote);
	const noteText = noteHeader ? `${noteHeader}\n\n` : "";
	const escalationText = escalatedOCR ? " OCR text was escalated for this search after the cached outline had no matches." : "";
	const moreText = ranked.totalMatches > matches.length ? ` Refine the query to inspect ${ranked.totalMatches - matches.length} additional matches.` : "";
	return { content: [{ type: "text", text: `${noteText}Found ${ranked.totalMatches} outline match${ranked.totalMatches === 1 ? "" : "es"}; returned ${matches.length}.${moreText}${escalationText}\n${lines.join("\n")}` }], details };
}

/** Reads cached outline; truncated refs trigger a scoped look. */
async function performExpandUi(params: ExpandUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	let outline = currentOutlineOrThrow(params.stateId);
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("expand_ui.ref is required.");
	const initialTarget = nodeByRef(outline, ref);
	if (!initialTarget) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	let target: OutlineNode = initialTarget;
	const depth = Math.max(1, Math.min(8, Math.trunc(toFiniteNumber(params.depth, 3))));
	const regionKey = noteRegionKeyForRef(outline, ref);
	const regionChanged = Boolean(regionKey && state.currentNote?.regions.some((region) => region.key === regionKey && region.status === "changed"));
	if (target.truncated || regionChanged) {
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		const targetWireRef = wireRefForNode(target);
		if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
		const scoped = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await performLook(currentTarget, {
			readText: "auto",
			baseLookId: outline.lookId,
			scopeRef: targetWireRef,
			maxDimension: 1,
			includeImage: false,
		}, signal))).value;
		target = graftScopedOutline(outline, target.ref, scoped.parsedOutline!);
		outline.lookId = scoped.lookId;
		state.currentOutline = outline;
		state.currentLook = { ...scoped, image: state.currentLook?.image, outline: outline.root, parsedOutline: outline };
		persistOperation(state);
	}
	const folded = foldToBudget(outline, { maxDepth: depth, maxNodes: 150 }, [target.ref]);
	const details: OutlineToolDetails = { tool: "expand_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, target: serializeOutlineNodeShallow(target), renderedOutline: folded.text, note: state.currentNote };
	return { content: [{ type: "text", text: `${formatOutlineNodeLabel(target)}\npath: ${outlineNodePath(target)}\n\n${folded.text}` }], details };
}

/** Pure cached-outline inspection unless a window selector is supplied. */
async function performInspectUi(params: InspectUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	const outline = currentOutlineOrThrow(params.stateId);
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("inspect_ui.ref is required.");
	const target = nodeByRef(outline, ref);
	if (!target) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	const details: OutlineToolDetails = { tool: "inspect_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, target: serializeOutlineNodeShallow(target), note: state.currentNote };
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

function prepareUiAction(action: UiAction, state: ActionState, look: LookResponse, headless: boolean): PreparedAction {
	return prepareAction(action, state, {
		headless,
		image: look.image,
		node: outlineNodeByRef,
		center: outlineNodeCenter,
		validatePoint: (x, y, label) => ensurePointIsInLookImage(x, y, look, label),
	});
}

async function dispatchUiAction(action: UiAction, target: ResolvedTarget, look: LookResponse, headless: boolean, state: ActionState, signal?: AbortSignal): Promise<ExecutionTrace> {
	const prepared = prepareUiAction(action, state, look, headless);
	if (prepared.action === "wait") {
		await sleep(prepared.params.ms, signal);
		return executionTrace("wait", "stealth", { outcome: "worked" });
	}
	const trace = await helperAct(target, prepared, headless, signal);
	if (!headless && (prepared.establishesFocus || (prepared.action === "click" && "x" in prepared.target))) {
		state.currentFocus = true;
	}
	return trace;
}

async function dispatchUiTransaction(actions: UiAction[], target: ResolvedTarget, look: LookResponse, headless: boolean, signal?: AbortSignal): Promise<ExecutionTrace> {
	// Strict-headless batches have one immutable delivery class. When foreground
	// fallback is permitted, decide independently per action so a completed
	// background prefix is never replayed as part of a foreground batch.
	if (headless && currentPlatformBackend.actBatch) {
		const actionState: ActionState = { currentFocus: false };
		const requests = actions.map((action) => helperActRequest(target, prepareUiAction(action, actionState, look, true) as NativePreparedAction, "ax_only"));
		const textLength = actions.reduce((sum, action) => sum + (action.text?.length ?? 0), 0);
		const result = await currentPlatformBackend.actBatch(requests, { signal, timeoutMs: Math.max(COMMAND_TIMEOUT_MS, textLength * 25 + 6_000) });
		if (!result.steps || result.steps.length === 0) throw new Error("Native action transaction returned no checked steps.");
		const execution = aggregateExecutions(result.steps.map((step) => executionTraceFromAct(step, "ax_only")));
		const batchTrace = executionTraceFromAct(result, "ax_only");
		execution.outcome = result.outcome;
		execution.performed = result.performed;
		execution.rootDelta = batchTrace.rootDelta;
		execution.stoppedAt = result.stoppedAt;
		return execution;
	}
	const steps: ExecutionTrace[] = [];
	const actionState: ActionState = { currentFocus: false };
	for (const action of actions) {
		const step = await dispatchUiAction(action, target, look, headless, actionState, signal);
		steps.push(step);
		if (step.outcome === "didnt") break;
	}
	return aggregateExecutions(steps);
}

function aggregateExecutions(steps: ExecutionTrace[]): ExecutionTrace {
	const outcomes = steps.map((step) => step.outcome);
	const outcome: ActOutcome = outcomes.includes("didnt") ? "didnt" : outcomes.includes("unknown") ? "unknown" : "worked";
	const fallback = steps.find((step) => step.escalatedToForeground);
	return executionTrace("act", steps.every((step) => step.variant === "stealth") ? "stealth" : "default", {
		outcome,
		steps,
		actionCount: steps.length,
		rootDelta: steps.flatMap((step) => step.rootDelta ?? []),
		backgroundFirst: true,
		escalatedToForeground: Boolean(fallback),
		escalationReason: fallback?.escalationReason,
		backgroundAttempt: fallback?.backgroundAttempt,
	});
}

async function performDesktopTransaction(params: ActParams, actions: UiAction[], signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails>> {
	const state = operationState();
	state.currentImageMode = "auto";
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const baseView = { stateId: state.currentCapture!.stateId, outline: state.currentOutline! };
	const condition = params.expect ? validateCondition(params.expect) : undefined;
	const scopeNode = condition ? conditionScopeNode(look.parsedOutline!, condition) : undefined;
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
	const noteBefore = state.currentNote;
	return await withWindowWriteLock(target, async () => {
		const headless = getComputerUseConfig().headless;
		const execution = await dispatchUiTransaction(actions, target, look, headless, signal);
		const executedActions = actions.slice(0, execution.actionCount ?? actions.length);
		if (condition) {
			const { text: expectedText, role: expectedRole, value: expectedValue, scopeRef, scopeExact, gone, timeoutMs } = condition;
			const beforePresent = outlineConditionPresent(look.parsedOutline!, condition);
			const desiredWasPreexisting = beforePresent !== gone;
			const verification = await currentPlatformBackend.waitFor({
				...nativeWindowRequest(target),
				lookId: look.parsedOutline!.lookId,
				text: expectedText,
				role: platformRole(look.parsedOutline!, expectedRole),
				value: expectedValue,
				scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
				scopeExact,
				gone,
				timeoutMs,
			}, { signal, timeoutMs: timeoutMs + 2_000 });
			execution.verification = {
				status: verification.found ? (desiredWasPreexisting ? "preexisting" : "verified") : "failed",
				text: expectedText,
				role: expectedRole,
				value: expectedValue,
				gone: gone || undefined,
				timeoutMs,
			};
			execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", execution.verification.status);
			if (!verification.found) {
				execution.error = {
					code: "postcondition_failed",
					message: `The action was delivered but its postcondition was not satisfied within ${timeoutMs}ms.`,
				};
			}
		} else {
			await sleep(settleMsForExecution(execution), signal);
		}
		const capture = await captureCurrentTarget(signal, "auto", AUTO_IMAGE_MAX_DIMENSION, target);
		execution.outcome = outcomeAfterObservedValues(execution.outcome ?? "unknown", executedActions, (ref) => nodeByRef(capture.outline, ref)?.value);
		for (const action of executedActions) {
			state.currentNote = noteAfterAct(state.currentNote ?? noteBefore, action.ref, capture.outline, { window: noteWindowForTarget(capture.target, capture.look), rootDelta: execution.rootDelta });
		}
		return await buildToolResult("act_ui", `Executed ${executedActions.length} checked UI action${executedActions.length === 1 ? "" : "s"} in ${target.appName} — ${target.windowTitle}. Returned state ${capture.capture.stateId}.`, capture, execution, signal, state.currentImageMode, baseView);
	});
}

async function performBrowserTransaction(params: ActParams, actions: UiAction[], signal?: AbortSignal): Promise<AgentToolResult<BrowserObservationDetails>> {
	const contextId = browserContextForOperation();
	if (!contextId) throw new Error("Browser transaction requires a browser observation state.");
	const baseSnapshot = operationState().browserSnapshot;
	if (!baseSnapshot) throw new Error("Browser transaction requires a complete base observation.");
	const baseView = { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline };
	const condition = params.expect ? validateCondition(params.expect) : undefined;
	if (condition) conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
	const prepared = actions.map((action) => {
		if (!BROWSER_TRANSACTION_ACTIONS.has(action.action)) throw new Error(`Browser transactions do not support '${action.action}'.`);
		if (action.action === "click" && action.ref && action.button && action.button !== "left") throw new Error("Browser ref clicks support only the left button; use coordinate clicks for right or middle buttons.");
		const target = browserSnapshotTarget(params.stateId, trimOrUndefined(action.ref));
		if ((action.action === "press" || action.action === "setText" || (action.action === "click" && action.ref) || (action.action === "typeText" && action.ref)) && !Number.isFinite(target?.backendNodeId)) {
			throw new Error(`Browser ${action.action} requires an actionable @e ref owned by ${params.stateId}.`);
		}
		if (action.ref && (!target || target.contextId !== contextId)) throw new Error(`Browser ${action.action} ref must be owned by ${params.stateId}.`);
		return { action, target };
	});
	return await withBrowserWrite(contextId, async () => {
		for (const { action, target } of prepared) {
			let worked = false;
			if (action.action === "press" || (action.action === "click" && action.ref)) {
				worked = true;
				for (let count = 0; count < (action.clickCount ?? 1); count += 1) worked = await cdpClickForContext(contextId, target!.backendNodeId!) && worked;
			} else if (action.action === "click") {
				worked = await cdpMouseForContext(contextId, action.x!, action.y!, "mousePressed", action.button ?? "left", action.clickCount ?? 1)
					&& await cdpMouseForContext(contextId, action.x!, action.y!, "mouseReleased", action.button ?? "left", action.clickCount ?? 1);
			} else if (action.action === "setText") worked = await cdpTypeForContext(contextId, target!.backendNodeId!, action.text ?? "", true);
			else if (action.action === "typeText") worked = target?.backendNodeId
				? await cdpTypeForContext(contextId, target.backendNodeId, action.text ?? "", false)
				: await cdpTypeFocusedForContext(contextId, action.text ?? "");
			else if (action.action === "keypress") worked = await cdpKeypressForContext(contextId, action.keys ?? []);
			else if (action.action === "scroll") worked = await cdpScrollForContext(contextId, toFiniteNumber(action.scrollX, 0), toFiniteNumber(action.scrollY, 0), target?.backendNodeId);
			else if (action.action === "drag") worked = await cdpDragForContext(contextId, normalizeActionPath(action.path));
			else if (action.action === "moveMouse") worked = await cdpMouseForContext(contextId, action.x!, action.y!, "mouseMoved");
			if (!worked) throw new Error("The browser root became unavailable during the action transaction. Observe it again.");
		}
		if (condition) {
			const deadline = Date.now() + condition.timeoutMs;
			let satisfied = false;
			do {
				const snapshot = await cdpSnapshotForContext(contextId);
				if (!snapshot) throw new Error(`Browser root '${contextId}' is no longer available. Observe it again.`);
				const present = outlineConditionPresent(restoreOutline(snapshot.outline), condition);
				satisfied = present !== condition.gone;
				if (!satisfied) await sleep(100, signal);
			} while (!satisfied && Date.now() < deadline);
			if (!satisfied) throw new Error(`The browser action was delivered but its postcondition was not satisfied within ${condition.timeoutMs}ms.`);
		}
		return await refreshBrowserSnapshot(contextId, "act_ui", baseView);
	});
}

function normalizeActionPath(path: UiAction["path"]): Array<{ x: number; y: number }> {
	return (path ?? []).map((point) => Array.isArray(point) ? { x: toFiniteNumber(point[0], 0), y: toFiniteNumber(point[1], 0) } : { x: toFiniteNumber(point.x, 0), y: toFiniteNumber(point.y, 0) });
}

function validateActionTarget(action: UiAction): void {
	const hasRef = Boolean(trimOrUndefined(action.ref));
	const hasX = Number.isFinite(action.x);
	const hasY = Number.isFinite(action.y);
	if (hasX !== hasY) throw new Error(`${action.action} coordinates require both x and y.`);
	const hasPoint = hasX && hasY;
	if ((action.action === "click" || action.action === "moveMouse") && hasRef === hasPoint) {
		throw new Error(`${action.action} requires exactly one target: ref or x/y coordinates.`);
	}
	if (action.action === "press" && !hasRef) throw new Error("press requires an actionable ref.");
	if (action.action === "scroll" && toFiniteNumber(action.scrollX, 0) === 0 && toFiniteNumber(action.scrollY, 0) === 0) throw new Error("scroll requires a non-zero scrollX or scrollY delta.");
	if (action.clickCount !== undefined && (!Number.isInteger(action.clickCount) || action.clickCount < 1 || action.clickCount > 3)) throw new Error("clickCount must be an integer from 1 to 3.");
}

async function performAct(params: ActParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | BrowserObservationDetails>> {
	const actions = Array.isArray(params.actions) ? params.actions : [];
	if (actions.length === 0) throw new Error("act_ui.actions must contain at least one action.");
	if (actions.length > 20) throw new Error("act_ui supports at most 20 actions per transaction.");
	for (const action of actions) validateActionTarget(action);
	if (operationState().contextId) return await performBrowserTransaction(params, actions, signal);
	return await performDesktopTransaction(params, actions, signal);
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
async function performLaunchBrowser(params: LaunchBrowserParams, signal?: AbortSignal): Promise<AgentToolResult<BrowserObservationDetails>> {
	const browser = getComputerUseConfig().managed_browser;
	const executable = managedBrowserExecutable(browser);
	await access(executable, fsConstants.X_OK).catch(() => {
		throw new Error(`${browser} executable was not found at ${executable}.`);
	});
	const port = await freeTcpPort();
	const requestedUrl = trimOrUndefined(params.url);
	if (requestedUrl && !/^https?:\/\//i.test(requestedUrl)) throw new Error("launch_browser.url must be an absolute HTTP(S) URL.");
	const url = requestedUrl ?? "about:blank";
	const profileDir = path.join(os.tmpdir(), `pi-${browser}-cdp-${port}`);
	disconnectCdp();
	runtimeState.managedBrowser?.kill("SIGTERM");
	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		url,
	];
	if (runtimeState.previousCdpPort === undefined && runtimeState.managedBrowserCdpPort === undefined) {
		runtimeState.previousCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
	}
	const managedBrowser = spawn(executable, args, { stdio: "ignore", detached: false });
	managedBrowser.unref();
	runtimeState.managedBrowser = managedBrowser;
	runtimeState.managedBrowserCdpPort = String(port);
	process.env.PI_COMPUTER_USE_CDP_PORT = String(port);
	try {
		await waitForCdpPort(port, signal);
	} catch (error) {
		if (runtimeState.managedBrowser === managedBrowser) {
			runtimeState.managedBrowser = undefined;
			managedBrowser.kill("SIGTERM");
			if (runtimeState.previousCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
			else process.env.PI_COMPUTER_USE_CDP_PORT = runtimeState.previousCdpPort;
			runtimeState.managedBrowserCdpPort = undefined;
			runtimeState.previousCdpPort = undefined;
		}
		throw error;
	}
	const page = (await listCdpPageContexts())[0];
	if (!page) throw new Error("Managed browser launched without a CDP page context.");
	const resourceKey = `cdp:${page.targetId}`;
	const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(page.contextId));
	if (!scheduled.value) throw new Error("Managed browser page could not be observed after launch.");
	return browserObservationResult(scheduled.value, resourceKey, scheduled.epoch, "launch_browser");
}

async function performNavigateBrowser(params: NavigateBrowserParams): Promise<AgentToolResult<BrowserObservationDetails>> {
	const contextId = browserContextForOperation();
	const url = trimOrUndefined(params.url);
	if (!contextId) throw new Error("navigate_browser.stateId must belong to a CDP browser-page observation. Native browser windows use act_ui.");
	if (!url || !/^https?:\/\//i.test(url)) throw new Error("navigate_browser.url must be an absolute HTTP(S) URL.");
	const baseSnapshot = operationState().browserSnapshot;
	if (!baseSnapshot) throw new Error("Browser navigation requires a complete base observation.");
	return await withBrowserWrite(contextId, async () => {
		const ok = await cdpNavigateContext(contextId, url);
		if (!ok) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
		return await refreshBrowserSnapshot(contextId, "navigate_browser", { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline });
	});
}

async function performEvaluateBrowser(params: EvaluateBrowserParams): Promise<AgentToolResult<EvaluateBrowserDetails>> {
	const contextId = browserContextForOperation();
	const expression = typeof params.expression === "string" ? params.expression : "";
	if (!contextId) throw new Error("evaluate_browser.stateId must belong to a browser observation.");
	if (!expression.trim()) throw new Error("evaluate_browser.expression must be non-empty JavaScript.");
	const baseSnapshot = operationState().browserSnapshot;
	if (!baseSnapshot) throw new Error("Browser evaluation requires a complete base observation.");
	return await withBrowserWrite(contextId, async () => {
		const result = await cdpEvaluateForContext(contextId, expression);
		if (!result) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
		const successor = await refreshBrowserSnapshot(contextId, "evaluate_browser", { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline });
		const details: EvaluateBrowserDetails = {
			tool: "evaluate_browser",
			baseStateId: baseSnapshot.snapshotId,
			stateId: successor.details.stateId,
			view: successor.details.view,
			changes: successor.details.changes,
			outline: successor.details.outline,
			renderedOutline: successor.details.renderedOutline,
		};
		return { content: [...successor.content, { type: "text", text: `Evaluation value: ${JSON.stringify(result.value)}` }], details };
	});
}

async function executeTool<P, T>(ctx: ExtensionContext, params: P, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	const outputRef = trimOrUndefined((params as { ref?: string } | undefined)?.ref)?.startsWith("@o") === true;
	const requestedStateId = outputRef ? undefined : trimOrUndefined((params as { stateId?: string } | undefined)?.stateId);
	const stateRecord = requestedStateId ? savedStates.get(requestedStateId) : undefined;
	if (requestedStateId && !stateRecord) {
		throw new Error(`State '${requestedStateId}' is unavailable or was evicted. Observe the root again.`);
	}
	const operation = savedStates.hydrate(stateRecord);
	return await savedStates.operations.run(operation, async () => {
		await resourceScheduler.read("session-lifecycle", async () => await ensureReady(ctx, signal));
		throwIfAborted(signal);
		const result = await run();
		persistOperation(operation);
		return result;
	});
}

function makeToolExecutor<P, D>(tool: string, perform: (params: P, signal?: AbortSignal) => Promise<AgentToolResult<D>>) {
	return async (
		_toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback<D> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<D>> => {
		try {
			return applyOutputEnvelope(tool, await executeTool(ctx, params, signal, () => perform(params, signal)));
		} catch (error) {
			throw boundToolError(tool, error);
		}
	};
}

export const executeFind = makeToolExecutor("find_roots", performListWindows);
export const executeReadText = makeToolExecutor("read_text", performReadText);
export const executeWaitFor = makeToolExecutor("wait_for", performWaitFor);
export const executeObserve = makeToolExecutor("observe_ui", performObserve);
export const executeSearchUi = makeToolExecutor("search_ui", performSearchUi);
export const executeExpandUi = makeToolExecutor("expand_ui", performExpandUi);
export const executeInspectUi = makeToolExecutor("inspect_ui", performInspectUi);
export const executeAct = makeToolExecutor<ActParams, ComputerUseDetails | BrowserObservationDetails>("act_ui", performAct);
export const executeNavigateBrowser = makeToolExecutor("navigate_browser", performNavigateBrowser);
export const executeEvaluateBrowser = makeToolExecutor("evaluate_browser", performEvaluateBrowser);
export const executeLaunchBrowser = makeToolExecutor("launch_browser", performLaunchBrowser);

export function reconstructStateFromBranch(ctx: ExtensionContext): void {
	savedStates.clear();
	clearStoredOutputs();
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.nextRootRefIndex = 1;

	const restoredResources = new Set<string>();
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any).message;
		if (!message || message.role !== "toolResult") continue;
		if (!AGENT_TOOL_NAMES.has(message.toolName)) continue;

		const rawDetails = message.details as any;
		if (rawDetails?.tool === "find_roots" && Array.isArray(rawDetails.windows)) {
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

		const details = rawDetails as Partial<ComputerUseDetails> | undefined;
		if (!details?.target || !details?.capture) continue;

		const app = typeof details.target.app === "string" ? details.target.app : undefined;

		if (!app) continue;
		if (!Number.isFinite(details.target.pid) || !Number.isFinite(details.target.windowId)) continue;
		if (typeof details.capture.stateId !== "string") continue;

		const target: CurrentTarget = {
			appName: app,
			bundleId: details.target.bundleId,
			pid: Math.trunc(details.target.pid),
			windowTitle: details.target.windowTitle ?? "(untitled)",
			windowId: Math.trunc(details.target.windowId),
			windowRef: typeof details.target.windowRef === "string" ? details.target.windowRef : undefined,
			nativeWindowRef: typeof (details.target as any).nativeWindowRef === "string" ? (details.target as any).nativeWindowRef : undefined,
		};

		const resourceKey = desktopResourceKey(target);
		if (restoredResources.has(resourceKey)) continue;
		const capture: CurrentCapture = {
			stateId: details.capture.stateId,
			width: Math.max(1, Math.trunc(toFiniteNumber(details.capture.width, 1))),
			height: Math.max(1, Math.trunc(toFiniteNumber(details.capture.height, 1))),
			scaleFactor: Math.max(1, toFiniteNumber(details.capture.scaleFactor, 1)),
			timestamp: Number.isFinite(details.capture.timestamp) ? details.capture.timestamp : Date.now(),
		};
		if (details.outline?.root && typeof details.outline.lookId === "string") {
			const epoch = 0;
			resourceScheduler.restoreEpoch(resourceKey, epoch);
			savedStates.set({
				stateId: capture.stateId,
				resourceKey,
				epoch,
				value: {
					kind: "desktop",
					target,
					capture,
					outline: details.outline,
					look: {
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
				timings: {},
					},
					note: details.note,
				},
			});
			restoredResources.add(resourceKey);
		}
	}
}
