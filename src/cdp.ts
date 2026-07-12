// Minimal Chrome DevTools Protocol client.
//
// Opt-in: set PI_COMPUTER_USE_CDP_PORT to the --remote-debugging-port of a
// running Chromium-family browser. When active, navigate_browser uses
// Page.navigate (event-driven, no AppleScript) and recent console messages
// and uncaught exceptions are attached to tool results. Everything else
// keeps the AX/CGEvent path, so with the env var unset this module is inert.

import { randomUUID } from "node:crypto";
import { parseLookResponse, serializeOutline, type SerializedOutline } from "./outline.ts";

export interface CdpConsoleEntry {
	level: string;
	text: string;
}

export interface CdpPageContext {
	contextId: string;
	targetId: string;
	title: string;
	url: string;
}

export interface CdpSnapshotTarget {
	ref: string;
	source: "browser_ax";
	role: string;
	name: string;
	value?: string;
	actions: string[];
	backendNodeId?: number;
}

export interface CdpPageSnapshot {
	contextId: string;
	snapshotId: string;
	targetId: string;
	title: string;
	url: string;
	capturedAt: number;
	text: string;
	targets: CdpSnapshotTarget[];
	outline: SerializedOutline;
	diagnostics: {
		cdp: "connected";
		targetCount: number;
	};
}

export interface CdpEvaluationResult {
	contextId: string;
	value: unknown;
}

/** Window frame in screen points, as reported by the AX side. */
export interface WindowFrame {
	x: number;
	y: number;
	w: number;
	h: number;
}

const COMMAND_TIMEOUT_MS = 5_000;
const CDP_CONTEXT_PREFIX = "browser:";
const NAVIGATE_LOAD_TIMEOUT_MS = 10_000;
const CONNECT_FAILURE_RETRY_MS = 5_000;
const CONSOLE_BUFFER_LIMIT = 20;

export class CdpTab {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
	private consoleBuffer: CdpConsoleEntry[] = [];
	private loadFired: (() => void) | undefined;

	private constructor(
		private readonly ws: WebSocket,
		readonly targetId: string,
		public title: string,
	) {}

