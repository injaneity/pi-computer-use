import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LookResponse } from "../outline.ts";
import type { PermissionStatus } from "../permissions.ts";

export type PlatformName = "macos" | "windows" | "linux";
export type NativeInputDelivery = "hid" | "pid";
export type ActOutcome = "worked" | "didnt" | "unknown";

export interface PlatformDiagnostics {
	protocolVersion: number;
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

export interface PlatformWindowQuery {
	pid: number;
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

export interface PlatformWindow {
	windowId?: number;
	windowRef?: string;
	title: string;
	role?: string;
	subrole?: string;
	pairing: { confidence: "exact" | "high" | "low"; score: number };
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
	isModal: boolean;
	sheetCount: number;
}

export interface PlatformFrontmostResult {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle?: string;
	windowId?: number;
}

export interface PlatformFocusWindowResult {
	focused: boolean;
	alreadyFocused?: boolean;
	reason?: string;
}

export interface HelperActPerformed {
	grounding?: "description" | "coordinates";
	delivery?: "ax" | NativeInputDelivery;
	refound?: boolean;
}

export interface HelperActResult {
	outcome: ActOutcome;
	performed?: HelperActPerformed;
	evidence?: Record<string, unknown>;
	error?: { code?: string; message?: string; whatIsThere?: unknown };
}

export interface PlatformTarget {
	pid?: number;
	windowId?: number;
	windowRef?: string;
}

export interface PlatformObserveTarget {
	pid: number;
	windowId: number;
	windowRef?: string;
}

export interface PlatformObserveRequest {
	target: PlatformObserveTarget;
	readText: "auto" | "always" | "never";
	scopeRef?: string;
	maxDimension?: number;
}

export type PlatformActAction = "press" | "click" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse";
export type PlatformActTarget = { ref: string } | { x: number; y: number };
export type PlatformDeliveryPolicy = "ax_only" | "background" | "default";
export type PlatformSetTextMethod = "ax" | "keyboard";

export type PlatformActParams =
	| { button?: "left" | "right" | "middle"; clickCount?: number }
	| { text: string; method?: PlatformSetTextMethod }
	| { text: string }
	| { keys: string[] }
	| { scrollX: number; scrollY: number }
	| { path: Array<{ x: number; y: number }> }
	| Record<string, never>;

export interface PlatformActRequest {
	lookId: string;
	pid?: number;
	target: PlatformActTarget;
	action: PlatformActAction;
	policy: PlatformDeliveryPolicy;
	params: PlatformActParams & { delivery?: NativeInputDelivery };
}

export interface PlatformReadTextRequest {
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
	ensureReady(ctx: ExtensionContext, state: PlatformReadyState, signal?: AbortSignal): Promise<PlatformReadyState>;
	listApps(signal?: AbortSignal): Promise<PlatformApp[]>;
	listWindows(query: PlatformWindowQuery, signal?: AbortSignal): Promise<PlatformWindow[]>;
	getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult>;
	focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult>;
	observe(request: PlatformObserveRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LookResponse>;
	act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult>;
	readText(args: PlatformReadTextRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformReadTextResponse>;
	waitFor(args: PlatformWaitForRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformWaitForResponse>;
	isBrowserApp(appName: string, bundleId?: string): boolean;
	isChromeFamilyApp(appName: string, bundleId?: string): boolean;
	openBrowserLocation(target: { appName: string; bundleId?: string }, url: string, signal?: AbortSignal): Promise<boolean>;
}
