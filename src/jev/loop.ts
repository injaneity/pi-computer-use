import { JevStalePage } from "./driver.ts";
import { actionById, jevFingerprint } from "./space.ts";
import type { JevDecision, JevExecutionRecord, JevRawAction, JevRawPage, JevRunOutcome, JevSpace, JevTextValue } from "./types.ts";

/**
 * The loop's only dependencies. Everything that touches the browser or a model
 * lives in the host, so the control flow stays testable without paid APIs.
 */
export interface JevLoopHost {
	observe(): Promise<{ page: JevRawPage; space: JevSpace }>;
	/** Full semantic freshness for completion choices. */
	fresh(page: JevRawPage): Promise<boolean>;
	decide(page: JevRawPage, space: JevSpace, history: JevExecutionRecord[]): Promise<JevDecision>;
	/** The exact helper input for a fill target; equality gates value reuse. */
	textContext(page: JevRawPage, action: JevRawAction, history: JevExecutionRecord[]): unknown;
	text(context: unknown): Promise<JevTextValue>;
	/** Performs one mutation. Must reject before input when the page is stale. */
	execute(page: JevRawPage, action: JevRawAction, text: string | null): Promise<void>;
	/** Read-only settle after a mutation, logged after execution. */
	settle(action: JevRawAction): Promise<void>;
	progress?(record: JevExecutionRecord): void;
}

export interface JevLoopOptions {
	maxSteps?: number;
	maxDecisions?: number;
	now?: () => number;
}

