// Vercel AI SDK evaluation backend for jev decision-making.
//
// `experimental_evaluate` (AI SDK 7+) resolves a `creator/model` string through
// Vercel AI Gateway, or a provider model instance through `@ai-sdk/typesafe-ai`.
// It sends the same operation and target-head questions the direct TypeSafe
// transport sends, and returns typed Choice answers with probabilities and a
// separate TypeSafe confidence statistic.

import { createRequire } from "node:module";
import { buildDecisionQuestions, buildDecisionState, operationsForDecision, type JevDecisionHistoryEntry } from "./questions.ts";
import type { JevDecision, JevOperation, JevRawPage, JevSpace } from "./types.ts";

const require = createRequire(import.meta.url);

export interface JevVercelGatewayConfig {
	backend: "vercel-gateway";
	model: string;
	/** Set only for a Vercel access token; Gateway API keys and OIDC use the SDK default. */
	apiKey?: string;
	zeroDataRetention: boolean;
	missingModule?: string;
}

export interface JevVercelTypesafeConfig {
	backend: "vercel-typesafe";
	model: string;
	apiKey: string;
	missingModule?: string;
}

export type JevVercelConfig = JevVercelGatewayConfig | JevVercelTypesafeConfig;

/** Injectable for offline tests; the real values come from the installed `ai` package. */
export interface JevVercelDependencies {
	evaluate?: (options: Record<string, unknown>) => Promise<any>;
	createGateway?: (options: Record<string, unknown>) => any;
	typeSafeAi?: { evaluationModel: (model: string) => unknown };
}

