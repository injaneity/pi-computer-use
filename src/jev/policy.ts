// jev decision-making: one direct TypeSafe transport, one Vercel AI SDK
// evaluation transport, and the small OpenAI-compatible text helper.

import { getComputerUseConfig } from "../config.ts";
import { buildDecisionQuestions, buildDecisionState, operationsForDecision, NEXT_ACTION, TARGET_RULES, TEXT_VALUE, type JevDecisionHistoryEntry } from "./questions.ts";
import { chooseJevActionViaVercel, loadJevVercelConfig, type JevVercelConfig, type JevVercelDependencies } from "./vercel.ts";
import type { JevDecision, JevDecisionProvider, JevOperation, JevRawAction, JevRawPage, JevSpace, JevTextValue } from "./types.ts";

export { NEXT_ACTION, TARGET_RULES, TEXT_VALUE } from "./questions.ts";

export type JevHistoryEntry = JevDecisionHistoryEntry;

/** Direct TypeSafe transport settings. */
export interface JevPolicyConfig {
	backend: "typesafe";
	url: string;
	key: string;
	model: string;
}

export interface JevTextConfig {
	textBaseUrl: string;
	textKey: string;
	textModel: string;
	reasoning: "deepseek" | "low" | "none";
}

function envValue(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/** Resolve the direct TypeSafe transport. Returns undefined without TYPESAFE_API_KEY. */
export function loadJevPolicyConfig(modelOverride?: string): JevPolicyConfig | undefined {
	const key = envValue("TYPESAFE_API_KEY", "PI_COMPUTER_USE_TYPESAFE_API_KEY");
	if (!key) return undefined;
	return {
		backend: "typesafe",
		url: envValue("TYPESAFE_BASE_URL", "PI_COMPUTER_USE_TYPESAFE_BASE_URL") ?? "https://api.typesafe.ai/v1/systemone",
		key,
		model: modelOverride ?? envValue("TYPESAFE_MODEL", "PI_COMPUTER_USE_TYPESAFE_MODEL") ?? "jev-latest",
	};
}

/**
 * Prefer a usable Vercel provider, then the direct TypeSafe transport, then the
 * unusable Vercel provider so its missing optional package is still reported.
 */
export function selectJevDecisionProvider(vercel: JevVercelConfig | undefined, typesafe: JevPolicyConfig | undefined): JevDecisionProvider | undefined {
	const usableVercel = vercel && !("missingModule" in vercel && vercel.missingModule) ? vercel : undefined;
	return usableVercel ?? typesafe ?? vercel;
}

/**
 * Resolve the decision backend from configuration. `auto` prefers the Vercel AI
 * SDK path when a Gateway or TypeSafe AI credential exists, then the direct
 * TypeSafe transport.
 */
export function loadJevDecisionProvider(): JevDecisionProvider | undefined {
	const config = getComputerUseConfig();
	const model = config.jev_model;
	if (config.jev_backend === "typesafe") return loadJevPolicyConfig(model);
	if (config.jev_backend === "vercel") return loadJevVercelConfig(model, config.jev_gateway_zdr);
	return selectJevDecisionProvider(loadJevVercelConfig(model, config.jev_gateway_zdr), loadJevPolicyConfig(model));
}

export function describeJevDecisionProvider(): string {
	const config = getComputerUseConfig();
	const provider = loadJevDecisionProvider();
	if (!provider) return `unavailable (backend ${config.jev_backend}: no credential)`;
	if ("missingModule" in provider && provider.missingModule) return `${provider.backend} needs '${provider.missingModule}'`;
	return `${provider.backend} · ${provider.model}`;
}

/**
 * Resolve the small OpenAI-compatible text helper. An explicit
 * TEXT_MODEL_API_KEY wins; otherwise known provider keys supply a working
 * default so field values stay model-generated rather than guessed.
 */
export function loadJevTextConfig(): JevTextConfig | undefined {
	const explicitKey = envValue("TEXT_MODEL_API_KEY", "PI_COMPUTER_USE_TEXT_MODEL_API_KEY");
	const explicitBase = envValue("TEXT_MODEL_BASE_URL", "PI_COMPUTER_USE_TEXT_MODEL_BASE_URL");
	const deepseekKey = envValue("DEEPSEEK_API_KEY");
	const openrouterKey = envValue("OPENROUTER_API_KEY");
	const key = explicitKey ?? (explicitBase?.includes("openrouter") ? openrouterKey : deepseekKey) ?? openrouterKey;
	if (!key) return undefined;
	// A provider key always talks to its own host. An explicit endpoint applies only
	// to an explicit key, so a provider credential is never posted elsewhere, and an
	// explicit key without an endpoint fails closed instead of guessing a host.
	const providerBase = key === deepseekKey ? "https://api.deepseek.com/v1" : "https://openrouter.ai/api/v1";
	const base = explicitKey ? explicitBase : providerBase;
	if (!base) return undefined;
	const reasoningEnv = envValue("TEXT_MODEL_REASONING", "PI_COMPUTER_USE_TEXT_MODEL_REASONING");
	const reasoning: JevTextConfig["reasoning"] = reasoningEnv === "none" ? "none" : base.includes("api.deepseek.com/") ? "deepseek" : "low";
	return {
		textBaseUrl: base.replace(/\/+$/, ""),
		textKey: key,
		textModel: envValue("TEXT_MODEL", "PI_COMPUTER_USE_TEXT_MODEL") ?? (base.includes("openrouter") ? "inception/mercury-2.5" : "deepseek-chat"),
		reasoning,
	};
}

async function postJson(url: string, key: string, body: unknown): Promise<any> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(25_000),
			});
		} catch {
			throw new Error("Model connection failed; no browser action executed.");
		}
		if (response.status === 429 || response.status === 529 || response.status === 503) {
			if (attempt < 2) {
				await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
				continue;
			}
			lastError = new Error("Model unavailable");
			break;
		}
		if (!response.ok) {
			throw new Error(`Model provider returned HTTP ${response.status}; no browser action executed.`);
		}
		try {
			return await response.json();
		} catch {
			throw new Error("Model provider returned an unreadable response; no browser action executed.");
		}
	}
	throw lastError ?? new Error("Model unavailable");
}

