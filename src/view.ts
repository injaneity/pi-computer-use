import { serializeOutlineNode, type Outline, type OutlineChange, type OutlineDiff, type OutlineNode, type SerializedOutlineNode } from "./outline.ts";

function numericRef(ref: string): number {
	const match = /^@e(\d+)$/.exec(ref);
	return match ? Number(match[1]) : 0;
}

function rebuildIndexes(outline: Outline): void {
	outline.nodes = [];
	outline.refToWireRef = new Map();
	outline.wireRefToRef = new Map();
	const queue = [outline.root];
	while (queue.length > 0) {
		const node = queue.shift()!;
		outline.nodes.push(node);
		if (node.wireRef) {
			outline.refToWireRef.set(node.ref, node.wireRef);
			outline.wireRefToRef.set(node.wireRef, node.ref);
		}
		queue.push(...node.children);
	}
}

function structuralToken(node: OutlineNode): string {
	return [node.role, node.subrole, node.identifier, node.title, node.description].map((value) => value.trim().toLowerCase()).join("|");
}

function structuralKey(node: OutlineNode): string {
	const parts: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		const token = structuralToken(current);
		const siblings = current.parent?.children ?? [current];
		const peers = siblings.filter((candidate) => structuralToken(candidate) === token);
		parts.unshift(`${token}#${Math.max(0, peers.indexOf(current))}`);
		current = current.parent;
	}
	return parts.join(">");
}

/** Preserve public refs only when native or structural identity is unambiguous. */
export function stabilizeRefs(base: Outline | undefined, next: Outline): Outline {
	if (!base) return next;
	const reserved = new Set<string>();
	const assigned = new Set<OutlineNode>();
	const byWireRef = new Map(base.nodes.filter((node) => node.wireRef).map((node) => [node.wireRef!, node.ref]));
	const structuralGroups = new Map<string, OutlineNode[]>();
	for (const node of base.nodes) {
		const key = structuralKey(node);
		structuralGroups.set(key, [...(structuralGroups.get(key) ?? []), node]);
	}
	let nextIndex = Math.max(0, ...base.nodes.map((node) => numericRef(node.ref))) + 1;
	for (const node of next.nodes) {
		const wireStable = node.wireRef ? byWireRef.get(node.wireRef) : undefined;
		const structuralMatches = structuralGroups.get(structuralKey(node)) ?? [];
		const stable = wireStable ?? (structuralMatches.length === 1 ? structuralMatches[0].ref : undefined);
		if (stable && !reserved.has(stable)) {
			node.ref = stable;
			reserved.add(stable);
			assigned.add(node);
		}
	}
	for (const node of next.nodes) {
		if (assigned.has(node)) continue;
		while (reserved.has(`@e${nextIndex}`)) nextIndex += 1;
		node.ref = `@e${nextIndex++}`;
		reserved.add(node.ref);
	}
	rebuildIndexes(next);
	return next;
}

function comparable(node: OutlineNode): Omit<SerializedOutlineNode, "children"> {
	const { children: _children, ...fields } = serializeOutlineNode(node);
	return {
		...fields,
		rect: fields.rect ? { x: Math.round(fields.rect.x), y: Math.round(fields.rect.y), w: Math.round(fields.rect.w), h: Math.round(fields.rect.h) } : undefined,
		text: fields.text.map((item) => ({ string: item.string, confidence: Math.round(item.confidence * 100) / 100 })),
	};
}

function changedFields(base: OutlineNode, next: OutlineNode): Partial<Omit<SerializedOutlineNode, "children">> {
	const before = comparable(base);
	const after = comparable(next);
	const fields: Partial<Omit<SerializedOutlineNode, "children">> = {};
	for (const key of Object.keys(after) as Array<keyof typeof after>) {
		if (key === "ref" || key === "wireRef") continue;
		if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) (fields as Record<string, unknown>)[key] = after[key];
	}
	return fields;
}

function refPath(node: OutlineNode): string[] {
	const refs: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		refs.unshift(current.ref);
		current = current.parent;
	}
	return refs;
}

export function changesBetween(base: Outline, next: Outline): OutlineDiff {
	if (base.root.role !== next.root.role || base.root.subrole !== next.root.subrole) {
		return { changes: [], changedNodeCount: next.nodes.length, fullNodeCount: next.nodes.length, useFullView: true, reason: "root_replaced" };
	}
	const before = new Map(base.nodes.map((node) => [node.ref, node]));
	const after = new Map(next.nodes.map((node) => [node.ref, node]));
	const changes: OutlineChange[] = [];
	for (const node of next.nodes) {
		const previous = before.get(node.ref);
		if (!previous) changes.push({ type: "added", ref: node.ref, parent: node.parent?.ref, node: { ...serializeOutlineNode(node), children: [] } });
		else {
			const fields = changedFields(previous, node);
			if (Object.keys(fields).length > 0) changes.push({ type: "updated", ref: node.ref, path: refPath(node), fields });
		}
	}
	for (const node of base.nodes) if (!after.has(node.ref)) changes.push({ type: "removed", ref: node.ref, parent: node.parent?.ref });
	const identityConfidence = next.nodes.length === 0 ? 1 : next.nodes.filter((node) => before.has(node.ref)).length / next.nodes.length;
	const changeRatio = changes.length / Math.max(1, Math.max(base.nodes.length, next.nodes.length));
	const identityLow = next.nodes.length > 8 && identityConfidence < 0.4;
	const overBudget = changes.length > 100 || (changes.length > 20 && changeRatio > 0.65);
	return {
		changes,
		changedNodeCount: changes.length,
		fullNodeCount: next.nodes.length,
		useFullView: identityLow || overBudget,
		reason: identityLow ? "identity_confidence_low" : overBudget ? "change_budget_exceeded" : undefined,
	};
}

function label(node: SerializedOutlineNode): string {
	return node.title || node.description || node.value || node.identifier || node.text.map((item) => item.string).join(" ").trim() || node.role || "node";
}

export function renderChanges(changes: OutlineChange[]): string {
	return changes.map((change) => {
		if (change.type === "added") return `+ ${change.ref}${change.parent ? ` under ${change.parent}` : ""} ${JSON.stringify(label(change.node))}`;
		if (change.type === "removed") return `- ${change.ref}${change.parent ? ` from ${change.parent}` : ""}`;
		const fields = Object.entries(change.fields).filter(([key]) => !["rect", "text", "actions"].includes(key)).slice(0, 6).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
		const supplemental = [
			change.fields.text ? `text=${JSON.stringify(change.fields.text.map((item) => item.string))}` : undefined,
			change.fields.actions ? `actions=${JSON.stringify(change.fields.actions)}` : undefined,
		].filter(Boolean).join(", ");
		return `~ ${change.ref} (${change.path.join(" > ")}) ${[fields, supplemental].filter(Boolean).join(", ") || "changed"}`;
	}).join("\n");
}