function envValue(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function moduleAvailable(name: string): boolean {
	try {
		require.resolve(name);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the Vercel AI SDK backend. Gateway credentials win over the direct
 * TypeSafe provider; both are optional and report a missing package instead of
 * silently disabling decision-making.
 */
export function loadJevVercelConfig(modelOverride?: string, zeroDataRetention = false): JevVercelConfig | undefined {
	const aiMissing = moduleAvailable("ai") ? undefined : "ai";
	const gatewayKey = envValue("AI_GATEWAY_API_KEY", "PI_COMPUTER_USE_AI_GATEWAY_API_KEY");
	const vercelToken = envValue("VERCEL_API_KEY");
	const oidcToken = envValue("VERCEL_OIDC_TOKEN");
	if (gatewayKey || vercelToken || oidcToken) {
		return {
			backend: "vercel-gateway",
			model: modelOverride ?? envValue("PI_COMPUTER_USE_JEV_MODEL") ?? "typesafe-ai/jev",
			// A Vercel access token is not auto-detected by the SDK, so pass it explicitly.
			apiKey: gatewayKey || oidcToken ? undefined : vercelToken,
			zeroDataRetention,
			missingModule: aiMissing,
		};
	}
	const typesafeKey = envValue("TYPESAFE_AI_API_KEY");
	if (typesafeKey) {
		return {
			backend: "vercel-typesafe",
			model: modelOverride ?? envValue("PI_COMPUTER_USE_JEV_MODEL") ?? "jev-latest",
			apiKey: typesafeKey,
			missingModule: aiMissing ?? (moduleAvailable("@ai-sdk/typesafe-ai") ? undefined : "@ai-sdk/typesafe-ai"),
		};
	}
	return undefined;
}

async function importOptionalModule(name: string): Promise<any> {
	// A non-literal specifier keeps these optional packages out of static resolution.
	return await import(name);
}

async function loadAiSdk(): Promise<{ evaluate: (options: Record<string, unknown>) => Promise<any>; createGateway?: (options: Record<string, unknown>) => any }> {
	const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	if (Number.isFinite(nodeMajor) && nodeMajor < 22) {
		throw new Error(`The Vercel AI SDK backend needs Node.js >= 22 (ai@7 requires it); current Node is ${process.version}.`);
	}
	let module: any;
	try {
		module = await importOptionalModule("ai");
	} catch {
		throw new Error("The Vercel AI SDK backend needs the 'ai' package (AI SDK 7+). Install ai@latest.");
	}
	const evaluate = module?.experimental_evaluate ?? module?.evaluate;
	if (typeof evaluate !== "function") {
		throw new Error("The installed 'ai' package does not export experimental_evaluate; AI SDK 7.0.105 or later is required.");
	}
	return { evaluate, createGateway: typeof module?.createGateway === "function" ? module.createGateway : undefined };
}

async function resolveEvaluationModel(config: JevVercelConfig, deps: JevVercelDependencies, createGateway?: (options: Record<string, unknown>) => any): Promise<unknown> {
	if (config.backend === "vercel-typesafe") {
		let provider = deps.typeSafeAi;
		if (!provider) {
			try {
				provider = (await importOptionalModule("@ai-sdk/typesafe-ai")).typeSafeAi;
			} catch {
				throw new Error("The Vercel TypeSafe provider needs '@ai-sdk/typesafe-ai'. Install @ai-sdk/typesafe-ai.");
			}
		}
		if (typeof provider?.evaluationModel !== "function") throw new Error("'@ai-sdk/typesafe-ai' does not expose typeSafeAi.evaluationModel.");
		return provider.evaluationModel(config.model);
	}
	if (config.apiKey) {
		if (typeof createGateway !== "function") {
			throw new Error("A Vercel access token needs createGateway from 'ai' (AI SDK 5.0.36+); prefer AI_GATEWAY_API_KEY.");
		}
		return createGateway({ apiKey: config.apiKey }).evaluationModel(config.model);
	}
	// A plain string resolves through Vercel AI Gateway using AI_GATEWAY_API_KEY or OIDC.
	return config.model;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Map one evaluation result back to a code-owned action. The SDK validates the
 * answer shape and distribution; this additionally rejects an option that is
 * not an offered target so model output can never name an unobserved action.
 */
export function decisionFromEvaluation(result: any, space: JevSpace, latencyMs: number): JevDecision {
	const operations = operationsForDecision(space);
	const operationAnswer = result?.answers?.operation;
	if (!operationAnswer || operationAnswer.type !== "choice" || typeof operationAnswer.choice !== "string" || !(operationAnswer.choice in operations)) {
		throw new Error("Invalid Vercel evaluation response; no browser action executed.");
	}
	const operation = operationAnswer.choice as JevOperation;
	const confidenceTable = result?.providerMetadata?.typesafe?.confidence;
	const operationConfidence = numberOrUndefined(confidenceTable?.operation);

	let target: string | null = null;
	let targetAnswer: any;
	let actionId: string;
	const probabilities: Record<string, number> = {};
	const targetProbabilities: Record<string, number> = {};
	if (operation in space.targets) {
		const headId = `${operation.toLowerCase()}_target`;
		const candidates = space.targets[operation]!;
		targetAnswer = result?.answers?.[headId];
		if (!targetAnswer || targetAnswer.type !== "choice" || typeof targetAnswer.choice !== "string" || !(targetAnswer.choice in candidates)) {
			throw new Error("Invalid Vercel evaluation response; no browser action executed.");
		}
		target = String(targetAnswer.choice);
		actionId = candidates[target]!.id;
		for (const [index, candidate] of Object.entries(candidates)) {
			const probability = numberOrZero(targetAnswer.probabilities?.[index]);
			probabilities[candidate.id] = probability;
			targetProbabilities[index] = probability;
		}
	} else if (operation in space.controls) {
		actionId = space.controls[operation]!.id;
		probabilities[actionId] = numberOrZero(operationAnswer.probabilities?.[operation]);
	} else {
		actionId = operation;
		probabilities[actionId] = numberOrZero(operationAnswer.probabilities?.[operation]);
	}

	return {
		operation,
		target,
		actionId,
		confidence: operationConfidence ?? numberOrZero(operationAnswer.probabilities?.[operation]),
		probabilities,
		operationProbabilities: { ...(operationAnswer.probabilities ?? {}) },
		targetProbabilities,
		targetConfidence: targetAnswer ? numberOrUndefined(confidenceTable?.[`${operation.toLowerCase()}_target`]) ?? null : null,
		model: typeof result?.response?.modelId === "string" ? result.response.modelId : undefined,
		usage: result?.usage,
		latencyMs,
	};
}

/** One AI SDK evaluation call decides the operation and its speculative target head. */
export async function chooseJevActionViaVercel(
	page: JevRawPage,
	space: JevSpace,
	goal: string,
	history: ReadonlyArray<JevDecisionHistoryEntry>,
	config: JevVercelConfig,
	deps: JevVercelDependencies = {},
): Promise<JevDecision> {
	if (config.missingModule) {
		throw new Error(`The Vercel AI SDK backend needs '${config.missingModule}' installed. Run: npm install ${config.missingModule}`);
	}
	const ai = deps.evaluate ? undefined : await loadAiSdk();
	const evaluate = deps.evaluate ?? ai!.evaluate;
	const createGateway = deps.createGateway ?? ai?.createGateway;
	const model = await resolveEvaluationModel(config, deps, createGateway);
	const started = Date.now();
	const result = await evaluate({
		model,
		state: buildDecisionState(page, space, history),
		questions: buildDecisionQuestions(space, goal),
		maxRetries: 2,
		...(config.backend === "vercel-gateway" && config.zeroDataRetention ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
	});
	return decisionFromEvaluation(result, space, Date.now() - started);
}
