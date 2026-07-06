import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ensureComputerUseSetup,
	executeAct,
	executeEvaluateBrowser,
	executeExpandUi,
	executeInspectUi,
	executeLaunchBrowserContext,
	executeListContexts,
	executeFind,
	executeNavigateBrowser,
	executeObserve,
	executeReadText,
	executeSearchUi,
	executeWaitFor,
	reconstructStateFromBranch,
} from "../src/bridge.ts";
import { getLoadedComputerUseConfig, loadComputerUseConfig } from "../src/config.ts";

const contextId = Type.Optional(Type.String({ description: "Optional context id from list_contexts, e.g. desktop:@r1 or browser:<targetId>" }));
const stateId = Type.Optional(Type.String({ description: "Optional state id from the latest observe_ui/snapshot" }));
const root = Type.Optional(Type.Union([Type.String({ description: "Root ref from find_roots, e.g. @r1, or shorthand query" }), Type.Number({ description: "Numeric windowId" })]));
const image = Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("never")], { description: "Image attachment mode, default auto" }));
const responseMode = Type.Optional(Type.Union([Type.Literal("state"), Type.Literal("confirmation")], { description: "Use confirmation to skip returned state." }));

const findTool = defineTool({
	name: "find_roots",
	label: "Find Roots",
	description: "Find controllable UI roots with refs, geometry, and focus state.",
	promptSnippet: "Find a target root before observe_ui when needed.",
	executionMode: "sequential",
	parameters: Type.Object({
		query: Type.Optional(Type.String({ description: "Optional app/title/menu label query; absent or unmatched returns all roots" })),
		app: Type.Optional(Type.String({ description: "Optional app-name narrowing filter" })),
		bundleId: Type.Optional(Type.String({ description: "Optional bundle-id narrowing filter" })),
		pid: Type.Optional(Type.Number({ description: "Optional process-id narrowing filter" })),
		kind: Type.Optional(Type.Union([Type.Literal("window"), Type.Literal("menu"), Type.Literal("sheet"), Type.Literal("popover"), Type.Literal("dialog")], { description: "Optional root kind narrowing filter" })),
	}),
	execute: executeFind,
});

const listContextsTool = defineTool({
	name: "list_contexts",
	label: "List Contexts",
	description: "List desktop windows and CDP-connected browser pages.",
	promptSnippet: "Use when choosing between desktop and browser contexts.",
	executionMode: "sequential",
	parameters: Type.Object({}),
	execute: executeListContexts,
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
	executionMode: "sequential",
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
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Text/label query" })),
		role: Type.Optional(Type.String({ description: "Accessibility role, e.g. button" })),
		action: Type.Optional(Type.String({ description: "Action/capability, e.g. press" })),
		source: Type.Optional(Type.String({ description: "Ignored compatibility field; outline search has one source" })),
		limit: Type.Optional(Type.Number({ description: "Maximum results, default 12" })),
		root,
		stateId,
	}),
	execute: executeSearchUi,
});

const expandUiTool = defineTool({
	name: "expand_ui",
	label: "Expand UI",
	description: "Unfold local outline context for one @e ref; truncated or changed note regions trigger a scoped look first.",
	promptSnippet: "Expand a specific ref instead of dumping unrelated UI.",
	executionMode: "sequential",
	parameters: Type.Object({
		ref: Type.String({ description: "Outline ref from observe_ui/search_ui, e.g. @e12" }),
		depth: Type.Optional(Type.Number({ description: "Outline subtree depth, default 3" })),
		root,
		stateId,
	}),
	execute: executeExpandUi,
});

const inspectUiTool = defineTool({
	name: "inspect_ui",
	label: "Inspect UI",
	description: "Inspect one outline ref with fields, image-pixel rect, actions, annotations, text boxes, and pictureOnly/truncated state.",
	promptSnippet: "Use when a target's evidence or provenance matters.",
	executionMode: "sequential",
	parameters: Type.Object({
		ref: Type.String({ description: "Outline ref from observe_ui/search_ui, e.g. @e12" }),
		includeRaw: Type.Optional(Type.Boolean({ description: "Include the serialized outline node in details" })),
		root,
		stateId,
	}),
	execute: executeInspectUi,
});

