import { setTimeout as delay } from "node:timers/promises";
import { parseLookResponse } from "../../outline.ts";
import { assertPlatformArchitecture } from "../architecture.ts";
import type { ComputerUsePlatformBackend, HelperActResult, PlatformDiagnostics, PlatformRoot } from "../types.ts";
import { AndroidHelperClient } from "./helper.ts";

type Transport = Pick<AndroidHelperClient, "command" | "dispose">;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Android protocol object.");
	return value as Record<string, unknown>;
}
function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid Android protocol number.");
	return value;
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid Android protocol string.");
	return value;
}

export function parseAndroidRoots(value: unknown): PlatformRoot[] {
	const roots = record(value).roots;
	if (!Array.isArray(roots) || roots.length > 256) throw new Error("Invalid Android root collection.");
	return roots.map((item) => {
		const root = record(item), frame = record(root.framePoints);
		const rootRef = string(root.rootRef), bundleId = string(root.bundleId);
		if (!rootRef.startsWith("android:") || !bundleId) throw new Error("Invalid Android root identity.");
		return {
			kind: root.kind === "popover" || root.kind === "dialog" ? root.kind : "window",
			rootRef, windowRef: rootRef, bundleId, appName: string(root.appName),
			windowId: number(root.windowId), title: string(root.title), zOrder: number(root.zOrder),
			framePoints: { x: number(frame.x), y: number(frame.y), w: Math.max(0, number(frame.w)), h: Math.max(0, number(frame.h)) },
			scaleFactor: 1, isOnscreen: root.isOnscreen === true, isFocused: root.isFocused === true,
			isMain: root.isMain === true, isMinimized: false, isModal: root.isModal === true,
			metadata: root.metadata ? record(root.metadata) : undefined,
		};
	});
}

function actionResult(value: unknown): HelperActResult {
	const raw = record(value);
	const outcome = raw.outcome;
	if (outcome !== "worked" && outcome !== "didnt" && outcome !== "unknown") throw new Error("Android action result lacks an honest outcome.");
	// SAFETY: outcome is narrowed above. Other fields remain protocol diagnostics, not input commands.
	const result = raw as Record<string, unknown> & { outcome: typeof outcome };
	if (result.steps !== undefined) {
		if (!Array.isArray(result.steps) || result.steps.length > 20) throw new Error("Invalid Android transaction steps.");
		result.steps.forEach(actionResult);
	}
	// SAFETY: steps and outcome are checked above; optional native diagnostics use the shared contract.
	return result as HelperActResult;
}

function isBrowser(name: string): boolean {
	return /chrome|chromium|firefox|vivaldi|brave|opera|browser|microsoft\.emmx/i.test(name);
}

