import { createHash } from "node:crypto";
import type { JevElement, JevOperation, JevRawAction, JevRawPage, JevSpace } from "./types.ts";

const OPERATION_BY_KIND: Record<string, string> = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" };

/**
 * One index per observed node, with operation-specific target heads.
 * Ported from jev-ultrafast/model.py so a policy request can choose an
 * operation and a target for that operation in a single call.
 */
export function buildJevSpace(actions: JevRawAction[]): JevSpace {
	const elements: JevElement[] = [];
	const indices = new Map<number, string>();
	const targets: JevSpace["targets"] = {};
	const controls: JevSpace["controls"] = {};
	for (const action of actions) {
		const kind = action.kind;
		const operation = OPERATION_BY_KIND[kind];
		if (!operation) {
			controls[action.id.toUpperCase()] = action;
			continue;
		}
		const node = action.node;
		if (typeof node !== "number") continue;
		let index = indices.get(node);
		if (!index) {
			index = String(elements.length + 1);
			indices.set(node, index);
			const element: JevElement = {
				index,
				label: action.label.split(" → ")[0],
				role: action.role ?? "",
				value: action.value ?? "",
				operations: [],
			};
			for (const key of ["checked", "selected", "expanded"] as const) {
				const value = action[key];
				if (value !== undefined) element[key] = value;
			}
			if (kind === "select") {
				element.value = action.current_value ?? "";
				element.options = [];
			}
			elements.push(element);
		}
		const element = elements[Number(index) - 1]!;
		if (!element.operations.includes(operation)) element.operations.push(operation);
		const group = (targets[operation] ??= {});
		if (kind === "select") {
			const options = (element.options ??= []);
			const target = `${index}:${options.length + 1}`;
			options.push({ index: target, label: action.label, value: action.value ?? "" });
			group[target] = action;
		} else {
			group[index] = action;
		}
	}
	return { elements, targets, controls };
}

/** Parse one in-page snapshot payload without trusting its shape. */
export function parseJevPage(context: { contextId: string; targetId: string }, raw: unknown): {
	page: JevRawPage;
	elements: JevElement[];
	space: JevSpace;
} {
	if (!raw || typeof raw !== "object") throw new Error("The browser page returned no jev snapshot.");
	const record = raw as Record<string, unknown>;
	const actions: JevRawAction[] = Array.isArray(record.actions)
		? record.actions.map((entry) => parseJevAction(entry)).filter((entry): entry is JevRawAction => Boolean(entry))
		: [];
	if (actions.length === 0) throw new Error("The browser page exposed no executable jev actions. Observe the page again or navigate to a rendered document.");
	const scroll = record.scroll && typeof record.scroll === "object" ? record.scroll as Record<string, unknown> : {};
	const page: JevRawPage = {
		url: typeof record.url === "string" ? record.url : "",
		title: typeof record.title === "string" ? record.title : "",
		w: finite(record.w, 0),
		h: finite(record.h, 0),
		text: typeof record.text === "string" ? record.text : "",
		scroll: { y: finite(scroll.y, 0), height: finite(scroll.height, 0) },
		actions,
		marker: record.marker ?? null,
		page_key: record.page_key ?? null,
		guards: record.guards && typeof record.guards === "object" ? record.guards as Record<string, unknown> : {},
		omitted_actions: finite(record.omitted_actions, 0),
	};
	const space = buildJevSpace(actions);
	return { page, elements: space.elements, space };
}

function finite(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseJevAction(entry: unknown): JevRawAction | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	const kind = record.kind;
	if (!id || kind !== "click" && kind !== "fill" && kind !== "select" && kind !== "scroll" && kind !== "wait") return undefined;
	const action: JevRawAction = {
		id,
		kind,
		label: typeof record.label === "string" ? record.label : id,
	};
	if (typeof record.node === "number" && Number.isInteger(record.node)) action.node = record.node;
	if (typeof record.role === "string") action.role = record.role;
	if (typeof record.value === "string") action.value = record.value;
	if (typeof record.current_value === "string") action.current_value = record.current_value;
	for (const key of ["checked", "selected", "expanded"] as const) {
		if (typeof record[key] === "string") action[key] = record[key] as string;
	}
	if (typeof record.delta === "number") action.delta = record.delta;
	return action;
}

export function actionById(page: JevRawPage, actionId: string): JevRawAction | undefined {
	return page.actions.find((action) => action.id === actionId);
}

/** What a policy decision resolves to: a terminal stop, one action, or a protocol error. */
export type JevDecisionTarget =
	| { kind: "terminal"; status: "done" | "blocked" }
	| { kind: "action"; action: JevRawAction }
	| { kind: "unknown"; actionId: string };

/**
 * Map a policy decision to a code-owned action. DONE and BLOCKED are terminal
 * decisions, not actions, so they must never be looked up in the action table.
 */
export function resolveDecisionTarget(page: JevRawPage, decision: { operation: JevOperation; actionId: string }): JevDecisionTarget {
	if (decision.operation === "DONE") return { kind: "terminal", status: "done" };
	if (decision.operation === "BLOCKED") return { kind: "terminal", status: "blocked" };
	const action = actionById(page, decision.actionId);
	return action ? { kind: "action", action } : { kind: "unknown", actionId: decision.actionId };
}

/** A semantic fingerprint over current values and identity, never screenshots. */
export function jevFingerprint(page: JevRawPage): string {
	const content = {
		url: page.url,
		text: page.text,
		scroll: page.scroll,
		actions: page.actions.map(({ label, kind, value, current_value, checked, selected, expanded, node }) => ({ label, kind, value, current_value, checked, selected, expanded, node })),
	};
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function formatOperationAnnotations(space: JevSpace, element: JevElement): string {
	const parts: string[] = [];
	for (const operation of element.operations) {
		if (operation === "SELECT") {
			const options = element.options ?? [];
			const rendered = options.map((option) => `${option.index} ${JSON.stringify(option.label)}`).join(", ");
			parts.push(`SELECT(${rendered})`);
			continue;
		}
		const target = space.targets[operation]?.[element.index];
		parts.push(`${operation}(${target?.id ?? "?"})`);
	}
	return parts.join(", ");
}

/** The compact numbered element table shown to the agent. */
export function formatJevElements(space: JevSpace, limit = 60): { text: string; shown: number; omitted: number } {
	const lines: string[] = [];
	const elements = space.elements.slice(0, limit);
	for (const element of elements) {
		const value = element.value ? ` · ${JSON.stringify(element.value)}` : "";
		const stateFields = ["checked", "selected", "expanded"]
			.map((key) => (element as unknown as Record<string, string | undefined>)[key] !== undefined ? `${key}=${(element as unknown as Record<string, string | undefined>)[key]}` : undefined)
			.filter(Boolean)
			.join(" ");
		lines.push(`[${element.index}] ${element.role || "element"} ${JSON.stringify(element.label)}${value}${stateFields ? ` ${stateFields}` : ""} {${formatOperationAnnotations(space, element)}}`);
	}
	return { text: lines.join("\n"), shown: elements.length, omitted: Math.max(0, space.elements.length - elements.length) };
}

export function formatJevControls(space: JevSpace): string {
	const names = Object.keys(space.controls);
	return names.length ? names.join(", ") : "none";
}
