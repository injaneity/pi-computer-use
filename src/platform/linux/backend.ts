import { parseLookResponse, type LookResponse } from "../../outline.ts";
import { assertPlatformArchitecture } from "../architecture.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type {
	ComputerUsePlatformBackend,
	FramePoints,
	HelperActResult,
	PlatformActRequest,
	PlatformApp,
	PlatformFocusWindowResult,
	PlatformFrontmostResult,
	PlatformObserveRequest,
	PlatformReadTextRequest,
	PlatformReadTextResponse,
	PlatformReadyState,
	PlatformRoot,
	PlatformRootKind,
	PlatformRootQuery,
	PlatformTarget,
	PlatformWaitForRequest,
	PlatformWaitForResponse,
} from "../types.ts";
import { LINUX_HELPER_PROTOCOL_VERSION, linuxHelper } from "./helper.ts";

function normalizedProcessName(appName: string): string {
	return appName.toLowerCase().split("/").pop()!.replace(/\.desktop$/i, "");
}

function classifyBrowser(appName: string): false | "chromium" | "firefox" {
	switch (normalizedProcessName(appName)) {
		case "chrome":
		case "google-chrome":
		case "google-chrome-stable":
		case "chromium":
		case "chromium-browser":
		case "microsoft-edge":
		case "microsoft-edge-stable":
		case "brave":
		case "brave-browser":
		case "vivaldi":
		case "vivaldi-stable":
		case "opera":
			return "chromium";
		case "firefox":
		case "firefox-esr":
			return "firefox";
		default:
			return false;
	}
}

function parseFramePoints(raw: unknown): FramePoints {
	const frame = (raw as any)?.framePoints ?? (raw as any)?.bounds ?? {};
	return {
		x: toFiniteNumber(frame.x, 0),
		y: toFiniteNumber(frame.y, 0),
		w: Math.max(1, toFiniteNumber(frame.w ?? frame.width, 1)),
		h: Math.max(1, toFiniteNumber(frame.h ?? frame.height, 1)),
	};
}

function parseRootKind(raw: unknown): PlatformRootKind {
	return raw === "menu" || raw === "sheet" || raw === "dialog" || raw === "popover" || raw === "window" ? raw : "window";
}

function parseRoots(result: unknown): PlatformRoot[] {
	const roots = Array.isArray(result) ? result : (result as any)?.roots;
	if (!Array.isArray(roots)) return [];
	return roots.map((raw: any, index): PlatformRoot => ({
		kind: parseRootKind(raw?.kind),
		rootRef: toOptionalString(raw?.rootRef ?? raw?.windowRef ?? raw?.ref),
		windowRef: toOptionalString(raw?.windowRef ?? raw?.rootRef ?? raw?.ref),
		windowId: Number.isFinite(raw?.windowId) ? Math.trunc(raw.windowId) : undefined,
		pid: Number.isFinite(raw?.pid) ? Math.trunc(raw.pid) : undefined,
		appName: toOptionalString(raw?.appName ?? raw?.processName),
		bundleId: toOptionalString(raw?.bundleId ?? raw?.desktopId),
		title: toOptionalString(raw?.title) ?? "",
		role: toOptionalString(raw?.role),
		subrole: toOptionalString(raw?.subrole),
		zOrder: Math.trunc(toFiniteNumber(raw?.zOrder, index)),
		framePoints: parseFramePoints(raw),
		scaleFactor: Math.max(1, toFiniteNumber(raw?.scaleFactor, 1)),
		isOnscreen: raw?.isOnscreen === undefined ? true : toBoolean(raw.isOnscreen),
		isFocused: toBoolean(raw?.isFocused),
		isMinimized: toBoolean(raw?.isMinimized),
		isMain: toBoolean(raw?.isMain ?? raw?.isFocused),
		isModal: toBoolean(raw?.isModal),
		metadata: raw?.metadata,
	}));
}

function appsFromRoots(roots: PlatformRoot[]): PlatformApp[] {
	const seen = new Set<number>();
	return roots.flatMap((root) => {
		if (!root.pid || seen.has(root.pid)) return [];
		seen.add(root.pid);
		return [{
			appName: root.appName ?? "Unknown",
			bundleId: root.bundleId,
			pid: root.pid,
			isFrontmost: root.isFocused,
		}];
	});
}