export const JEV_MAX_STEPS = 60;
export const JEV_MAX_DECISIONS = JEV_MAX_STEPS * 2;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Observe with a bounded retry while a navigation settles. */
async function observeWithRetry(host: JevLoopHost): Promise<{ page: JevRawPage; space: JevSpace }> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await host.observe();
		} catch (error) {
			lastError = error;
			if (!(error instanceof JevStalePage)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("The page did not settle for observation.");
}

/**
 * Bounded predict -> act -> observe loop. The decision is consumed before any
 * mutation, mutations are never retried, generated text is reused after a stale
 * decision only while its entire helper input is unchanged, and a terminal
 * DONE choice is reported as unverified.
 */
export async function runJevLoop(host: JevLoopHost, options: JevLoopOptions = {}): Promise<JevRunOutcome> {
	const maxSteps = Math.max(1, Math.min(JEV_MAX_STEPS, Math.trunc(options.maxSteps ?? JEV_MAX_STEPS)));
	const maxDecisions = Math.max(maxSteps, Math.min(JEV_MAX_DECISIONS, Math.trunc(options.maxDecisions ?? maxSteps * 2)));
	const now = options.now ?? (() => Date.now());
	const startedAt = now();
	let { page, space } = await observeWithRetry(host);

	const history: JevExecutionRecord[] = [];
	let decisions = 0;
	let pendingText: { key: string; value: JevTextValue } | undefined;
	let status: JevRunOutcome["status"] = "step_budget";
	let message: string | undefined;
	// A failure after the first mutation must still return the executed trace.
	const errorOutcome = (failure: string): JevRunOutcome => ({
		status: "error",
		steps: history.length,
		decisions,
		elapsedMs: now() - startedAt,
		history,
		verification: "unverified",
		message: failure,
	});
	// A recovery observation that fails for a non-stale reason must not erase the
	// executed trace either, so it reports an error outcome instead of rejecting.
	let recoveryFailure: string | undefined;
	const recover = async (context: string): Promise<{ page: JevRawPage; space: JevSpace } | undefined> => {
		try {
			return await observeWithRetry(host);
		} catch (error) {
			recoveryFailure = `${context}: ${describeError(error)}`;
			return undefined;
		}
	};

	while (true) {
		if (decisions >= maxDecisions) {
			status = "step_budget";
			message = `Reached the ${maxDecisions}-decision budget.`;
			break;
		}

		let decision: JevDecision;
		try {
			decision = await host.decide(page, space, history);
		} catch (error) {
			if (!(error instanceof JevStalePage)) return errorOutcome(`Decision failed: ${describeError(error)}`);
			// A stale decision still spends budget, so a decide that keeps going stale
			// cannot bypass the decision cap and spin the loop.
			decisions += 1;
			const recovered = await recover("Decision recovery observation failed");
			if (!recovered) return errorOutcome(recoveryFailure!);
			({ page, space } = recovered);
			continue;
		}
		decisions += 1;

		if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
			let fresh: boolean;
			try {
				fresh = await host.fresh(page);
			} catch (error) {
				if (!(error instanceof JevStalePage)) return errorOutcome(`Completion freshness check failed: ${describeError(error)}`);
				fresh = false;
			}
			if (!fresh) {
				const recovered = await recover("Completion recovery observation failed");
				if (!recovered) return errorOutcome(recoveryFailure!);
				({ page, space } = recovered);
				continue;
			}
			status = decision.operation === "DONE" ? "done" : "blocked";
			break;
		}

		const action = actionById(page, decision.actionId);
		if (!action) throw new Error(`The policy selected unknown action '${decision.actionId}'.`);
		if (history.length >= maxSteps) {
			status = "step_budget";
			message = `Reached the ${maxSteps}-action budget.`;
			break;
		}

		let text: string | null = null;
		let textModel: string | null = null;
		let textLatencyMs = 0;
		if (action.kind === "fill") {
			const context = host.textContext(page, action, history);
			const key = JSON.stringify(context ?? null);
			if (pendingText?.key === key) {
				text = pendingText.value.text;
				textModel = pendingText.value.model;
				textLatencyMs = pendingText.value.latencyMs;
			} else {
				let generated: JevTextValue;
				try {
					generated = await host.text(context);
				} catch (error) {
					return errorOutcome(`Text generation failed: ${describeError(error)}`);
				}
				text = generated.text;
				textModel = generated.model;
				textLatencyMs = generated.latencyMs;
				pendingText = { key, value: generated };
			}
		}

		try {
			await host.execute(page, action, text);
		} catch (error) {
			if (!(error instanceof JevStalePage)) return errorOutcome(`Action execution failed: ${describeError(error)}`);
			// The decision is consumed and the mutation did not run. Any generated
			// value survives only while its entire helper input stays unchanged.
			const recovered = await recover("Mutation recovery observation failed");
			if (!recovered) return errorOutcome(recoveryFailure!);
			({ page, space } = recovered);
			continue;
		}
		pendingText = undefined;

		const record: JevExecutionRecord = {
			step: history.length + 1,
			actionId: action.id,
			action: action.label,
			kind: action.kind,
			operation: decision.operation,
			target: decision.target,
			probability: decision.probabilities[action.id] ?? null,
			confidence: decision.confidence,
			decisionLatencyMs: decision.latencyMs,
			text,
			textModel,
			textLatencyMs,
			pageChanged: null,
			url: page.url,
			usage: decision.usage,
		};
		history.push(record);
		host.progress?.(record);
		try {
			await host.settle(action);
		} catch (error) {
			return errorOutcome(`Post-action settle failed: ${describeError(error)}`);
		}

		let successor: { page: JevRawPage; space: JevSpace };
		try {
			successor = await observeWithRetry(host);
		} catch (error) {
			// The mutation already ran; report it instead of losing the executed action.
			return errorOutcome(`The action executed but the successor observation failed: ${describeError(error)}`);
		}
		record.pageChanged = jevFingerprint(successor.page) !== jevFingerprint(page);
		record.url = successor.page.url;
		page = successor.page;
		space = successor.space;

		const repeated = history.slice(-3);
		if (repeated.length === 3 && repeated.every((entry) => entry.pageChanged === false && entry.kind !== "wait")) {
			status = "blocked";
			message = "Three consecutive actions produced no page change.";
			break;
		}
	}

	return {
		status,
		steps: history.length,
		decisions,
		elapsedMs: now() - startedAt,
		history,
		verification: "unverified",
		message,
	};
}
