import { nodeByRef, outlineNodeLabel, type Outline, type OutlineNode } from "./outline.ts";

interface NoteRegion {
	key: string;
	label: string;
	status: "seen" | "changed" | "never-looked";
	detail?: string;
}

export interface WindowNote {
	windowRef: string;
	title: string;
	pairing: "exact" | "high" | "low";
	lastLookId?: string;
	regions: NoteRegion[];
}

interface NoteWindowInput {
	windowRef?: string;
	title: string;
	pairing?: "exact" | "high" | "low";
	pairingScore?: number;
}

interface NoteRefreshOutcome {
	window: NoteWindowInput;
	windowChanged?: boolean;
	newWindowLabel?: string;
	rootDelta?: Array<{ change: string; kind: string; title?: string; ref?: string }>;
}

function normalizedLabel(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function nodeLabel(node: OutlineNode): string {
	return outlineNodeLabel(node) || node.role || node.ref;
}

function regionKey(node: OutlineNode): string {
	return `${node.role || "AXUnknown"}:${node.identifier || normalizedLabel(nodeLabel(node)) || node.ref}`;
}

function regionLabel(node: OutlineNode): string {
	const label = nodeLabel(node);
	return normalizedLabel(label) || normalizedLabel(node.role) || node.ref;
}

function topLevelRegions(outline: Outline): Array<{ node: OutlineNode; key: string; label: string }> {
	const nodes = outline.root.children.length ? outline.root.children : [outline.root];
	return nodes.map((node) => ({ node, key: regionKey(node), label: regionLabel(node) }));
}

function topLevelAncestor(node: OutlineNode, outline: Outline): OutlineNode {
	let current = node;
	while (current.parent && current.parent !== outline.root) current = current.parent;
	return current;
}

function uniqueRegions(regions: NoteRegion[]): NoteRegion[] {
	const seen = new Set<string>();
	const output: NoteRegion[] = [];
	for (const region of regions) {
		const dedupeKey = `${region.key}:${region.status}:${region.detail ?? ""}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		output.push(region);
	}
	return output;
}

function frontierRegions(outline: Outline, topLevels: Array<{ node: OutlineNode; key: string; label: string }>): NoteRegion[] {
	const output: NoteRegion[] = [];
	for (const node of outline.nodes) {
		if (node.scrollExtent && node.scrollExtent.seen < node.scrollExtent.total) {
			const ancestor = topLevelAncestor(node, outline);
			const top = topLevels.find((candidate) => candidate.node === ancestor);
			output.push({
				key: `${top?.key ?? regionKey(ancestor)}:scroll:${node.ref}`,
				label: top?.label ?? regionLabel(ancestor),
				status: "never-looked",
				detail: `${node.scrollExtent.total} rows, ${node.scrollExtent.seen} seen`,
			});
		}
		if (node.truncated) {
			const ancestor = topLevelAncestor(node, outline);
			const top = topLevels.find((candidate) => candidate.node === ancestor);
			output.push({
				key: `${top?.key ?? regionKey(ancestor)}:truncated:${node.ref}`,
				label: top?.label ?? regionLabel(ancestor),
				status: "never-looked",
				detail: "subtree not walked",
			});
		}
	}
	return output;
}

export function noteFromLook(prev: WindowNote | undefined, outline: Outline, window: NoteWindowInput): WindowNote {
	const topLevels = topLevelRegions(outline);
	const currentKeys = new Set(topLevels.map((region) => region.key));
	const regions: NoteRegion[] = topLevels.map((region) => ({
		key: region.key,
		label: region.label,
		status: "seen",
	}));

	if (prev) {
		for (const old of prev.regions) {
			if (old.status === "never-looked") continue;
			if (!currentKeys.has(old.key)) {
				regions.push({ ...old, status: "changed", detail: "not matched in latest look" });
			}
		}
	}

	if (!window.windowRef || window.pairingScore === Number.NEGATIVE_INFINITY) {
		regions.push({
			key: "window:unpaired",
			label: "window capture",
			status: "never-looked",
			detail: "AX window without capture pairing",
		});
	}

	regions.push(...frontierRegions(outline, topLevels));

	return {
		windowRef: window.windowRef ?? "(unpaired)",
		title: window.title,
		pairing: window.pairing ?? "low",
		lastLookId: outline.lookId,
		regions: uniqueRegions(regions),
	};
}

export function noteAfterAct(prev: WindowNote | undefined, targetRef: string | undefined, outline: Outline, refreshOutcome: NoteRefreshOutcome): WindowNote {
	const note = noteFromLook(prev, outline, refreshOutcome.window);
	if (targetRef) {
		const target = nodeByRef(outline, targetRef);
		if (target) {
			const ancestor = topLevelAncestor(target, outline);
			const key = regionKey(ancestor);
			const region = note.regions.find((candidate) => candidate.key === key);
			if (region) {
				region.status = "changed";
				region.detail = "acted here";
			} else {
				note.regions.unshift({ key, label: regionLabel(ancestor), status: "changed", detail: "acted here" });
			}
		}
	}
	for (const delta of refreshOutcome.rootDelta ?? []) {
		note.regions.unshift({
			key: `root:${delta.change}:${delta.ref ?? delta.kind}:${delta.title ?? ""}`,
			label: `${delta.kind}${delta.title ? ` ${delta.title}` : ""}`,
			status: delta.change === "closed" ? "changed" : "never-looked",
			detail: `root ${delta.change}`,
		});
	}
	if (refreshOutcome.windowChanged) {
		for (const region of note.regions) {
			if (region.status === "seen") region.status = "changed";
		}
		note.regions.push({
			key: `window:changed:${note.lastLookId ?? "unknown"}`,
			label: refreshOutcome.newWindowLabel ?? "new sheet/window",
			status: "never-looked",
			detail: "appeared after act",
		});
	}
	return { ...note, regions: uniqueRegions(note.regions) };
}

export function noteRegionKeyForRef(outline: Outline, ref: string): string | undefined {
	const node = nodeByRef(outline, ref);
	return node ? regionKey(topLevelAncestor(node, outline)) : undefined;
}

export function renderNote(note: WindowNote | undefined): string {
	if (!note) return "";
	const looked = note.lastLookId ? "looked just now" : "not looked";
	const lines = [`note ${note.windowRef} ${JSON.stringify(note.title)} (pairing ${note.pairing}, ${looked})`];
	for (const region of note.regions) {
		const detail = region.detail ? `   (${region.detail})` : "";
		lines.push(`  ${region.label.padEnd(14, " ")} ${region.status}${detail}`);
	}
	return lines.join("\n");
}
