import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ensureComputerUseSetup,
	executeAct,
	executeEvaluateBrowser,
	executeExpandUi,
	executeInspectUi,
	executeLaunchBrowser,
	executeFind,
	executeNavigateBrowser,
	executeObserve,
	executeReadText,
	executeSearchUi,
	executeWaitFor,
	reconstructStateFromBranch,
	shutdownComputerUseSession,
} from "../src/bridge.ts";
import { getLoadedComputerUseConfig, loadComputerUseConfig } from "../src/config.ts";

const stateId = Type.String({ description: "Required state id owning every @e ref used by this operation" });
const root = Type.Optional(Type.String({ description: "Root ref from find_roots, e.g. @r1" }));
const image = Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("never")], { description: "Image attachment mode, default auto" }));
const refTarget = { ref: Type.Optional(Type.String({ description: "Outline ref, e.g. @e12" })), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) };
const mouseButton = Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]));
const uiAction = Type.Union([
	Type.Object({ action: Type.Literal("press"), ...refTarget }),
	Type.Object({ action: Type.Literal("click"), ...refTarget, button: mouseButton, clickCount: Type.Optional(Type.Number()) }),
	Type.Object({ action: Type.Literal("doubleClick"), ...refTarget, button: mouseButton }),
	Type.Object({ action: Type.Literal("setText"), ref: Type.String({ description: "Editable outline ref" }), text: Type.String() }),
	Type.Object({ action: Type.Literal("typeText"), ref: Type.Optional(Type.String({ description: "Omit after a click to type into the focus established by that click" })), text: Type.String() }),
	Type.Object({ action: Type.Literal("keypress"), ref: Type.Optional(Type.String({ description: "Omit to send keys to the focused control" })), keys: Type.Array(Type.String(), { minItems: 1 }) }),
	Type.Object({ action: Type.Literal("scroll"), ...refTarget, scrollX: Type.Optional(Type.Number()), scrollY: Type.Optional(Type.Number()) }),
	Type.Object({ action: Type.Literal("drag"), path: Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), { minItems: 2 }) }),
	Type.Object({ action: Type.Literal("moveMouse"), ...refTarget }),
	Type.Object({ action: Type.Literal("wait"), ms: Type.Number() }),
]);

const findTool = defineTool({
	name: "find_roots",
	label: "Find Roots",
	description: "Find controllable UI roots with refs, geometry, and focus state.",
	promptSnippet: "Find a target root before observe_ui when needed.",
	parameters: Type.Object({
		query: Type.Optional(Type.String({ description: "Optional app/title/menu label query; absent or unmatched returns all roots" })),
		app: Type.Optional(Type.String({ description: "Optional app-name narrowing filter" })),
		bundleId: Type.Optional(Type.String({ description: "Optional bundle-id narrowing filter" })),
		pid: Type.Optional(Type.Number({ description: "Optional process-id narrowing filter" })),
		kind: Type.Optional(Type.Union([Type.Literal("window"), Type.Literal("menu"), Type.Literal("sheet"), Type.Literal("popover"), Type.Literal("dialog"), Type.Literal("browser_page")], { description: "Optional root kind narrowing filter" })),
	}),
	execute: executeFind,
});

const observeTool = defineTool({
	name: "observe_ui",
	label: "Observe UI",
	description: "Capture one look and return the running note plus a folded UI outline with counts, ancestor refs, pictureOnly nodes, and optional image.",
	promptSnippet: "Primary UI observation tool. Follow with search_ui, expand_ui, inspect_ui, or act_ui.",
	promptGuidelines: [
		"Use mode=semantic to skip OCR text, visual to force OCR text, and fused for auto OCR.",
		"Use @e outline refs from observe_ui/search_ui for act_ui; pictureOnly refs are coordinate-only and blocked by UI-tree-only policy.",
	],
	parameters: Type.Object({
		app: Type.Optional(Type.String({ description: "Optional app name" })),
		windowTitle: Type.Optional(Type.String({ description: "Optional exact window title" })),
		root,
		mode: Type.Optional(Type.Union([Type.Literal("semantic"), Type.Literal("visual"), Type.Literal("fused")], { description: "Observation mode, default fused" })),
		image,
	}),
	execute: executeObserve,
});

const searchUiTool = defineTool({
	name: "search_ui",
	label: "Search UI",
	description: "Search the full cached outline by text, role, or action in document order and return ancestor paths with the current note header.",
	promptSnippet: "Find targets not shown in the compact observe_ui output.",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Text/label query" })),
		role: Type.Optional(Type.String({ description: "Accessibility role, e.g. button" })),
		action: Type.Optional(Type.String({ description: "Action/capability, e.g. press" })),
		limit: Type.Optional(Type.Number({ description: "Maximum results, default 12" })),
		stateId,
	}),
	execute: executeSearchUi,
});

const expandUiTool = defineTool({
	name: "expand_ui",
	label: "Expand UI",
	description: "Unfold local outline context for one @e ref; truncated or changed note regions trigger a scoped look first.",
	promptSnippet: "Expand a specific ref instead of dumping unrelated UI.",
	parameters: Type.Object({
		ref: Type.String({ description: "Outline ref from observe_ui/search_ui, e.g. @e12" }),
		depth: Type.Optional(Type.Number({ description: "Outline subtree depth, default 3" })),
		stateId,
	}),
	execute: executeExpandUi,
});