/** A TypeSafe answer is usable only when it is a well-formed, self-consistent distribution. */
export function validateChoice(answer: unknown, ids: string[]): { choice: string; confidence: number; probabilities: Record<string, number> } {
	const record = answer && typeof answer === "object" ? answer as Record<string, unknown> : undefined;
	const probabilities = record?.probabilities;
	let valid = false;
	if (record && probabilities && typeof probabilities === "object") {
		const distribution = probabilities as Record<string, unknown>;
		const numbers = [...Object.values(distribution), record.confidence];
		const idSet = new Set(ids);
		valid =
			typeof record.choice === "string" &&
			idSet.has(record.choice) &&
			Object.keys(distribution).length === ids.length &&
			Object.keys(distribution).every((key) => idSet.has(key)) &&
			numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) &&
			Math.abs(Object.values(distribution).reduce((sum: number, value) => sum + (value as number), 0) - 1) < 0.02 &&
			(distribution[record.choice] as number) >= Math.max(...Object.values(distribution) as number[]) - 1e-6;
	}
	if (!valid) throw new Error("Invalid TypeSafe response; no browser action executed.");
	const distribution = probabilities as Record<string, number>;
	return { choice: record!.choice as string, confidence: record!.confidence as number, probabilities: distribution };
}

/**
 * One direct TypeSafe request decides the operation and, speculatively, a
 * target for every available operation. Only the selected operation's target
 * head is consumed, so a malformed unused head cannot cause an action.
 */
