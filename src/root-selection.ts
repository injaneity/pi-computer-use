import type { PlatformRoot } from "./platform/types.ts";

type RankedRoot = Pick<PlatformRoot,
	"windowId" | "windowRef" | "isModal" | "isFocused" | "isMain" | "isMinimized" | "isOnscreen" | "zOrder" | "title"
>;

export function scoreWindow(window: RankedRoot): number {
	let score = 0;
	if (window.isModal) score += 180;
	if (window.isFocused) score += 100;
	if (window.isMain) score += 80;
	if (!window.isMinimized) score += 40;
	if (window.isOnscreen) score += 20;
	if (window.windowId && window.windowId > 0) score += 10;
	if (window.title.trim().length > 0) score += 2;
	return score;
}

export function shouldPreferForegroundModalWindow(current: RankedRoot, candidate: RankedRoot): boolean {
	if (candidate.windowId === current.windowId && candidate.windowRef === current.windowRef) return false;
	if (!candidate.isOnscreen || candidate.isMinimized || !candidate.isModal) return false;
	// AXDialog can describe a background main window, so modality alone is insufficient.
	const candidateIsInFront = candidate.isFocused || candidate.zOrder < current.zOrder;
	return candidateIsInFront && scoreWindow(candidate) >= scoreWindow(current);
}