	static async connect(wsUrl: string, targetId: string, title: string): Promise<CdpTab> {
		const ws = new WebSocket(wsUrl);
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Timed out connecting to CDP target at ${wsUrl}`)), COMMAND_TIMEOUT_MS);
				ws.onopen = () => {
					clearTimeout(timer);
					resolve();
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error(`Failed to connect to CDP target at ${wsUrl}`));
				};
			});

			const tab = new CdpTab(ws, targetId, title);
			ws.onmessage = (event) => tab.handleMessage(String(event.data));
			ws.onclose = () => tab.rejectAllPending(new Error("CDP connection closed."));
			ws.onerror = () => tab.rejectAllPending(new Error("CDP connection error."));
			await tab.send("Runtime.enable");
			await tab.send("Page.enable");
			return tab;
		} catch (error) {
			try {
				ws.close();
			} catch {
				// already closed
			}
			throw error;
		}
	}

	get isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.loadFired?.();
		this.loadFired = undefined;
		this.rejectAllPending(new Error("CDP connection closed."));
		try {
			this.ws.close();
		} catch {
			// already closed
		}
	}

	/** Evaluates a JS expression in the page and returns its primitive value. */
	async evaluate(expression: string): Promise<unknown> {
		const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
		return result?.result?.value;
	}

	async accessibilityTree(): Promise<unknown[]> {
		const result = await this.send("Accessibility.getFullAXTree");
		return Array.isArray(result?.nodes) ? result.nodes : [];
	}

	async navigate(url: string): Promise<void> {
		const loaded = new Promise<void>((resolve) => {
			this.loadFired = resolve;
		});
		try {
			await this.send("Page.navigate", { url });
			// SPAs and slow pages may never fire load; cap the wait and move on.
			await Promise.race([loaded, new Promise<void>((resolve) => setTimeout(resolve, NAVIGATE_LOAD_TIMEOUT_MS))]);
		} finally {
			this.loadFired = undefined;
		}
	}

	async clickBackendNode(backendNodeId: number): Promise<void> {
		await this.withBackendNode(backendNodeId, "function(){ this.scrollIntoView({block:'center', inline:'center'}); this.click(); }");
	}

	async typeIntoBackendNode(backendNodeId: number, text: string, replace: boolean): Promise<void> {
		await this.withBackendNode(backendNodeId, "function(text, replace){ this.scrollIntoView({block:'center', inline:'center'}); this.focus(); if (replace) { if ('value' in this) this.value = ''; else this.textContent = ''; } if ('value' in this) this.value += text; else this.textContent = (this.textContent || '') + text; this.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text})); this.dispatchEvent(new Event('change', {bubbles:true})); }", [text, replace]);
	}

	async scrollBy(deltaX: number, deltaY: number, backendNodeId?: number): Promise<void> {
		if (backendNodeId) {
			await this.withBackendNode(backendNodeId, "function(dx, dy){ this.scrollIntoView({block:'center', inline:'center'}); this.scrollBy(dx, dy); }", [deltaX, deltaY]);
			return;
		}
		await this.send("Runtime.evaluate", { expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})` });
	}

	private async withBackendNode(backendNodeId: number, functionDeclaration: string, args: unknown[] = []): Promise<void> {
		const resolved = await this.send("DOM.resolveNode", { backendNodeId });
		const objectId = resolved?.object?.objectId;
		if (typeof objectId !== "string") throw new Error(`CDP could not resolve backend node ${backendNodeId}.`);
		await this.send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration,
			arguments: args.map((value) => ({ value })),
		});
	}

	/** Screen bounds of the browser window containing this tab. */
	async windowBounds(): Promise<WindowFrame | undefined> {
		const result = await this.send("Browser.getWindowForTarget", { targetId: this.targetId });
		const bounds = result?.bounds;
		if (typeof bounds?.left !== "number" || typeof bounds?.width !== "number") return undefined;
		return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
	}

	/** Returns buffered console messages/exceptions and clears the buffer. */
	drainConsole(): CdpConsoleEntry[] {
		const entries = this.consoleBuffer;
		this.consoleBuffer = [];
		return entries;
	}

	private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP command '${method}' timed out after ${COMMAND_TIMEOUT_MS}ms.`));
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.ws.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleMessage(raw: string): void {
		let message: any;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(`CDP error: ${message.error.message ?? "unknown"}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		switch (message.method) {
			case "Page.loadEventFired":
				this.loadFired?.();
				break;
			case "Runtime.consoleAPICalled": {
				const args = Array.isArray(message.params?.args) ? message.params.args : [];
				const text = args
					.map((arg: any) => (arg?.value !== undefined ? String(arg.value) : (arg?.description ?? "")))
					.filter(Boolean)
					.join(" ");
				this.pushConsole({ level: String(message.params?.type ?? "log"), text });
				break;
			}
			case "Runtime.exceptionThrown": {
				const details = message.params?.exceptionDetails;
				const text = details?.exception?.description ?? details?.text ?? "Uncaught exception";
				this.pushConsole({ level: "exception", text: String(text) });
				break;
			}
		}
	}

	private pushConsole(entry: CdpConsoleEntry): void {
		if (!entry.text) return;
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
			this.consoleBuffer.shift();
		}
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

const connectedTabs = new Map<string, CdpTab>();
const connectingTabs = new Map<string, Promise<CdpTab>>();
let lastConnectFailureAt = 0;

/** Close session-owned CDP state without affecting the browser process. */
export function disconnectCdp(): void {
	for (const tab of connectedTabs.values()) tab.close();
	connectedTabs.clear();
	connectingTabs.clear();
	lastConnectFailureAt = 0;
}

function cdpEnabled(): boolean {
	const rawPort = process.env.PI_COMPUTER_USE_CDP_PORT ?? "";
	if (!/^\d+$/.test(rawPort)) return false;
	const port = Number(rawPort);
	return Number.isInteger(port) && port > 0 && port <= 65535 && typeof WebSocket !== "undefined";
}

