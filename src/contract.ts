export type RootSelector = string | number;
export type WindowSelector = RootSelector;
export type ImageMode = "auto" | "always" | "never";
export type MouseButtonName = "left" | "right" | "middle";

export interface ObserveTargetParams {
	app?: string;
	windowTitle?: string;
	root?: RootSelector;
	window?: RootSelector;
	image?: ImageMode;
}

export interface FindParams {
	query?: string;
	app?: string;
	bundleId?: string;
	pid?: number;
	/** Filters on the platform's best-effort presentation hint; only window vs transient is guaranteed. */
	kind?: "window" | "menu" | "sheet" | "popover" | "dialog";
}

export interface WindowTargetParams {
	contextId?: string;
	root?: RootSelector;
	window?: RootSelector;
	stateId?: string;
	image?: ImageMode;
	responseMode?: "state" | "confirmation";
}

export interface TypeTextParams extends WindowTargetParams {
	text: string;
}

export interface SetTextParams extends WindowTargetParams {
	text: string;
	ref?: string;
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

export interface ObserveParams extends ObserveTargetParams {
	mode?: "semantic" | "visual" | "fused";
}

export interface SearchUiParams extends WindowTargetParams {
	text?: string;
	role?: string;
	action?: string;
	source?: string;
	limit?: number;
}

export interface ExpandUiParams extends WindowTargetParams {
	ref: string;
	depth?: number;
}

export interface InspectUiParams extends WindowTargetParams {
	ref: string;
	includeRaw?: boolean;
}

export interface ActParams extends WindowTargetParams {
	action: "press" | "click" | "doubleClick" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse" | "wait";
	ref?: string;
	x?: number;
	y?: number;
	text?: string;
	keys?: string[];
	scrollX?: number;
	scrollY?: number;
	path?: DragParams["path"];
	button?: MouseButtonName;
	clickCount?: number;
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

// Includes legacy names ("find", "observe", "act", "snapshot") so branch
// reconstruction still recognizes tool results from pre-rename sessions.
export const AGENT_TOOL_NAMES = new Set([
	"find_roots",
	"find",
	"list_contexts",
	"snapshot",
	"read_text",
	"wait_for",
	"observe_ui",
	"observe",
	"search_ui",
	"expand_ui",
	"inspect_ui",
	"act_ui",
	"act",
	"navigate_browser",
	"evaluate_browser",
	"launch_browser_context",
]);
