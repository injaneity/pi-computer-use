import type { FramePoints } from "./types.ts";

type AppIdentity = { pid?: number; bundleId?: string };
type RootIdentity = AppIdentity & { windowId?: number; nativeWindowRef?: string; windowTitle: string; framePoints: FramePoints };

export function appIdentity(target: AppIdentity): string {
	if (Number.isInteger(target.pid) && target.pid! > 0) return `pid:${target.pid}`;
	if (target.bundleId) return `app:${target.bundleId}`;
	throw new Error("Application identity requires a pid or package identifier.");
}

export function resourceKeyForTarget(platform: string, target: AppIdentity): string {
	// Default-display Android windows share touch input, keyboard focus and system surfaces.
	if (platform === "android") return "android-device:local";
	if (!Number.isInteger(target.pid) || target.pid! <= 0) throw new Error("Desktop target requires a valid pid.");
	return `desktop-pid:${target.pid}`;
}

export function rootIdentity(platform: string, target: RootIdentity): string {
	if (platform === "android") {
		if (!target.nativeWindowRef) throw new Error("Android root requires a generation-scoped native root ref.");
		return target.nativeWindowRef;
	}
	const app = appIdentity(target);
	if (target.windowId && target.windowId > 0) return `${app}|id:${target.windowId}`;
	if (target.nativeWindowRef) return `${app}|ref:${target.nativeWindowRef}`;
	const { x, y, w, h } = target.framePoints;
	return `${app}|title:${target.windowTitle.toLowerCase().trim()}|frame:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}