export function createAndroidBackend(transport?: Transport): ComputerUsePlatformBackend {
	let client = transport;
	const helper = (): Transport => client ??= new AndroidHelperClient();
	const roots = async (signal?: AbortSignal): Promise<PlatformRoot[]> => parseAndroidRoots(await helper().command("listRoots", {}, { signal }));
	return {
		name: "android",
		capabilities: { ocr: false, scopedRefresh: false, nativeTransactions: true, snapshotText: true },
		shutdown() { client?.dispose(); client = undefined; },
		async ensureReady(_ctx, state, signal) {
			const raw = record(await helper().command("diagnostics", {}, { signal, timeoutMs: 5000 }));
			if (raw.protocolVersion !== 1 || raw.os !== "android" || raw.accessibility !== true) throw new Error("Android companion is not ready. Enable its service and confirm pairing in the APK.");
			if (!Array.isArray(raw.invariants) || !raw.invariants.every(item => typeof item === "string")) throw new Error("Invalid Android architecture invariants.");
			const diagnostics: PlatformDiagnostics = {
				protocolVersion: 1, architectureVersion: number(raw.architectureVersion),
				invariants: raw.invariants, pid: number(raw.pid), os: "android", accessibility: true,
				arch: raw.arch === undefined ? undefined : string(raw.arch), screenRecording: raw.screenRecording === true,
			};
			assertPlatformArchitecture("Android", diagnostics);
			return { ...state, helperDiagnostics: diagnostics, lastPermissionCheckAt: Date.now() };
		},
		async listApps(signal) {
			const apps = new Map<string, {appName: string; bundleId: string; isFrontmost: boolean}>();
			for (const root of await roots(signal)) {
				const key = root.bundleId!;
				apps.set(key, { appName: root.appName!, bundleId: key, isFrontmost: root.isFocused || apps.get(key)?.isFrontmost === true });
			}
			return [...apps.values()];
		},
		async listRoots(query, signal) {
			if (query.pid !== undefined) return []; // Android does not expose target PIDs through this API.
			return (await roots(signal)).filter(root => (!query.bundleId || root.bundleId === query.bundleId)
				&& (!query.title || root.title.toLowerCase().includes(query.title.toLowerCase())));
		},
		async getFrontmost(signal) {
			const all = await roots(signal);
			const root = all.find(item => item.isFocused && item.metadata?.androidWindowType === 1)
				?? all.find(item => item.isMain && item.metadata?.androidWindowType === 1)
				?? all.find(item => item.isFocused);
			if (!root) throw new Error("No accessible active Android window. Open an app and observe again.");
			return { appName: root.appName!, bundleId: root.bundleId, rootRef: root.rootRef, windowId: root.windowId, windowTitle: root.title };
		},
		async focusWindow(target, signal) {
			const root = (await roots(signal)).find(item => item.rootRef === (target.rootRef ?? target.windowRef));
			return { focused: root?.isFocused === true, alreadyFocused: root?.isFocused === true, reason: root?.isFocused ? undefined : "Open the target app manually; Android window activation is not supported." };
		},
		async observe(request, options) {
			if (!request.target.rootRef && !request.target.windowRef) throw new Error("Android observation requires a generation-scoped rootRef.");
			const deadline = Date.now() + Math.max(100, Math.min(30000, options?.timeoutMs ?? 10000));
			for (let attempt = 0; ; attempt++) {
				try {
					return parseLookResponse(await helper().command("look", { ...request.target, baseLookId: request.baseLookId, scopeRef: request.scopeRef,
						readText: request.readText, maxDimension: request.maxDimension, includeImage: request.includeImage },
						{ ...options, timeoutMs: Math.max(100, deadline - Date.now()) }));
				} catch (error) {
					// Only retry a discarded read, against the exact same generation-scoped root.
					// Never retry input, transport failures, or an expired/replaced service.
					if ((error as { code?: string })?.code !== "observation_changed" || attempt >= 2 || options?.signal?.aborted || deadline - Date.now() < 250) throw error;
					await delay(150, undefined, { signal: options?.signal });
				}
			}
		},
		async act(request, options) { return actionResult(await helper().command("act", { ...request }, options)); },
		async actBatch(requests, options) { return actionResult(await helper().command("actBatch", { actions: requests }, options)); },
		async readText(args, options) { return await helper().command("readText", { ...args }, options); },
		async waitFor(args, options) {
			// The native loop stops earlier than the shared 60 s ceiling and rescans the UI tree every 100 ms.
			// Apply one bound here so callers never report a timeout that was not actually waited.
			const timeoutMs = Math.max(0, Math.min(25_000, Number.isFinite(args.timeoutMs) ? args.timeoutMs : 3_000));
			const result = record(await helper().command("waitFor", { ...args, timeoutMs },
				{ ...options, timeoutMs: Math.min(30_000, timeoutMs + 2_000) }));
			return {
				found: result.found === true, gone: result.gone === true, timedOut: result.timedOut === true,
				nodeCount: typeof result.nodeCount === "number" ? result.nodeCount : undefined, timeoutMs,
			};
		},
		isBrowserApp(appName, bundleId) { return isBrowser(bundleId ?? appName); },
		isChromeFamilyApp(appName, bundleId) { return isBrowser(bundleId ?? appName) && !/firefox/i.test(bundleId ?? appName); },
		async openBrowserLocation() { throw new Error("Android browser launching/CDP is not implemented. Use the native app UI."); },
	};
}

export const androidBackend = createAndroidBackend();