export async function chooseJevActionViaTypeSafe(
	page: JevRawPage,
	space: JevSpace,
	goal: string,
	history: ReadonlyArray<JevHistoryEntry>,
	config: JevPolicyConfig,
): Promise<JevDecision> {
	const operations = operationsForDecision(space);
	const body = {
		model: config.model,
		state: buildDecisionState(page, space, history),
		questions: buildDecisionQuestions(space, goal),
	};
	const started = Date.now();
	const result = await postJson(config.url, config.key, body);
	const operationAnswer = validateChoice(result?.answers?.operation, Object.keys(operations));
	const operation = operationAnswer.choice as JevOperation;
	const targetAnswer = operation in space.targets
		? validateChoice(result?.answers?.[`${operation.toLowerCase()}_target`], Object.keys(space.targets[operation]!))
		: undefined;
	const action: JevRawAction | undefined = targetAnswer
		? space.targets[operation]![targetAnswer.choice]!
		: operation in space.controls
			? space.controls[operation]
			: undefined;
	const actionId = action?.id ?? operation;
	const probabilities: Record<string, number> = {};
	if (targetAnswer) {
		for (const [index, candidateAction] of Object.entries(space.targets[operation]!)) {
			probabilities[candidateAction.id] = targetAnswer.probabilities[index] ?? 0;
		}
	} else {
		probabilities[actionId] = operationAnswer.probabilities[operation] ?? 0;
	}
	return {
		operation,
		target: targetAnswer?.choice ?? null,
		actionId,
		confidence: operationAnswer.confidence,
		probabilities,
		operationProbabilities: operationAnswer.probabilities,
		targetProbabilities: targetAnswer?.probabilities ?? {},
		targetConfidence: targetAnswer?.confidence ?? null,
		model: typeof result?.model === "string" ? result.model : undefined,
		usage: result?.usage,
		latencyMs: Date.now() - started,
		request: body,
	};
}

/** Dispatch one decision to the resolved backend. */
export async function chooseJevAction(
	page: JevRawPage,
	space: JevSpace,
	goal: string,
	history: ReadonlyArray<JevHistoryEntry>,
	provider: JevDecisionProvider,
	deps: JevVercelDependencies = {},
): Promise<JevDecision> {
	if (provider.backend === "typesafe") return await chooseJevActionViaTypeSafe(page, space, goal, history, provider);
	return await chooseJevActionViaVercel(page, space, goal, history, provider, deps);
}

export function jevFieldContext(goal: string, action: JevRawAction, page: JevRawPage, history: ReadonlyArray<JevHistoryEntry>): { goal: string; field: Record<string, unknown>; page: { title: string; text: string }; recent_actions: Array<Record<string, unknown>> } {
	return {
		goal,
		field: { label: action.label, role: action.role, value: action.value },
		page: { title: page.title, text: page.text.slice(0, 6000) },
		recent_actions: history.slice(-6).map((entry) => ({ action: entry.action, text: entry.text })),
	};
}

/** Generate one field value. The result must be exactly {"text": "..."} or the helper fails closed. */
export async function jevFieldText(context: unknown, config: JevTextConfig): Promise<JevTextValue> {
	const reasoning: Record<string, unknown> = config.reasoning === "none"
		? { reasoning: { enabled: false } }
		: config.reasoning === "deepseek"
			? { thinking: { type: "disabled" } }
			: { reasoning: { effort: "low" } };
	const started = Date.now();
	const result = await postJson(`${config.textBaseUrl}/chat/completions`, config.textKey, {
		model: config.textModel,
		max_tokens: 1024,
		response_format: { type: "json_object" },
		...reasoning,
		messages: [
			{ role: "system", content: TEXT_VALUE },
			{ role: "user", content: JSON.stringify(context) },
		],
	});
	let value: string;
	try {
		const output = JSON.parse(result?.choices?.[0]?.message?.content);
		const keys = output && typeof output === "object" ? Object.keys(output) : [];
		if (keys.length !== 1 || keys[0] !== "text" || typeof output.text !== "string" || !output.text.trim() || output.text.length > 2000) throw new Error();
		value = output.text;
	} catch {
		throw new Error("Text helper returned no valid field value; nothing typed.");
	}
	return {
		text: value,
		model: config.textModel,
		latencyMs: Date.now() - started,
		usage: result?.usage,
	};
}
