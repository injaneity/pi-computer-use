// Jev's atomic DOM snapshot, rewritten in TypeScript for pi-computer-use
// (originally ported from jev-ultrafast/jev_ultrafast/snapshot.js).
//
// One evaluate reads visible controls, their names, values, and text; the
// WeakMap gives every real DOM node a code-owned identity so the executor can
// resolve an observed action without model-supplied selectors.
//
// The snapshot runs inside the controlled page, not in Node: `jevSnapshotSource`
// serializes `jevSnapshot` through Function.prototype.toString and the driver
// evaluates that string over CDP. That function must therefore stay
// self-contained — no imports, no module-scope values, no transpiler helpers
// that assume a runtime. Type annotations are erased before serialization, so
// the in-page body stays identical JavaScript to what ran before.

/** In-page identity cache attached to `window.__jevFast`. */
interface JevNodeCache {
	ids: WeakMap<Element, number>;
	nodes: Map<number, Element>;
	next: number;
	/** Semantic page key: form-field identity and (masked) state, for freshness. */
	pageKey: () => unknown[];
	/** Per-node guard tuple compared between observation and execution. */
	guard: (element: Element | undefined) => unknown[] | null;
}

type SnapshotWindow = Window & { __jevFast?: JevNodeCache };

/** Geometry kept out of the semantic payload; resolved again before each input. */
interface JevSnapshotRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface JevSnapshotBaseAction {
	node: number;
	role: string;
	label: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	rect?: JevSnapshotRect;
}

interface JevSnapshotAction {
	id?: string;
	kind: "click" | "fill" | "select" | "scroll" | "wait";
	label: string;
	node?: number;
	role?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	value?: string;
	current_value?: string;
	delta?: number;
	rect?: JevSnapshotRect;
}

/** What the in-page snapshot returns; `parseJevPage` in space.ts validates the shape. */
export interface JevSnapshotPage {
	url: string;
	title: string;
	w: number;
	h: number;
	text: string;
	scroll: { y: number; height: number };
	actions: JevSnapshotAction[];
	marker: unknown;
	page_key: unknown;
	guards: Record<string, unknown>;
	omitted_actions: number;
}

/**
 * The snapshot itself. Executed verbatim in the controlled page, so every
 * helper it needs is declared inside. Returns null before the document body
 * exists; navigation surfaces as an in-page exception to the driver.
 */
