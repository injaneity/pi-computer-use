import { parseLookResponse, type LookResponse } from "../../outline.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { ComputerUsePlatformBackend, FramePoints, HelperActResult, PlatformActRequest, PlatformApp, PlatformFocusWindowResult, PlatformFrontmostResult, PlatformObserveRequest, PlatformReadTextRequest, PlatformReadTextResponse, PlatformTarget, PlatformWaitForRequest, PlatformWaitForResponse, PlatformWindow, PlatformWindowQuery } from "../types.ts";
import { macosHelper } from "./helper.ts";

function parseApps(result: unknown): PlatformApp[] {
	const array = Array.isArray(result) ? result : (result as any)?.apps;
	if (!Array.isArray(array)) return [];

	return array
		.map((raw) => {
			const pid = Math.trunc(toFiniteNumber((raw as any)?.pid, NaN));
			if (!Number.isFinite(pid) || pid <= 0) return undefined;
			const appName = toOptionalString((raw as any)?.appName) ?? "Unknown App";
			return {
				appName,
				bundleId: toOptionalString((raw as any)?.bundleId),
				pid,
				isFrontmost: toBoolean((raw as any)?.isFrontmost),
			} as PlatformApp;
		})
		.filter((item): item is PlatformApp => Boolean(item));
}

function parseFramePoints(raw: unknown): FramePoints {
	const frame = (raw as any)?.framePoints ?? {};
	return {
		x: toFiniteNumber(frame.x, 0),
		y: toFiniteNumber(frame.y, 0),
		w: Math.max(1, toFiniteNumber(frame.w, 1)),
		h: Math.max(1, toFiniteNumber(frame.h, 1)),
	};
}

function parseWindows(result: unknown): PlatformWindow[] {
	const array = Array.isArray(result) ? result : (result as any)?.windows;
	if (!Array.isArray(array)) return [];

	return array.map((raw) => {
		const pairing = (raw as any)?.pairing;
		const confidence = pairing?.confidence === "exact" || pairing?.confidence === "high" || pairing?.confidence === "low" ? pairing.confidence : "low";
		return {
			windowId: Number.isFinite((raw as any)?.windowId) ? Math.trunc((raw as any).windowId) : undefined,
			windowRef: toOptionalString((raw as any)?.windowRef),
			title: toOptionalString((raw as any)?.title) ?? "",
			role: toOptionalString((raw as any)?.role),
			subrole: toOptionalString((raw as any)?.subrole),
			pairing: { confidence, score: toFiniteNumber(pairing?.score, Number.NEGATIVE_INFINITY) },
			framePoints: parseFramePoints(raw),
			scaleFactor: Math.max(1, toFiniteNumber((raw as any)?.scaleFactor, 1)),
			isMinimized: toBoolean((raw as any)?.isMinimized),
			isOnscreen: toBoolean((raw as any)?.isOnscreen),
			isMain: toBoolean((raw as any)?.isMain),
			isFocused: toBoolean((raw as any)?.isFocused),
			isModal: toBoolean((raw as any)?.isModal),
			sheetCount: Math.max(0, Math.trunc(toFiniteNumber((raw as any)?.sheetCount, 0))),
		};
	});
}

export const macosBackend: Pick<ComputerUsePlatformBackend, "listApps" | "listWindows" | "getFrontmost" | "focusWindow" | "observe" | "act" | "readText" | "waitFor"> = {
	async listApps(signal?: AbortSignal): Promise<PlatformApp[]> {
		return parseApps(await macosHelper.command<unknown>("listApps", {}, { signal }));
	},

	async listWindows(query: PlatformWindowQuery, signal?: AbortSignal): Promise<PlatformWindow[]> {
		return parseWindows(await macosHelper.command<unknown>("listWindows", { pid: Math.trunc(query.pid) }, { signal }));
	},

	async getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult> {
		const result = await macosHelper.command<any>("getFrontmost", {}, { signal });
		const pid = Math.trunc(toFiniteNumber(result?.pid, NaN));
		if (!Number.isFinite(pid) || pid <= 0) {
			throw new Error("No frontmost app was available for screenshot targeting.");
		}
		return {
			appName: toOptionalString(result?.appName) ?? "Unknown App",
			bundleId: toOptionalString(result?.bundleId),
			pid,
			windowTitle: toOptionalString(result?.windowTitle),
			windowId: Number.isFinite(result?.windowId) ? Math.trunc(result.windowId) : undefined,
		};
	},

	async focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult> {
		return await macosHelper.command<PlatformFocusWindowResult>("focusWindow", { ...target }, { signal });
	},

	async observe(request: PlatformObserveRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LookResponse> {
		return parseLookResponse(await macosHelper.command("look", {
			windowId: request.target.windowId,
			maxDimension: request.maxDimension,
			readText: request.readText,
			scopeRef: request.scopeRef,
		}, options));
	},

	async act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult> {
		return await macosHelper.command<HelperActResult>("act", { ...request }, options);
	},

	async readText(args: PlatformReadTextRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformReadTextResponse> {
		return await macosHelper.command("axReadText", { ...args }, options);
	},

	async waitFor(args: PlatformWaitForRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformWaitForResponse> {
		return await macosHelper.command("axWaitFor", { ...args }, options);
	},
};
