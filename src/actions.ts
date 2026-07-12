import type { MouseButtonName, UiAction } from "./contract.ts";
import type { OutlineNode } from "./outline.ts";
import { toFiniteNumber } from "./platform/coerce.ts";

export type ActionTarget = { ref: string } | { x: number; y: number } | { focus: { x: number; y: number } };

export type PreparedAction =
	| { action: "press" | "click"; target: ActionTarget; params: { button?: MouseButtonName; clickCount?: number }; establishesFocus: boolean; usesCurrentFocus: false; needsForeground: boolean }
	| { action: "setText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "typeText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "keypress"; target: ActionTarget; params: { keys: string[] }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "scroll"; target: ActionTarget; params: { scrollX: number; scrollY: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "drag"; target: ActionTarget; params: { path: Array<{ x: number; y: number }> }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "moveMouse"; target: ActionTarget; params: Record<string, never>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "wait"; params: { ms: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false };

export interface ActionState {
	currentFocus: boolean;
}

export interface ActionEnvironment {
	headless: boolean;
	image?: { width: number; height: number };
	node(ref: string): OutlineNode;
	center(node: OutlineNode): { x: number; y: number };
	validatePoint(x: number, y: number, label?: string): void;
}

function mouseButton(value: unknown): MouseButtonName {
	return value === "right" || value === "middle" ? value : "left";
}

function clickCount(value: unknown, fallback = 1): number {
	return Math.max(1, Math.min(3, Math.round(toFiniteNumber(value, fallback))));
}

function scrollDelta(value: unknown): number {
	return Math.max(-10_000, Math.min(10_000, Math.round(toFiniteNumber(value, 0))));
}

function keys(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("keypress.keys must contain at least one key.");
	return value.map((key) => String(key));
}

function path(value: UiAction["path"], env: ActionEnvironment): Array<{ x: number; y: number }> {
	if (!Array.isArray(value) || value.length < 2) throw new Error("drag.path must contain at least two points.");
	return value.map((point, index) => {
		const x = Array.isArray(point) ? toFiniteNumber(point[0], NaN) : toFiniteNumber(point?.x, NaN);
		const y = Array.isArray(point) ? toFiniteNumber(point[1], NaN) : toFiniteNumber(point?.y, NaN);
		env.validatePoint(x, y, `Drag point ${index + 1}`);
		return { x, y };
	});
}

function nativeTarget(action: UiAction, operation: PreparedAction["action"], env: ActionEnvironment): ActionTarget {
	if (action.ref?.trim()) {
		const node = env.node(action.ref.trim());
		const semanticClick = operation === "click" || operation === "press";
		if (semanticClick && node.isTextInput) {
			const point = env.center(node);
			env.validatePoint(point.x, point.y);
			return point;
		}
		const onlyIncidentalActions = node.actions.every((candidate) => candidate === "AXShowMenu" || candidate === "AXScrollToVisible");
		if (node.wireRef && !node.pictureOnly && (!semanticClick || node.canPress || node.canFocus || node.canSetValue || !onlyIncidentalActions)) {
			return { ref: node.wireRef };
		}
		const point = env.center(node);
		env.validatePoint(point.x, point.y);
		return point;
	}
	const x = toFiniteNumber(action.x, NaN);
	const y = toFiniteNumber(action.y, NaN);
	if (Number.isFinite(x) && Number.isFinite(y)) {
		env.validatePoint(x, y);
		return { x, y };
	}
	if (operation === "drag" && action.path?.length) return path(action.path, env)[0];
	throw new Error(`${operation} requires either ref or both x and y.`);
}

function focusedTarget(env: ActionEnvironment): ActionTarget {
	if (!env.image) throw new Error("Focused keyboard input requires an image-bearing state.");
	return { focus: { x: Math.floor(env.image.width / 2), y: Math.floor(env.image.height / 2) } };
}

function containsEditable(node: OutlineNode): boolean {
	if (node.canSetValue || node.role.toLowerCase().includes("text")) return true;
	return node.children.some(containsEditable);
}

export function prepareAction(action: UiAction, state: ActionState, env: ActionEnvironment): PreparedAction {
	if (action.action === "wait") {
		return { action: "wait", params: { ms: Math.max(0, Math.min(60_000, Math.round(toFiniteNumber(action.ms, 1_000)))) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
	}
	const operation = action.action === "doubleClick" ? "click" : action.action;
	const usesCurrentFocus = !env.headless && state.currentFocus && !action.ref && (operation === "typeText" || operation === "keypress");
	const target = usesCurrentFocus ? focusedTarget(env) : nativeTarget(action, operation, env);
	const establishesFocus = !env.headless && Boolean(action.ref) && (operation === "click" || operation === "press") && containsEditable(env.node(action.ref!));
	const needsForeground = !env.headless && (operation === "click" || operation === "press") && "x" in target;

	switch (operation) {
		case "press":
		case "click": return { action: operation, target, params: { button: mouseButton(action.button), clickCount: action.action === "doubleClick" ? 2 : clickCount(action.clickCount) }, establishesFocus, usesCurrentFocus: false, needsForeground };
		case "setText": return { action: operation, target, params: { text: action.text ?? "" }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "typeText": return { action: operation, target, params: { text: action.text ?? "" }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "keypress": return { action: operation, target, params: { keys: keys(action.keys) }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "scroll": return { action: operation, target, params: { scrollX: scrollDelta(action.scrollX), scrollY: scrollDelta(action.scrollY) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "drag": return { action: operation, target, params: { path: path(action.path, env) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "moveMouse": return { action: operation, target, params: {}, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
	}
}

export function canRetryInForeground(action: PreparedAction, outcome: "worked" | "didnt" | "unknown", headless: boolean): boolean {
	return !headless && outcome === "didnt" && (action.action === "typeText" || action.action === "keypress");
}

export function outcomeAfterCheck(current: "worked" | "didnt" | "unknown", check: "verified" | "preexisting" | "failed"): "worked" | "didnt" | "unknown" {
	if (check === "verified") return "worked";
	if (check === "failed") return "didnt";
	return current;
}

export function outcomeAfterObservedValues(
	current: "worked" | "didnt" | "unknown",
	actions: UiAction[],
	valueForRef: (ref: string) => string | undefined,
): "worked" | "didnt" | "unknown" {
	const meaningful = actions.filter((action) => action.action !== "wait");
	if (meaningful.length === 0 || meaningful.some((action) => action.action !== "setText" || !action.ref)) return current;
	const matches = meaningful.every((action) => valueForRef(action.ref!) === (action.text ?? ""));
	return matches ? "worked" : current;
}