const inspectUiTool = defineTool({
	name: "inspect_ui",
	label: "Inspect UI",
	description: "Inspect one outline ref with fields, image-pixel rect, actions, annotations, text boxes, and pictureOnly/truncated state.",
	promptSnippet: "Use when a target's evidence or provenance matters.",
	parameters: Type.Object({
		ref: Type.String({ description: "Outline ref from observe_ui/search_ui, e.g. @e12" }),
		includeRaw: Type.Optional(Type.Boolean({ description: "Include the serialized outline node in details" })),
		stateId,
	}),
	execute: executeInspectUi,
});

const actTool = defineTool({
	name: "act_ui",
	label: "Act",
	description: "Perform one or more checked actions, returning the resulting saved state and a compact list of changes when trustworthy.",
	promptSnippet: "Pass dependent click/type steps together, use the returned state directly, and omit the typing ref when the click should establish focus.",
	promptGuidelines: [
		"Use expect for observable completion instead of issuing a separate observe_ui call.",
		"After clicking an editable region, omit ref from typeText/keypress so input follows the focus established by the click.",
	],
	parameters: Type.Object({
		stateId,
		headless: Type.Optional(Type.Boolean({ description: "When true, prohibit foreground fallback. When false or omitted, Pi still attempts background first and uses foreground only after a side-effect-free foreground_required result." })),
		expect: Type.Optional(Type.Object({
			text: Type.Optional(Type.String({ description: "Text that must appear after the transaction" })),
			role: Type.Optional(Type.String({ description: "Role that must appear after the transaction" })),
			value: Type.Optional(Type.String({ description: "Exact normalized value required on the matching element" })),
			gone: Type.Optional(Type.Boolean({ description: "When true, the matching text/role must disappear" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Maximum postcondition wait, default 10000ms" })),
		})),
		actions: Type.Array(uiAction, { minItems: 1, maxItems: 20 }),
		image,
	}),
	execute: executeAct,
});

const readTextTool = defineTool({
	name: "read_text",
	label: "Read Text",
	description: "Read text from a text-bearing desktop UI ref or browser context, with pagination.",
	promptSnippet: "Fetch full text when observe_ui/inspect_ui shows a truncated text-bearing ref.",
	parameters: Type.Object({ ref: Type.Optional(Type.String()), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), stateId }),
	execute: executeReadText,
});

const waitForTool = defineTool({
	name: "wait_for",
	label: "Wait For",
	description: "Wait until desktop UI or browser context text/role appears or disappears.",
	promptSnippet: "Use after async UI changes instead of polling observe_ui.",
	parameters: Type.Object({ text: Type.Optional(Type.String()), role: Type.Optional(Type.String()), gone: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number()), stateId }),
	execute: executeWaitFor,
});

const launchBrowserTool = defineTool({
	name: "launch_browser",
	label: "Launch Browser Context",
	description: "Launch a Pi-managed browser and return its controllable browser-page roots.",
	promptSnippet: "Use for browser work that needs CDP contexts.",
	parameters: Type.Object({ browser: Type.Optional(Type.Union([Type.Literal("helium"), Type.Literal("chrome")])), url: Type.Optional(Type.String()), port: Type.Optional(Type.Number()) }),
	execute: executeLaunchBrowser,
});

const navigateBrowserTool = defineTool({
	name: "navigate_browser",
	label: "Navigate Browser",
	description: "Navigate a browser window directly to a URL or search string.",
	promptSnippet: "Use direct browser navigation instead of address-bar typing when possible.",
	parameters: Type.Object({ url: Type.String(), stateId, image }),
	execute: executeNavigateBrowser,
});

const evaluateBrowserTool = defineTool({
	name: "evaluate_browser",
	label: "Evaluate Browser",
	description: "Evaluate JavaScript in a CDP-connected browser context.",
	promptSnippet: "Use for targeted browser inspection when observe is insufficient.",
	parameters: Type.Object({ stateId, expression: Type.String() }),
	execute: executeEvaluateBrowser,
});

function formatConfigStatus(): string {
	const loaded = getLoadedComputerUseConfig();
	return [
		"pi-computer-use configuration",
		`browser_use: ${loaded.config.browser_use ? "enabled" : "disabled"}`,
		`headless: ${loaded.config.headless ? "enabled" : "disabled"}`,
		`cursor_overlay: ${loaded.config.cursor_overlay ? "enabled" : "disabled"}`,
		"",
		"Sources:",
		...loaded.sources.map((source) => `- ${source.path}: ${source.error ? `error: ${source.error}` : source.exists ? "loaded" : "not found"}`),
		`- env overrides: ${Object.keys(loaded.env).join(", ") || "none"}`,
	].join("\n");
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	for (const tool of [findTool, observeTool, searchUiTool, expandUiTool, inspectUiTool, actTool, readTextTool, waitForTool, launchBrowserTool, navigateBrowserTool, evaluateBrowserTool]) pi.registerTool(tool);

	pi.registerCommand("computer-use", {
		description: "Show pi-computer-use configuration",
		handler: async (_args, ctx) => {
			loadComputerUseConfig(ctx.cwd);
			ctx.ui.notify(formatConfigStatus(), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		loadComputerUseConfig(ctx.cwd);
		reconstructStateFromBranch(ctx);
		if (!ctx.hasUI) return;
		try { await ensureComputerUseSetup(ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
	});

	pi.on("session_shutdown", async () => {
		await shutdownComputerUseSession();
	});
}
