import { randomUUID } from "node:crypto";
import { parseLookResponse, type LookResponse, type OutlineNode } from "../../outline.ts";
import type { ComputerUsePlatformBackend, HelperActResult, PlatformActRequest, PlatformApp, PlatformFocusWindowResult, PlatformFrontmostResult, PlatformObserveRequest, PlatformReadyState, PlatformReadTextResponse, PlatformWaitForResponse, PlatformWindow, PlatformWindowQuery } from "../types.ts";
import { windowsHelper } from "./helper.ts";

let windowsStateId: string | undefined;
let lastCapture: { x: number; y: number; width: number; height: number; pid: number; windowId: number; windowRef?: string } | undefined;
const lastElements = new Map<string, { x: number; y: number; w: number; h: number; text: string; role: string }>();

function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function num(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function bool(value: unknown): boolean { return value === true || value === 1 || value === "true"; }

function rolePairing(): { confidence: "exact" | "high" | "low"; score: number } {
	return { confidence: "low", score: 0 };
}

function normalizedProcessName(appName: string): string {
	return appName.toLowerCase().replace(/\.exe$/i, "");
}

function classifyBrowser(appName: string): false | "chrome" | "edge" | "brave" {
	switch (normalizedProcessName(appName)) {
		case "chrome":
		case "chromium":
			return "chrome";
		case "msedge":
		case "edge":
			return "edge";
		case "brave":
		case "brave-browser":
			return "brave";
		default:
			return false;
	}
}

function parseWindows(result: unknown): PlatformWindow[] {
	const record = result as any;
	windowsStateId = str(record?.stateId) ?? windowsStateId;
	const windows = Array.isArray(record?.windows) ? record.windows : [];
	return windows.map((raw: any) => {
		const bounds = raw?.bounds ?? {};
		return {
			windowId: Math.trunc(num(raw?.windowId)),
			windowRef: str(raw?.ref),
			pid: num(raw?.pid),
			title: str(raw?.title) ?? "",
			role: "window",
			pairing: rolePairing(),
			framePoints: { x: num(bounds.x), y: num(bounds.y), w: Math.max(1, num(bounds.width, 1)), h: Math.max(1, num(bounds.height, 1)) },
			scaleFactor: 1,
			isMinimized: false,
			isOnscreen: true,
			isMain: bool(raw?.isFocused),
			isFocused: bool(raw?.isFocused),
			isModal: false,
			sheetCount: 0,
			metadata: { processName: raw?.processName, isBrowser: raw?.isBrowser, browserFamily: raw?.browserFamily },
		} satisfies PlatformWindow;
	});
}

function emptyNode(ref: string, role: string, title: string, rect?: { x: number; y: number; w: number; h: number }): OutlineNode {
	return {
		ref, role, title, rect,
		subrole: "", identifier: "", description: "", value: "", actions: [],
		canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false,
		isTextInput: false, focused: false, offscreen: false, pictureOnly: true, truncated: false, text: [], children: [],
	};
}

function elementNode(raw: any, index: number): OutlineNode {
	const bounds = raw?.bounds ?? {};
	const role = str(raw?.role) ?? "unknown";
	const text = str(raw?.value) ?? str(raw?.label) ?? "";
	const rect = { x: num(bounds.x), y: num(bounds.y), w: Math.max(1, num(bounds.width, 1)), h: Math.max(1, num(bounds.height, 1)) };
	const wireRef = str(raw?.ref);
	if (wireRef) lastElements.set(wireRef, { ...rect, text, role });
	return {
		...emptyNode(`@e${index + 2}`, role, str(raw?.label) ?? "", rect),
		wireRef, identifier: str(raw?.automationId) ?? "", description: str(raw?.className) ?? "", value: str(raw?.value) ?? "", text: text ? [{ string: text, confidence: 1, rect }] : [],
		canPress: bool(raw?.capabilities?.canInvoke), canFocus: bool(raw?.capabilities?.isKeyboardFocusable), canSetValue: bool(raw?.capabilities?.canSetValue), canScroll: bool(raw?.capabilities?.canScroll), offscreen: bool(raw?.capabilities?.isOffscreen), pictureOnly: false,
	};
}

function screenPointForTarget(target: unknown): { x: number; y: number } | undefined {
	const raw = target as any;
	if (typeof raw?.ref === "string") {
		const element = lastElements.get(raw.ref);
		if (!element) throw new Error(`Windows action target '${raw.ref}' was not found in the latest observe.`);
		return { x: element.x + element.w / 2, y: element.y + element.h / 2 };
	}
	if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) {
		if (!lastCapture) return { x: Math.round(raw.x), y: Math.round(raw.y) };
		return { x: lastCapture.x + Math.round(raw.x), y: lastCapture.y + Math.round(raw.y) };
	}
	return undefined;
}