function helperAction(request: PlatformActRequest): Record<string, unknown> {
	if (!("focus" in request.target)) return { ...request };
	return { ...request, target: request.target.focus, params: { ...request.params, preserveFocus: true } };
}

async function ensureReady(_ctx: unknown, state: PlatformReadyState, signal?: AbortSignal): Promise<PlatformReadyState> {
	await linuxHelper.ensureInstalled(signal);
	const diagnostics = await linuxHelper.command<any>("diagnostics", {}, { signal, timeoutMs: 5_000 });
	if (diagnostics?.protocolVersion !== LINUX_HELPER_PROTOCOL_VERSION) {
		throw new Error(`Linux helper protocol mismatch: expected ${LINUX_HELPER_PROTOCOL_VERSION}, got ${diagnostics?.protocolVersion ?? "unknown"}. Restart Pi to use the installed helper.`);
	}
	assertPlatformArchitecture("Linux", diagnostics);
	if (diagnostics?.accessibility === false) {
		throw new Error("Linux accessibility is unavailable. Ensure AT-SPI is enabled and a D-Bus desktop accessibility bus is running.");
	}
	return { ...state, lastPermissionCheckAt: Date.now(), helperDiagnostics: diagnostics };
}

export const linuxBackend: ComputerUsePlatformBackend = {
	name: "linux",
	shutdown(): void {
		linuxHelper.dispose();
	},
	ensureReady,
	async listApps(signal?: AbortSignal): Promise<PlatformApp[]> {
		return appsFromRoots(parseRoots(await linuxHelper.command("listRoots", {}, { signal })));
	},
	async listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRoot[]> {
		const roots = parseRoots(await linuxHelper.command("listRoots", Number.isFinite(query.pid) ? { pid: Math.trunc(query.pid!) } : {}, { signal }));
		const title = query.title?.trim().toLowerCase();
		return title ? roots.filter((root) => root.title.trim().toLowerCase().includes(title)) : roots;
	},
	async getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult> {
		const roots = parseRoots(await linuxHelper.command("listRoots", {}, { signal }));
		const focused = roots.find((root) => root.isFocused) ?? roots[0];
		if (!focused?.pid) throw new Error("No frontmost window was available.");
		return {
			appName: focused.appName ?? "Unknown",
			bundleId: focused.bundleId,
			pid: focused.pid,
			windowTitle: focused.title,
			windowId: focused.windowId,
			rootRef: focused.rootRef,
		};
	},
	async focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult> {
		return await linuxHelper.command("focusWindow", { ...target }, { signal });
	},
	async observe(request: PlatformObserveRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LookResponse> {
		return parseLookResponse(await linuxHelper.command("look", {
			...request.target,
			baseLookId: request.baseLookId,
			maxDimension: request.maxDimension,
			readText: request.readText,
			scopeRef: request.scopeRef,
			includeImage: request.includeImage,
		}, options));
	},
	async act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult> {
		return await linuxHelper.command("act", helperAction(request), options);
	},
	async actBatch(requests: PlatformActRequest[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult> {
		return await linuxHelper.command("actBatch", { actions: requests.map(helperAction) }, options);
	},
	async readText(args: PlatformReadTextRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformReadTextResponse> {
		return await linuxHelper.command("atspiReadText", { ...args }, options);
	},
	async waitFor(args: PlatformWaitForRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformWaitForResponse> {
		return await linuxHelper.command("atspiWaitFor", { ...args }, options);
	},
	isBrowserApp(appName: string): boolean {
		return classifyBrowser(appName) !== false;
	},
	isChromeFamilyApp(appName: string): boolean {
		return classifyBrowser(appName) === "chromium";
	},
	async openBrowserLocation(target: { appName: string; bundleId?: string }, url: string, signal?: AbortSignal): Promise<boolean> {
		await linuxHelper.command("openBrowserLocation", { ...target, url }, { signal, timeoutMs: 10_000 });
		return true;
	},
};
