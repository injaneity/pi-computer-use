import type { FindParams } from "./contract.ts";

export function normalizeFindParams(params: FindParams | null | undefined): FindParams {
	const rawParams = params ?? {};
	if (rawParams.pid !== undefined && (!Number.isFinite(rawParams.pid) || !Number.isInteger(rawParams.pid) || rawParams.pid <= 0)) {
		throw new Error("find_roots.pid must be a positive integer when provided.");
	}
	return {
		text: trimOrUndefined(rawParams.text),
		app: trimOrUndefined(rawParams.app),
		bundleId: trimOrUndefined(rawParams.bundleId),
		pid: rawParams.pid,
		kind: rawParams.kind,
	};
}

function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