function pngScreenshotToLook(target: PlatformObserveRequest["target"], result: any): LookResponse {
	const capture = result?.capture ?? {};
	const width = Math.max(1, num(capture.width, 1));
	const height = Math.max(1, num(capture.height, 1));
	lastCapture = { x: num(capture.x), y: num(capture.y), width, height, pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	lastElements.clear();
	const root = emptyNode("@e1", "window", "Window", { x: 0, y: 0, w: width, h: height });
	root.children = Array.isArray(result?.axTargets) ? result.axTargets.map(elementNode) : [];
	return parseLookResponse({
		lookId: str(capture.stateId) ?? randomUUID(),
		capturedAt: Date.now(),
		window: {
			windowId: target.windowId ?? 0,
			framePoints: { x: 0, y: 0, w: width, h: height },
			scaleFactor: 1,
			pairing: rolePairing(),
			isModal: false,
			sheetCount: 0,
			role: "window",
			subrole: "",
		},
		image: { jpegBase64: str(capture.imageBase64) ?? "", width, height, mimeType: str(capture.imageFormat) === "png" ? "image/png" : "image/jpeg" },
		outline: root,
		timings: {},
	});
}

export const windowsBackend: ComputerUsePlatformBackend = {
	name: "windows",
	async ensureReady(_ctx, state, signal) { await windowsHelper.ensureInstalled(signal); return state; },
	async listApps(signal): Promise<PlatformApp[]> {
		const seen = new Set<number>();
		return parseWindows(await windowsHelper.command("listWindows", {}, { signal })).flatMap((window) => {
			const raw = (window.metadata ?? {}) as any;
			if (!window.pid || seen.has(window.pid)) return [];
			seen.add(window.pid);
			return [{ appName: String(raw.processName ?? "Unknown").replace(/\.exe$/i, ""), pid: window.pid, isFrontmost: window.isFocused }];
		});
	},
	async listWindows(query: PlatformWindowQuery, signal): Promise<PlatformWindow[]> {
		return parseWindows(await windowsHelper.command("listWindows", { pid: query.pid }, { signal }));
	},
	async getFrontmost(signal): Promise<PlatformFrontmostResult> {
		const result = await windowsHelper.command<any>("listWindows", {}, { signal });
		const focused = (Array.isArray(result?.windows) ? result.windows : []).find((w: any) => bool(w.isFocused)) ?? result?.windows?.[0];
		if (!focused) throw new Error("No frontmost window was available.");
		windowsStateId = str(result.stateId) ?? windowsStateId;
		return { appName: String(focused.processName ?? "Unknown").replace(/\.exe$/i, ""), pid: Number(focused.pid), windowTitle: str(focused.title), windowId: Math.trunc(num(focused.windowId)) };
	},
	async focusWindow(target, signal): Promise<PlatformFocusWindowResult> {
		if (!target.windowRef) return { focused: false, reason: "Windows focusWindow requires a window ref from list_windows." };
		return await windowsHelper.command<PlatformFocusWindowResult>("focusWindow", { ref: target.windowRef, stateId: windowsStateId }, { signal });
	},
	async observe(request, options): Promise<LookResponse> {
		if (!request.target.windowRef) throw new Error("Windows observe requires a window ref from list_windows.");
		return pngScreenshotToLook(request.target, await windowsHelper.command("screenshot", { ref: request.target.windowRef, stateId: windowsStateId, includeElements: true }, { timeoutMs: options?.timeoutMs ?? 25_000, signal: options?.signal }));
	},
	async act(request: PlatformActRequest, options): Promise<HelperActResult> {
		const point = screenPointForTarget(request.target);
		const params = request.params ?? {};
		return await windowsHelper.command<HelperActResult>("act", {
			action: request.action,
			point,
			path: Array.isArray((params as any).path) ? (params as any).path.map((p: any) => screenPointForTarget(p)) : undefined,
			text: str((params as any).text) ?? "",
			keys: Array.isArray((params as any).keys) ? (params as any).keys : undefined,
			scrollX: num((params as any).scrollX),
			scrollY: num((params as any).scrollY),
		}, options);
	},
	async readText(args): Promise<PlatformReadTextResponse> {
		const element = lastElements.get(args.elementRef);
		const text = element?.text ?? "";
		const offset = Math.max(0, Math.trunc(args.offset));
		const limit = Math.max(1, Math.trunc(args.limit));
		return { text: text.slice(offset, offset + limit), offset, limit, totalChars: text.length, hasMore: offset + limit < text.length };
	},
	async waitFor(args, options): Promise<PlatformWaitForResponse> {
		const deadline = Date.now() + Math.max(100, Math.trunc(args.timeoutMs));
		const text = args.text?.toLowerCase();
		const role = args.role;
		const gone = args.gone;
		let nodeCount = 0;
		do {
			if (lastCapture?.windowRef) await this.observe({ target: { pid: lastCapture.pid, windowId: lastCapture.windowId, windowRef: lastCapture.windowRef }, readText: "auto" }, options);
			nodeCount = lastElements.size;
			const found = [...lastElements.values()].some((element) => (!text || element.text.toLowerCase().includes(text)) && (!role || element.role === role));
			if (found !== gone) return { found: true, gone: gone || undefined, nodeCount };
			await new Promise((resolve) => setTimeout(resolve, 200));
		} while (Date.now() < deadline && !options?.signal?.aborted);
		return { found: false, timedOut: true, nodeCount };
	},
	isBrowserApp(appName) { return classifyBrowser(appName) !== false; },
	isChromeFamilyApp(appName) { return classifyBrowser(appName) === "chrome" || classifyBrowser(appName) === "edge" || classifyBrowser(appName) === "brave"; },
	managedBrowserExecutable(browser) {
		if (browser === "helium") throw new Error("Managed Helium launch is not available on Windows. Use browser: 'chrome'.");
		return process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
	},
	async openBrowserLocation(_target, url, signal) {
		await windowsHelper.command("act", { action: "keypress", keys: ["ctrl", "l"] }, { signal });
		await windowsHelper.command("act", { action: "typeText", text: url }, { signal });
		await windowsHelper.command("act", { action: "keypress", keys: ["enter"] }, { signal });
		return true;
	},
};
