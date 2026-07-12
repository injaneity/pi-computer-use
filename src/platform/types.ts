import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LookResponse } from "../outline.ts";
import type { PermissionStatus } from "../permissions.ts";

export type PlatformName = "macos" | "windows" | "linux";
export type NativeInputDelivery = "hid" | "pid";
export type ActOutcome = "worked" | "didnt" | "unknown";
/**
 * Best-effort presentation hint for a root. The seam guarantees only the
 * `window` vs transient distinction; specific transient kinds are display hints
 * and must never drive behavior in shared code. Platforms that need precise
 * distinctions internally should use native signals.
 */
export type PlatformRootKind = "window" | "menu" | "sheet" | "popover" | "dialog";

export interface PlatformDiagnostics {
	protocolVersion: number;
	architectureVersion?: number;
	invariants?: string[];
	pid: number;
	parentPid?: number;
	parentAppName?: string;
	parentBundleId?: string;
	parentPath?: string;
	executablePath?: string;
	os?: string;
	arch?: string;
	accessibility?: boolean;
	screenRecording?: boolean;
}

export interface PlatformReadyState {
	permissionStatus?: PermissionStatus;
	lastPermissionCheckAt: number;
	helperDiagnostics?: PlatformDiagnostics;
}

export interface PlatformRootQuery {
	pid?: number;
	title?: string;
}

export interface PlatformApp {
	appName: string;
	bundleId?: string;
	pid: number;
	isFrontmost?: boolean;
}

export interface FramePoints {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PlatformRoot {
	kind: PlatformRootKind;
	rootRef?: string;
	windowRef?: string;
	windowId?: number;
	pid?: number;
	appName?: string;
	bundleId?: string;
	title: string;
	role?: string;
	subrole?: string;
	zOrder: number;
	framePoints: FramePoints;
	scaleFactor: number;
	isOnscreen: boolean;
	isFocused: boolean;
	isMinimized: boolean;
	/** Best-effort; platforms without a main-window concept may mirror `isFocused`. */
	isMain: boolean;
	/** Platform-reported modality fact, including platform-specific modal/dialog/sheet signals. */
	isModal: boolean;
	metadata?: Record<string, unknown>;
}

export interface PlatformFrontmostResult {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle?: string;
	windowId?: number;
	rootRef?: string;
}

export interface PlatformFocusWindowResult {
	focused: boolean;
	alreadyFocused?: boolean;
	reason?: string;
}

export interface HelperActPerformed {
	grounding?: "description" | "coordinates" | "keyboard-events";
	/** `ax` means the platform accessibility API (AX on macOS, UIA on Windows). */
	delivery?: "ax" | NativeInputDelivery;
	refound?: boolean;
	/** Free-form diagnostic naming the platform's delta mechanism. */
	deltaSource?: string;
	selectionGrounding?: "ax" | "keyboard";
	transaction?: boolean;
	actionCount?: number;
	activated?: boolean;
	raised?: boolean;
	focused?: boolean;
}

export interface PlatformRootDelta {
	change: "appeared" | "closed" | "focused";
	kind: string;
	ref?: string;
	title?: string;
	pid: number;
	isModal?: boolean;
	metadata?: Record<string, unknown>;
}

export interface HelperActResult {
	outcome: ActOutcome;
	performed?: HelperActPerformed;
	evidence?: Record<string, unknown>;
	error?: { code?: string; message?: string; whatIsThere?: unknown };
	rootDelta?: PlatformRootDelta[];
	steps?: HelperActResult[];
	stoppedAt?: number;
}

export interface PlatformTarget {
	pid?: number;
	windowId?: number;
	rootRef?: string;
}

export interface PlatformObserveRequest {
	target: PlatformTarget;
	/** Existing immutable look whose untouched refs/coordinate geometry survive a scoped refresh. */
	baseLookId?: string;
	readText: "auto" | "always" | "never";
	scopeRef?: string;
	maxDimension?: number;
	includeImage?: boolean;
}

type PlatformActAction = "press" | "click" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse";
export type PlatformActTarget = { ref: string } | { x: number; y: number } | { focus: PlatformPoint };
type PlatformDeliveryPolicy = "ax_only" | "background" | "default" | "foreground";
type PlatformMouseButton = "left" | "right" | "middle";
type PlatformActDeliveryParam = { delivery?: NativeInputDelivery };
export type PlatformPoint = { x: number; y: number };

export interface PlatformActRequestBase {
	lookId: string;
	pid?: number;
	target: PlatformActTarget;
	policy: PlatformDeliveryPolicy;
}

export type PlatformActRequest = PlatformActRequestBase & (
	| { action: "press" | "click"; params: { button?: PlatformMouseButton; clickCount?: number } & PlatformActDeliveryParam }
	| { action: "setText"; params: { text: string } & PlatformActDeliveryParam }
	| { action: "typeText"; params: { text: string } & PlatformActDeliveryParam }
	| { action: "keypress"; params: { keys: string[] } & PlatformActDeliveryParam }
	| { action: "scroll"; params: { scrollX: number; scrollY: number } & PlatformActDeliveryParam }
	| { action: "drag"; params: { path: PlatformPoint[] } & PlatformActDeliveryParam }
	| { action: "moveMouse"; params: PlatformActDeliveryParam }
);

export interface PlatformReadTextRequest {
	/** Observation that owns the element ref. Native backends must not resolve across observations. */
	lookId: string;
	elementRef: string;
	offset: number;
	limit: number;
}

export interface PlatformReadTextResponse {
	text: string;
	offset: number;
	limit: number;
	totalChars: number;
	hasMore: boolean;
}

export interface PlatformWaitForRequest extends PlatformTarget {
	text?: string;
	role?: string;
	value?: string;
	gone: boolean;
	timeoutMs: number;
}

export interface PlatformWaitForResponse {
	found: boolean;
	gone?: boolean;
	timedOut?: boolean;
	nodeCount?: number;
}

export interface ComputerUsePlatformBackend {
	name: PlatformName;
	/** Release process-local resources when the Pi session is torn down. */
	shutdown?(): void | Promise<void>;
	ensureReady(ctx: ExtensionContext, state: PlatformReadyState, signal?: AbortSignal): Promise<PlatformReadyState>;
	listApps(signal?: AbortSignal): Promise<PlatformApp[]>;
	listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRoot[]>;
	getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult>;
	focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult>;
	observe(request: PlatformObserveRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LookResponse>;
	act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult>;
	/** Execute one-resource actions with one root baseline and one final settle. */
	actBatch?(requests: PlatformActRequest[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult>;
	readText(args: PlatformReadTextRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformReadTextResponse>;
	waitFor(args: PlatformWaitForRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformWaitForResponse>;
	isBrowserApp(appName: string, bundleId?: string): boolean;
	isChromeFamilyApp(appName: string, bundleId?: string): boolean;
	openBrowserLocation(target: { appName: string; bundleId?: string }, url: string, signal?: AbortSignal): Promise<boolean>;
}