/**
 * Returns a CDP connection to the tab matching the controlled window's title
 * (and, when provided, the window's screen frame), or undefined when CDP is
 * disabled, unreachable, or no tab matches. Reuses the cached connection
 * while it still matches; failures are cached briefly so an unreachable
 * endpoint never adds per-call latency.
 */
export async function cdpTabForWindow(windowTitle: string, frame?: WindowFrame): Promise<CdpTab | undefined> {
	if (!cdpEnabled()) return undefined;
	if (Date.now() - lastConnectFailureAt < CONNECT_FAILURE_RETRY_MS) return undefined;

	for (const tab of connectedTabs.values()) {
		if (tab.isOpen && titlesMatch(tab.title, windowTitle) && (await tabMatchesFrame(tab, frame))) return tab;
	}

	try {
		const pages = await cdpPages();
		const match = await pickTab(pages, windowTitle, frame);
		if (!match) return undefined;

		const existing = connectedTabs.get(match.id);
		if (existing?.isOpen) {
			existing.title = match.title;
			return existing;
		}
		let connecting = connectingTabs.get(match.id);
		if (!connecting) {
			connecting = CdpTab.connect(match.webSocketDebuggerUrl!, match.id, match.title);
			connectingTabs.set(match.id, connecting);
		}
		let connected: CdpTab;
		try {
			connected = await connecting;
		} finally {
			connectingTabs.delete(match.id);
		}
		connectedTabs.set(match.id, connected);
		return connected;
	} catch {
		lastConnectFailureAt = Date.now();
		return undefined;
	}
}

interface CdpPageTarget {
	id: string;
	type: string;
	title: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export async function listCdpPageContexts(): Promise<CdpPageContext[]> {
	const pages = await cdpPages();
	return pages.map((page) => ({
		contextId: cdpContextId(page.id),
		targetId: page.id,
		title: page.title,
		url: page.url ?? "",
	}));
}

export async function cdpClickForContext(contextId: string, backendNodeId: number): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.clickBackendNode(backendNodeId);
		return true;
	})) === true;
}

export async function cdpTypeForContext(contextId: string, backendNodeId: number, text: string, replace: boolean): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.typeIntoBackendNode(backendNodeId, text, replace);
		return true;
	})) === true;
}

export async function cdpScrollForContext(contextId: string, deltaX: number, deltaY: number, backendNodeId?: number): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.scrollBy(deltaX, deltaY, backendNodeId);
		return true;
	})) === true;
}

export async function cdpNavigateContext(contextId: string, url: string): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.navigate(url);
		return true;
	})) === true;
}

export async function cdpEvaluateForContext(contextId: string, expression: string): Promise<CdpEvaluationResult | undefined> {
	const page = await cdpPageForContext(contextId);
	if (!page?.webSocketDebuggerUrl) return undefined;
	const tab = await CdpTab.connect(page.webSocketDebuggerUrl, page.id, page.title);
	try {
		return { contextId, value: await tab.evaluate(expression) };
	} finally {
		tab.close();
	}
}

export async function cdpSnapshotForContext(contextId: string): Promise<CdpPageSnapshot | undefined> {
	const page = await cdpPageForContext(contextId);
	if (!page?.webSocketDebuggerUrl) return undefined;

	const tab = await CdpTab.connect(page.webSocketDebuggerUrl, page.id, page.title);
	try {
		const [textValue, nodes] = await Promise.all([
			tab.evaluate("document.body ? document.body.innerText : ''").catch(() => ""),
			tab.accessibilityTree().catch(() => []),
		]);
		const snapshotId = randomUUID();
		const { targets, outline } = cdpSnapshotOutline(snapshotId, nodes);
		return {
			contextId,
			snapshotId,
			targetId: page.id,
			title: page.title,
			url: page.url ?? "",
			capturedAt: Date.now(),
			text: typeof textValue === "string" ? textValue : String(textValue ?? ""),
			targets,
			outline,
			diagnostics: { cdp: "connected", targetCount: targets.length },
		};
	} finally {
		tab.close();
	}
}