const actTool = defineTool({
	name: "act_ui",
	label: "Act",
	description: "Perform one helper act transaction by outline @e ref or look image coordinates and return the helper outcome.",
	promptSnippet: "Use @e outline refs when available; helper act chooses semantic or coordinate grounding and reports worked/didnt/unknown.",
	executionMode: "sequential",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("press"), Type.Literal("click"), Type.Literal("doubleClick"), Type.Literal("setText"), Type.Literal("typeText"), Type.Literal("keypress"), Type.Literal("scroll"), Type.Literal("drag"), Type.Literal("moveMouse"), Type.Literal("wait")]),
		ref: Type.Optional(Type.String({ description: "Outline ref, e.g. @e12" })),
		x: Type.Optional(Type.Number({ description: "X coordinate in look image pixels" })),
		y: Type.Optional(Type.Number({ description: "Y coordinate in look image pixels" })),
		text: Type.Optional(Type.String({ description: "Text for setText/typeText" })),
		keys: Type.Optional(Type.Array(Type.String(), { description: "Keys for keypress" })),
		scrollX: Type.Optional(Type.Number({ description: "Horizontal scroll delta" })),
		scrollY: Type.Optional(Type.Number({ description: "Vertical scroll delta" })),
		path: Type.Optional(Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), { description: "Drag path points" })),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		clickCount: Type.Optional(Type.Number({ description: "Click count for click/doubleClick" })),
		ms: Type.Optional(Type.Number({ description: "Wait duration in milliseconds" })),
		contextId,
		root,
		stateId,
		image,
		responseMode,
	}),
	execute: executeAct,
});

const readTextTool = defineTool({
	name: "read_text",
	label: "Read Text",
	description: "Read text from a text-bearing desktop UI ref or browser context, with pagination.",
	promptSnippet: "Fetch full text when observe_ui/inspect_ui shows a truncated text-bearing ref.",
	executionMode: "sequential",
	parameters: Type.Object({ ref: Type.Optional(Type.String()), contextId, offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), root, stateId }),
	execute: executeReadText,
});

const waitForTool = defineTool({
	name: "wait_for",
	label: "Wait For",
	description: "Wait until desktop UI or browser context text/role appears or disappears.",
	promptSnippet: "Use after async UI changes instead of polling observe_ui.",
	executionMode: "sequential",
	parameters: Type.Object({ text: Type.Optional(Type.String()), role: Type.Optional(Type.String()), gone: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number()), contextId, root, stateId }),
	execute: executeWaitFor,
});

const launchBrowserContextTool = defineTool({
	name: "launch_browser_context",
	label: "Launch Browser Context",
	description: "Launch a Pi-managed Helium or Chrome instance with CDP enabled.",
	promptSnippet: "Use for browser work that needs CDP contexts.",
	executionMode: "sequential",
	parameters: Type.Object({ browser: Type.Optional(Type.Union([Type.Literal("helium"), Type.Literal("chrome")])), url: Type.Optional(Type.String()), port: Type.Optional(Type.Number()) }),
	execute: executeLaunchBrowserContext,
});

const navigateBrowserTool = defineTool({
	name: "navigate_browser",
	label: "Navigate Browser",
	description: "Navigate a browser window directly to a URL or search string.",
	promptSnippet: "Use direct browser navigation instead of address-bar typing when possible.",
	executionMode: "sequential",
	parameters: Type.Object({ url: Type.String(), contextId, root, image }),
	execute: executeNavigateBrowser,
});

const evaluateBrowserTool = defineTool({
	name: "evaluate_browser",
	label: "Evaluate Browser",
	description: "Evaluate JavaScript in a CDP-connected browser context.",
	promptSnippet: "Use for targeted browser inspection when observe is insufficient.",
	executionMode: "sequential",
	parameters: Type.Object({ contextId: Type.String(), expression: Type.String() }),
	execute: executeEvaluateBrowser,
});

function formatConfigStatus(): string {
	const loaded = getLoadedComputerUseConfig();
	return [
		"pi-computer-use configuration",
		`browser_use: ${loaded.config.browser_use ? "enabled" : "disabled"}`,
		`stealth_mode: ${loaded.config.stealth_mode ? "enabled" : "disabled"}`,
		"",
		"Sources:",
		...loaded.sources.map((source) => `- ${source.path}: ${source.error ? `error: ${source.error}` : source.exists ? "loaded" : "not found"}`),
		`- env overrides: ${Object.keys(loaded.env).join(", ") || "none"}`,
	].join("\n");
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	for (const tool of [findTool, listContextsTool, observeTool, searchUiTool, expandUiTool, inspectUiTool, actTool, readTextTool, waitForTool, launchBrowserContextTool, navigateBrowserTool, evaluateBrowserTool]) pi.registerTool(tool);

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
}