function jevSnapshot(): JevSnapshotPage | null {
	if (!document.body) return null;
	// Constant tables live inside the function: the body is serialized verbatim
	// into the page, so it cannot reference module-scope values.
	const ROLE_NAMES: string[] = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"];
	const TEXT_INPUT_TYPES: string[] = ["text", "email", "url", "tel", "password"];
	const BUTTON_INPUT_TYPES: string[] = ["button", "submit", "reset", "image"];
	const STATE_KEYS = ["checked", "selected", "expanded"] as const;
	const cache = ((window as SnapshotWindow).__jevFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 } as JevNodeCache);
	const identity = (e: Element): number => {
		if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
		const id = cache.ids.get(e) as number;
		cache.nodes.set(id, e);
		return id;
	};
	for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
	// pi-computer-use integration decision: unlike upstream jev-ultrafast, password
	// fields stay observable and fillable so login forms are automatable. Their
	// value is never exposed — it is masked in the action table, guards, and the
	// page key, so the model and the agent only ever see an empty value.
	const typeOf = (e: Element): string => (e as HTMLInputElement | HTMLSelectElement).type ?? "";
	const safe = (e: Element): boolean => !["file", "hidden"].includes(typeOf(e));
	const secret = (e: Element): boolean => typeOf(e) === "password";
	const fieldValue = (e: Element): string | null => (secret(e) ? null : ((e as HTMLInputElement).value ?? null));
	const visible = (e: Element): boolean =>
		!e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
	const name = (e: Element | null, seen: Set<Element> = new Set()): string => {
		if (!e || seen.has(e)) return "";
		seen.add(e);
		const referenced = (e.getAttribute("aria-labelledby") || "").split(/\s+/)
			.map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(" ");
		const labels = (e as HTMLInputElement).labels;
		return referenced || e.getAttribute("aria-label") ||
			[...(labels || [])].map((l) => name(l, seen)).filter(Boolean).join(" ") ||
			(["button", "submit", "reset"].includes(typeOf(e)) ? (e as HTMLInputElement).value : "") ||
			e.getAttribute("alt") ||
			(e.tagName === "INPUT" ? "" : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
				n.nodeType === 1 && (n as Element).getAttribute("aria-hidden") !== "true" ? name(n as Element, seen) : "").join(" ").trim()) ||
			e.getAttribute("title") || e.getAttribute("placeholder") || "";
	};
	const selector = "a[href],button,input,textarea,select,summary,[contenteditable=\"true\"]," +
		ROLE_NAMES.map((r) => `[role="${r}"]`).join(",");
	const role = (e: Element): string | null => {
		const explicit = e.getAttribute("role");
		if (explicit !== null && ROLE_NAMES.includes(explicit)) return explicit;
		if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
		if (e.tagName === "A") return "link";
		if (e.tagName === "SELECT") return "combobox";
		if (e.tagName === "TEXTAREA" || (e as HTMLElement).isContentEditable) return "textbox";
		if (e.tagName === "INPUT") {
			const type = typeOf(e);
			if (["checkbox", "radio"].includes(type)) return type;
			if (BUTTON_INPUT_TYPES.includes(type)) return "button";
			if (type === "search") return "searchbox";
			if (type === "number") return "spinbutton";
			if (TEXT_INPUT_TYPES.includes(type)) return "textbox";
		}
		return null;
	};
	cache.pageKey = (): unknown[] => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
		[...document.querySelectorAll("input,textarea,select")].filter(safe)
			.map((e) => [identity(e), fieldValue(e), (e as HTMLInputElement).checked, (e as HTMLSelectElement).selectedIndex, (e as HTMLInputElement).disabled, (e as HTMLInputElement).readOnly])];
	cache.guard = (e: Element | undefined): unknown[] | null => {
		if (!e?.isConnected || !visible(e)) return null;
		const scope = e.closest("form,dialog,[role=\"dialog\"],article,li,tr,[role=\"row\"]") || e.parentElement;
		return [identity(e), role(e), name(e), fieldValue(e), (e as HTMLInputElement).checked ?? null,
			(e as HTMLSelectElement).selectedIndex ?? null, (e as HTMLInputElement).readOnly ?? null,
			e.matches(":disabled"), e.getAttribute("aria-disabled"),
			e.getAttribute("aria-expanded"), e.getAttribute("aria-checked"), e.getAttribute("aria-selected"),
			e.getAttribute("href"), (scope as HTMLElement | null)?.innerText?.slice(0, 6000) || ""];
	};
	const actions: JevSnapshotAction[] = [];
	for (const e of document.querySelectorAll(selector)) {
		if (!safe(e) || !visible(e) || e.matches(":disabled") || e.closest('[aria-disabled="true"]')) continue;
		const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
		if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
		if (rname === "gridcell" && e.querySelector("button,[role=\"button\"]")) continue;
		const base: JevSnapshotBaseAction = {
			node: identity(e),
			role: rname,
			label: name(e) || rname,
			rect: { x: r.x, y: r.y, w: r.width, h: r.height },
		};
		for (const key of STATE_KEYS) {
			const value = e.getAttribute("aria-" + key);
			if (value !== null) base[key] = value;
		}
		if (["checkbox", "radio"].includes(typeOf(e))) base.checked = String((e as HTMLInputElement).checked);
		if (e.tagName === "SELECT") {
			const select = e as HTMLSelectElement;
			for (const o of select.options) if (!o.selected && !o.disabled && !o.closest("optgroup[disabled]")) {
				actions.push({
					...base, kind: "select", value: o.value,
					current_value: [...select.selectedOptions].map((o) => o.label).join(", "),
					label: base.label + " → " + o.label,
				});
			}
		} else {
			const editable = !(e as HTMLInputElement).readOnly && e.getAttribute("aria-readonly") !== "true" &&
				(["textbox", "searchbox", "spinbutton"].includes(rname) ||
					(rname === "combobox" && ["INPUT", "TEXTAREA"].includes(e.tagName)));
			const value = secret(e) ? "" :
				"value" in e ? String((e as HTMLInputElement).value) :
				(e as HTMLElement).isContentEditable || rname === "combobox" ? (e as HTMLElement).innerText.trim() : "";
			actions.push({ ...base, kind: editable ? "fill" : "click", value });
			if (editable) actions.push({ ...base, kind: "click", value, label: "Open " + base.label });
		}
	}
	const words: string[] = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	let node: Node | null, length = 0;
	while ((node = walker.nextNode()) !== null && length < 6000) {
		const value = (node.textContent ?? "").trim(), parent = node.parentElement;
		if (!value || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
		range.selectNodeContents(node);
		const r = range.getBoundingClientRect();
		if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
			words.push(value);
			length += value.length;
		}
	}
	const text = words.join("\n").slice(0, 6000), height = document.documentElement.scrollHeight;
	const page_key = cache.pageKey();
	const guards: Record<string, unknown> = {};
	for (const a of actions) if (typeof a.node === "number" && !(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
	// Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
	const semantics = actions.map(({ rect: _rect, ...action }) => action);
	const marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
		document.title, text, semantics, page_key[6]];
	const omitted_actions = Math.max(0, actions.length - 250);
	actions.splice(250);
	actions.forEach((a, i) => { a.id = "e" + (i + 1); });
	if (scrollY + innerHeight < height - 2) actions.push({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 });
	if (scrollY > 0) actions.push({ id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 });
	actions.push({ id: "wait", kind: "wait", label: "Wait for the page to update" });
	return {
		url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
		scroll: { y: scrollY, height }, actions, marker, page_key, guards, omitted_actions,
	};
}

/**
 * Serialize the snapshot for evaluation in the controlled page. The function
 * must not close over module scope: its compiled source is executed verbatim
 * in the page, so it stays a pure in-page closure.
 */
export function jevSnapshotSource(): string {
	return `(${jevSnapshot.toString()})()`;
}