async function withCdpContextTab<T>(contextId: string, run: (tab: CdpTab) => Promise<T>): Promise<T | undefined> {
	const page = await cdpPageForContext(contextId);
	if (!page?.webSocketDebuggerUrl) return undefined;
	const tab = await CdpTab.connect(page.webSocketDebuggerUrl, page.id, page.title);
	try {
		return await run(tab);
	} finally {
		tab.close();
	}
}

async function cdpPageForContext(contextId: string): Promise<CdpPageTarget | undefined> {
	if (!contextId.startsWith(CDP_CONTEXT_PREFIX)) return undefined;
	const targetId = contextId.slice(CDP_CONTEXT_PREFIX.length);
	const pages = await cdpPages();
	return pages.find((candidate) => candidate.id === targetId);
}

async function cdpPages(): Promise<CdpPageTarget[]> {
	if (!cdpEnabled()) return [];
	const port = process.env.PI_COMPUTER_USE_CDP_PORT;
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
	const targets = (await response.json()) as CdpPageTarget[];
	return targets.filter((target) =>
		target.type === "page" && target.webSocketDebuggerUrl && isLocalDebuggerWebSocket(target.webSocketDebuggerUrl, port),
	);
}

function cdpContextId(targetId: string): string {
	return `${CDP_CONTEXT_PREFIX}${targetId}`;
}

function axString(raw: any): string {
	const value = raw?.value ?? raw;
	return typeof value === "string" ? value.trim() : "";
}

function cdpSnapshotOutline(snapshotId: string, nodes: unknown[]): { targets: CdpSnapshotTarget[]; outline: SerializedOutline } {
	const records = new Map<string, any>();
	for (const raw of nodes as any[]) {
		const nodeId = String(raw?.nodeId ?? "");
		if (nodeId) records.set(nodeId, raw);
	}
	const targets: CdpSnapshotTarget[] = [];
	const build = (raw: any, seen: Set<string>): any => {
		const nodeId = String(raw?.nodeId ?? randomUUID());
		if (seen.has(nodeId)) return undefined;
		seen.add(nodeId);
		const role = axString(raw?.role);
		const name = axString(raw?.name);
		const actions = browserActionsForAxRole(role);
		const backendNodeId = Number.isFinite(raw?.backendDOMNodeId) ? Math.trunc(raw.backendDOMNodeId) : undefined;
		const wireRef = `cdp:${nodeId}`;
		if (actions.length > 0 && name && (!actions.includes("click") || backendNodeId)) {
			targets.push({ ref: wireRef, source: "browser_ax", role, name, value: axString(raw?.value) || undefined, actions, backendNodeId });
		}
		const childIds: string[] = Array.isArray(raw?.childIds) ? raw.childIds.map(String) : [];
		return {
			ref: wireRef,
			role,
			subrole: "",
			identifier: "",
			title: name,
			description: axString(raw?.description),
			value: axString(raw?.value),
			actions,
			canPress: actions.includes("click"),
			canFocus: actions.length > 0,
			canSetValue: actions.includes("set_text"),
			canScroll: false,
			canIncrement: false,
			canDecrement: false,
			isTextInput: actions.includes("set_text"),
			rect: { x: 0, y: 0, w: 0, h: 0 },
			children: childIds.map((id: string) => records.get(id)).filter(Boolean).map((child: any) => build(child, seen)).filter(Boolean),
		};
	};
	const roots = (nodes as any[]).filter((raw) => !raw?.parentId || !records.has(String(raw.parentId)));
	const children = roots.map((root) => build(root, new Set())).filter(Boolean);
	const rawOutline = children.length === 1 ? children[0] : {
		ref: `cdp:root:${snapshotId}`,
		role: "document",
		subrole: "",
		identifier: "",
		title: "Browser page",
		description: "",
		value: "",
		actions: [],
		canPress: false,
		canFocus: false,
		canSetValue: false,
		canScroll: false,
		canIncrement: false,
		canDecrement: false,
		isTextInput: false,
		rect: { x: 0, y: 0, w: 0, h: 0 },
		children,
	};
	const parsed = parseLookResponse({
		lookId: snapshotId,
		capturedAt: Date.now() / 1000,
		window: { windowId: 0, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "document", subrole: "" },
		outline: rawOutline,
		timings: {},
	}).parsedOutline!;
	const modelRefByWire = parsed.wireRefToRef;
	for (const target of targets) target.ref = modelRefByWire.get(target.ref) ?? target.ref;
	return { targets, outline: serializeOutline(parsed) };
}

