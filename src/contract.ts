export type RootSelector = string;
export type ImageMode = "auto" | "always" | "never";
export type MouseButtonName = "left" | "right" | "middle";

export interface ObserveTargetParams {
	root?: RootSelector;
}

export interface FindParams {
	text?: string;
	app?: string;
	bundleId?: string;
	pid?: number;
	/** Filters on the platform's best-effort presentation hint; only window vs transient is guaranteed. */
	kind?: "window" | "menu" | "sheet" | "popover" | "dialog" | "browser_page";
}

export interface StateTargetParams {
	stateId?: string;
}

export interface NavigateBrowserParams extends StateTargetParams {
	url: string;
}

export interface LaunchBrowserParams {
	url?: string;
}

export interface EvaluateBrowserParams {
	stateId: string;
	expression: string;
}

export interface ObserveParams extends ObserveTargetParams {
	mode?: "semantic" | "visual" | "fused";
	/** Internal capture override; not part of the model-facing schema. */
	readText?: "auto" | "always" | "never";
}

export interface SearchUiParams extends StateTargetParams {
	text?: string;
	role?: string;
	capability?: string;
}

export interface ExpandUiParams extends StateTargetParams {
	ref: string;
	depth?: number;
}

export interface InspectUiParams extends StateTargetParams {
	ref: string;
}

export interface UiCondition {
	ref?: string;
	scopeRef?: string;
	text?: string;
	role?: string;
	value?: string;
	until?: "present" | "absent";
	timeoutMs?: number;
}

export interface UiAction {
	action: "press" | "click" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse";
	ref?: string;
	x?: number;
	y?: number;
	text?: string;
	keys?: string[];
	scrollX?: number;
	scrollY?: number;
	path?: Array<{ x: number; y: number } | [number, number]>;
	button?: MouseButtonName;
	clickCount?: number;
}

export interface JevObserveParams {
	root?: RootSelector;
}

export interface JevStepParams extends StateTargetParams {
	/** Code-owned action id from jev_observe, e.g. "e3". Omit to use the configured policy. */
	action?: string;
	/** Required by the policy when action is omitted, and used by the text helper. */
	goal?: string;
	/** Explicit TYPE_TEXT value; omitted values use the configured text helper. */
	text?: string;
}

export interface JevRunParams extends StateTargetParams {
	root?: RootSelector;
	goal: string;
	maxSteps?: number;
}

export interface ActParams extends StateTargetParams {
	actions: UiAction[];
	expect?: UiCondition;
}

export interface ReadTextParams extends StateTargetParams {
	ref: string;
	offset?: number;
}

export interface WaitForParams extends StateTargetParams, UiCondition {}

export const AGENT_TOOL_NAMES = new Set([
	"find_roots",
	"read_text",
	"wait_for",
	"observe_ui",
	"search_ui",
	"expand_ui",
	"inspect_ui",
	"act_ui",
	"navigate_browser",
	"evaluate_browser",
	"launch_browser",
	"jev_observe",
	"jev_step",
	"jev_run",
]);
