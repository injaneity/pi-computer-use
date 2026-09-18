// Jev layer contracts: one indexed action space, a code-owned execution id,
// and a decision that never carries selectors, coordinates, or executable code.

export type JevOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";

export type JevActionKind = "click" | "fill" | "select" | "scroll" | "wait";

export interface JevRawAction {
	id: string;
	kind: JevActionKind;
	label: string;
	node?: number;
	role?: string;
	value?: string;
	current_value?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	delta?: number;
}

export interface JevRawPage {
	url: string;
	title: string;
	w: number;
	h: number;
	text: string;
	scroll: { y: number; height: number };
	actions: JevRawAction[];
	marker: unknown;
	page_key: unknown;
	guards: Record<string, unknown>;
	omitted_actions: number;
}

export interface JevElementOption {
	index: string;
	label: string;
	value: string;
}

export interface JevElement {
	index: string;
	label: string;
	role: string;
	value: string;
	operations: string[];
	checked?: string;
	selected?: string;
	expanded?: string;
	options?: JevElementOption[];
}

export interface JevSpace {
	elements: JevElement[];
	/** operation -> target index -> the code-owned action that executes it. */
	targets: Record<string, Record<string, JevRawAction>>;
	/** document operations such as WAIT, keyed by their operation name. */
	controls: Record<string, JevRawAction>;
}

export interface JevDecision {
	operation: JevOperation;
	/** Target index inside the selected operation head, or null for document operations. */
	target: string | null;
	/** The code-owned action id the executor must run. */
	actionId: string;
	confidence: number;
	probabilities: Record<string, number>;
	operationProbabilities: Record<string, number>;
	targetProbabilities: Record<string, number>;
	targetConfidence: number | null;
	model?: string;
	usage?: unknown;
	latencyMs: number;
	request?: unknown;
}

export interface JevTextValue {
	text: string;
	model: string;
	latencyMs: number;
	usage?: unknown;
}

export interface JevFreshness {
	pageKey: unknown;
	marker: unknown;
	guards: Record<string, unknown>;
}

/** The immutable page observation stored behind one agent-facing jev stateId. */
export interface JevPageSnapshot {
	contextId: string;
	targetId: string;
	title: string;
	url: string;
	capturedAt: number;
	text: string;
	scroll: { y: number; height: number };
	actions: JevRawAction[];
	elements: JevElement[];
	space: JevSpace;
	freshness: JevFreshness;
	omittedActions: number;
}

export interface JevExecutionRecord {
	step: number;
	actionId: string;
	action: string;
	kind: JevActionKind;
	operation: JevOperation;
	target: string | null;
	probability: number | null;
	confidence: number | null;
	decisionLatencyMs: number | null;
	text: string | null;
	textModel: string | null;
	textLatencyMs: number;
	pageChanged: boolean | null;
	url: string;
	usage?: unknown;
}

export interface JevProgressEntry extends JevExecutionRecord {
	step: number;
}

export interface JevRunOutcome {
	status: "done" | "blocked" | "step_budget" | "error";
	steps: number;
	decisions: number;
	elapsedMs: number;
	history: JevExecutionRecord[];
	/** A DONE choice is never proof of success; the caller verifies the outcome. */
	verification: "unverified";
	message?: string;
}

/** How jev decision-making reaches a model. */
export type JevDecisionBackend = "auto" | "typesafe" | "vercel";

/**
 * A resolved decision backend. `missingModule` records an optional AI SDK
 * package that is not installed, so availability stays honest while the error
 * message stays actionable.
 */
export type JevDecisionProvider =
	| { backend: "typesafe"; url: string; key: string; model: string }
	| { backend: "vercel-gateway"; model: string; apiKey?: string; zeroDataRetention: boolean; missingModule?: string }
	| { backend: "vercel-typesafe"; model: string; apiKey: string; missingModule?: string };

