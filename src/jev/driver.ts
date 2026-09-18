import type { CdpTab } from "../cdp.ts";
import { jevSnapshotSource } from "./snapshot.ts";
import { parseJevPage } from "./space.ts";
import type { JevElement, JevRawAction, JevRawPage, JevSpace } from "./types.ts";

const JEV_SNAPSHOT_SCRIPT = jevSnapshotSource();
const OBSERVE_TIMEOUT_MS = 15_000;

/** A decision no longer refers to the observed page. */
export class JevStalePage extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevStalePage";
	}
}

export interface JevObservation {
	page: JevRawPage;
	elements: JevElement[];
	space: JevSpace;
}

function expression(script: string): string {
	return `(() => { const state = ${script}; return state?.marker ?? null; })()`;
}

export function markerExpression(): string {
	return expression(JEV_SNAPSHOT_SCRIPT);
}

export function guardExpression(node: number): string {
	return `(() => { const c = window.__jevFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${JSON.stringify(node)}))] : null; })()`;
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** Wheel input lands at the viewport center so small viewports still receive it. */
async function viewportCenter(tab: CdpTab): Promise<{ x: number; y: number }> {
	try {
		const point = await tab.evaluate("[Math.floor(innerWidth / 2), Math.floor(innerHeight / 2)]");
		if (Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
			return { x: Number(point[0]), y: Number(point[1]) };
		}
	} catch {
		// Fall back to the historical point when the page cannot answer.
	}
	return { x: 550, y: 650 };
}
/** One atomic browser read builds the indexed action space. */
export async function observeJevPage(tab: CdpTab, context: { contextId: string; targetId: string }): Promise<JevObservation> {
	// A transport failure is a real error, not staleness: let it propagate.
	// Navigation surfaces as an in-page exception or a null value.
	const result = await tab.evaluateStrict(JEV_SNAPSHOT_SCRIPT, { awaitPromise: true, timeoutMs: OBSERVE_TIMEOUT_MS });
	if (result.exception) throw new JevStalePage("Document changed during observation");
	if (result.value === null || result.value === undefined) throw new JevStalePage("Document is navigating");
	return parseJevPage(context, result.value);
}

/**
 * Full semantic freshness, used for completion choices. It compares the whole
 * document marker rather than one target's guard.
 */
export async function jevFreshMarker(tab: CdpTab, page: JevRawPage): Promise<boolean> {
	const current = await tab.evaluate(markerExpression(), OBSERVE_TIMEOUT_MS);
	return equal(current, page.marker);
}

/**
 * Click and select targets are checked against the full semantic page key and
 * the target's own guard. Other operations use the cheaper document marker.
 */
export async function jevFreshForAction(tab: CdpTab, page: JevRawPage, action: JevRawAction): Promise<boolean> {
	if ((action.kind === "click" || action.kind === "select") && typeof action.node === "number") {
		const current = await tab.evaluate(guardExpression(action.node), OBSERVE_TIMEOUT_MS);
		return equal(current, [page.page_key, page.guards[String(action.node)]]);
	}
	const current = await tab.evaluate(markerExpression(), OBSERVE_TIMEOUT_MS);
	return equal(current, page.marker);
}

/**
 * Resolve an observed node, re-check enabled state, visibility, geometry, and
 * click occlusion, and perform a native select. Returns the current center for
 * pointer delivery, or null when the target must be re-observed. Model output
 * never becomes a selector, coordinate, or script.
 */
async function resolveAndMutate(tab: CdpTab, action: JevRawAction): Promise<{ x: number; y: number } | null> {
	const result = await tab.evaluateStrict(`(action => {
  const e = window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
  const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x, y))) return null;
  if (action.kind === 'select') {
    if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value = action.value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { x, y };
})(${JSON.stringify(action)})`);
	if (result.exception) {
		if (action.kind === "select") throw new Error("Dropdown execution was interrupted; inspect before retrying.");
		throw new JevStalePage("Document changed during evaluation");
	}
	const point = result.value as { x: number; y: number } | null;
	return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

/**
 * Execute one observed action. A mutation is never retried: callers must
 * observe and decide again after any failure. Text is required for fill.
 */
export async function executeJevAction(tab: CdpTab, action: JevRawAction, text?: string): Promise<void> {
	if (action.kind === "wait") {
		await new Promise((resolve) => setTimeout(resolve, 100));
		return;
	}
	if (action.kind === "scroll") {
		await tab.wheel(0, typeof action.delta === "number" ? action.delta : 0, await viewportCenter(tab));
		return;
	}
	const point = await resolveAndMutate(tab, action);
	if (point === null) {
		if (action.kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
		throw new JevStalePage("Target changed or is covered. Observe again.");
	}
	if (action.kind !== "select") {
		await tab.mouseAt(point.x, point.y, "mousePressed", "left", 1);
		await tab.mouseAt(point.x, point.y, "mouseReleased", "left", 1);
		if (action.kind === "fill") {
			if (typeof text !== "string") throw new Error("TYPE_TEXT requires a generated or supplied value.");
			await tab.fillFocused(text);
		}
	}
}

/**
 * Read-only settle after an interaction, logged after execution. Editable ARIA
 * comboboxes wait for visible options, capped at 200 ms; everything else waits
 * at most two animation frames or 50 ms.
 */
export async function settleAfterJevInput(tab: CdpTab, action: JevRawAction): Promise<void> {
	if (action.kind === "wait" || action.kind === "scroll") return;
	try {
		await tab.evaluateStrict(`(action => new Promise(resolve => {
  const field = window.__jevFast?.nodes.get(action.node);
  const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
  let frames = 0, stopped = false;
  const finish = () => { stopped = true; resolve(); };
  setTimeout(finish, autocomplete ? 200 : 50);
  const ready = () => {
    if (stopped) return;
    const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '').split(/\\s+/).filter(Boolean);
    const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
    const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
    if (++frames >= 2 && (!autocomplete || options.some(e => {
      const r = e.getBoundingClientRect();
      return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))(${JSON.stringify(action)})`, { awaitPromise: true, timeoutMs: 2_000 });
	} catch {
		// A navigation can interrupt the settle read; the action itself already ran.
	}
}