function browserActionsForAxRole(role: string): string[] {
	const normalized = role.toLowerCase();
	if (["button", "link", "checkbox", "radio", "menuitem", "tab"].includes(normalized)) return ["click"];
	if (["textbox", "searchbox", "combobox"].includes(normalized)) return ["click", "set_text"];
	if (["listbox", "slider", "spinbutton"].includes(normalized)) return ["click"];
	return [];
}

function isLocalDebuggerWebSocket(wsUrl: string, expectedPort: string | undefined): boolean {
	try {
		const parsed = new URL(wsUrl);
		const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
		return (parsed.protocol === "ws:" || parsed.protocol === "wss:") && localHosts.has(parsed.hostname) && parsed.port === expectedPort;
	} catch {
		return false;
	}
}

/**
 * Picks the tab for a window title. Disambiguation order, applied only while
 * more than one candidate remains:
 *   1. exact title matches beat prefix matches;
 *   2. the tab whose browser window frame matches the controlled window
 *      (separates same-titled tabs in different windows);
 *   3. the visible tab (separates same-titled tabs in one window — the
 *      active tab is "visible", background tabs are "hidden").
 * /json/list ordering is never trusted; it is an undocumented MRU detail.
 */
async function pickTab(pages: CdpPageTarget[], windowTitle: string, frame?: WindowFrame): Promise<CdpPageTarget | undefined> {
	const matches = pages.filter((target) => titlesMatch(target.title, windowTitle));
	if (matches.length === 0) return pages.length === 1 ? pages[0] : undefined;
	if (matches.length === 1) return matches[0];

	const wanted = windowTitle.trim().toLowerCase();
	const exact = matches.filter((target) => target.title.trim().toLowerCase() === wanted);
	const pool = exact.length > 0 ? exact : matches;
	if (pool.length === 1) return pool[0];

	let visibleFallback: CdpPageTarget | undefined;
	for (const candidate of pool) {
		try {
			const tab = await CdpTab.connect(candidate.webSocketDebuggerUrl!, candidate.id, candidate.title);
			const inFrame = await tabMatchesFrame(tab, frame, false);
			const visibility = await tab.evaluate("document.visibilityState").catch(() => undefined);
			tab.close();
			if (frame && inFrame && visibility === "visible") return candidate;
			if (frame && inFrame && !visibleFallback) visibleFallback = candidate;
			if (!frame && visibility === "visible") return candidate;
		} catch {
			// candidate unreachable; try the next one
		}
	}
	return visibleFallback ?? pool[0];
}

/**
 * Whether the tab's browser window frame matches the AX window frame.
 * `trustOnUnknown` controls the answer when bounds cannot be read: cache
 * verification trusts the existing connection, candidate selection does not.
 */
async function tabMatchesFrame(tab: CdpTab, frame: WindowFrame | undefined, trustOnUnknown = true): Promise<boolean> {
	if (!frame) return true;
	const bounds = await tab.windowBounds().catch(() => undefined);
	if (!bounds) return trustOnUnknown;
	const tolerance = 50;
	return (
		Math.abs(bounds.x + bounds.w / 2 - (frame.x + frame.w / 2)) <= tolerance &&
		Math.abs(bounds.y + bounds.h / 2 - (frame.y + frame.h / 2)) <= tolerance
	);
}

// The AX window title for a Chrome-family browser is usually the active tab
// title, sometimes suffixed (" - Google Chrome", profile name), so compare
// by prefix in both directions.
function titlesMatch(tabTitle: string, windowTitle: string): boolean {
	const tab = tabTitle.trim().toLowerCase();
	const win = windowTitle.trim().toLowerCase();
	if (!tab || !win) return false;
	return tab === win || win.startsWith(tab) || tab.startsWith(win);
}
