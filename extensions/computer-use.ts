import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ensureComputerUseSetup,
	executeAct,
	executeEvaluateBrowser,
	executeExpandUi,
	executeInspectUi,
	executeLaunchBrowserContext,
	executeListApps,
	executeListContexts,
	executeListWindows,
	executeNavigateBrowser,
	executeObserve,
	executeReadText,
	executeSearchUi,
	executeWaitFor,
	reconstructStateFromBranch,
} from "../src/bridge.ts";
import { getLoadedComputerUseConfig, loadComputerUseConfig } from "../src/config.ts";

const contextId = Type.Optional(Type.String({ description: "Optional context id from list_contexts, e.g. desktop:@w1 or browser:<targetId>" }));
const stateId = Type.Optional(Type.String({ description: "Optional state id from the latest observe/snapshot" }));
const window = Type.Optional(Type.Union([Type.String({ description: "Window ref from list_windows, e.g. @w1" }), Type.Number({ description: "Numeric windowId" })]));
const image = Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("never")], { description: "Image attachment mode, default auto" }));
const responseMode = Type.Optional(Type.Union([Type.Literal("state"), Type.Literal("confirmation")], { description: "Use confirmation to skip returned state." }));

const listAppsTool = defineTool({
	name: "list_apps",
	label: "List Apps",
	description: "List running macOS apps that can be inspected for computer-use windows.",
	promptSnippet: "Discover running apps before choosing a window.",
	executionMode: "sequential",
	parameters: Type.Object({}),
	execute: executeListApps,
});

const listWindowsTool = defineTool({
	name: "list_windows",
	label: "List Windows",
	description: "List controllable windows with ids, refs, geometry, and focus state.",
	promptSnippet: "Choose a target window before observe.",
	executionMode: "sequential",
	parameters: Type.Object({
		app: Type.Optional(Type.String({ description: "App name filter" })),
		bundleId: Type.Optional(Type.String({ description: "Bundle ID filter" })),
		pid: Type.Optional(Type.Number({ description: "Process id filter" })),
	}),
	execute: executeListWindows,
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
	name: "observe",
	label: "Observe UI",
	description: "Capture a compact UI scene: AX semantics, visual evidence, associations, and unknown regions.",
	promptSnippet: "Primary UI observation tool. Follow with search_ui, expand_ui, inspect_ui, or act.",
	promptGuidelines: [
		"Use mode=semantic for AX-only observation, fused for AX plus visual fallback, visual for screenshot-first inspection.",
		"Prefer @t scene refs from observe/search_ui for act.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		app: Type.Optional(Type.String({ description: "Optional app name" })),
		windowTitle: Type.Optional(Type.String({ description: "Optional exact window title" })),
		window,
		mode: Type.Optional(Type.Union([Type.Literal("semantic"), Type.Literal("visual"), Type.Literal("fused")], { description: "Observation mode, default fused" })),
		image,
	}),
	execute: executeObserve,
});

const searchUiTool = defineTool({
	name: "search_ui",
	label: "Search UI",
	description: "Search the current scene by text, role, action, or source without dumping the whole tree.",
	promptSnippet: "Find targets not shown in the compact observe output.",
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Text/label query" })),
		role: Type.Optional(Type.String({ description: "AX role, e.g. AXButton" })),
		action: Type.Optional(Type.String({ description: "Action/capability, e.g. press or AXPress" })),
		source: Type.Optional(Type.String({ description: "AX source, e.g. desktop_ax" })),
		limit: Type.Optional(Type.Number({ description: "Maximum results, default 12" })),
		window,
		stateId,
	}),
	execute: executeSearchUi,
});

const expandUiTool = defineTool({
	name: "expand_ui",
	label: "Expand UI",
	description: "Progressively disclose local context for one scene/AX/vision ref.",
	promptSnippet: "Expand a specific ref instead of dumping unrelated UI.",
	executionMode: "sequential",
	parameters: Type.Object({
		ref: Type.String({ description: "Ref from observe/search_ui, e.g. @t1, @e2, @u1, @v3" }),
		depth: Type.Optional(Type.Number({ description: "AX subtree depth, default 3" })),
		window,
		stateId,
	}),
	execute: executeExpandUi,
});

const inspectUiTool = defineTool({
	name: "inspect_ui",
	label: "Inspect UI",
	description: "Inspect one scene ref with provenance, normalized frame, actions, and optional raw evidence.",
	promptSnippet: "Use when a target's evidence or provenance matters.",
	executionMode: "sequential",
	parameters: Type.Object({
		ref: Type.String({ description: "Ref from observe/search_ui, e.g. @t1" }),
		includeRaw: Type.Optional(Type.Boolean({ description: "Include raw AX/vision arrays in details" })),
		window,
		stateId,
	}),
	execute: executeInspectUi,
});

const actTool = defineTool({
	name: "act",
	label: "Act",
	description: "Perform one action by scene/AX/vision ref or screenshot coordinates.",
	promptSnippet: "Use @t scene refs when available; coordinates are fallback only.",
	executionMode: "sequential",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("press"), Type.Literal("click"), Type.Literal("doubleClick"), Type.Literal("setText"), Type.Literal("typeText"), Type.Literal("keypress"), Type.Literal("scroll"), Type.Literal("drag"), Type.Literal("moveMouse"), Type.Literal("wait")]),
		ref: Type.Optional(Type.String({ description: "Scene/AX/vision ref, e.g. @t1, @e2, @u1, @v3" })),
		x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixels" })),
		y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixels" })),
		text: Type.Optional(Type.String({ description: "Text for setText/typeText" })),
		keys: Type.Optional(Type.Array(Type.String(), { description: "Keys for keypress" })),
		scrollX: Type.Optional(Type.Number({ description: "Horizontal scroll delta" })),
		scrollY: Type.Optional(Type.Number({ description: "Vertical scroll delta" })),
		path: Type.Optional(Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), { description: "Drag path points" })),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		ms: Type.Optional(Type.Number({ description: "Wait duration in milliseconds" })),
		contextId,
		window,
		stateId,
		image,
		responseMode,
	}),
	execute: executeAct,
});

const readTextTool = defineTool({
	name: "read_text",
	label: "Read Text",
	description: "Read text from a text-bearing desktop AX ref or browser context, with pagination.",
	promptSnippet: "Fetch full text when observe/inspect shows a truncated text-bearing ref.",
	executionMode: "sequential",
	parameters: Type.Object({ ref: Type.Optional(Type.String()), contextId, offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), window, stateId }),
	execute: executeReadText,
});

const waitForTool = defineTool({
	name: "wait_for",
	label: "Wait For",
	description: "Wait until desktop AX or browser context text/role appears or disappears.",
	promptSnippet: "Use after async UI changes instead of polling observe.",
	executionMode: "sequential",
	parameters: Type.Object({ text: Type.Optional(Type.String()), role: Type.Optional(Type.String()), gone: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number()), contextId, window, stateId }),
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
	parameters: Type.Object({ url: Type.String(), contextId, window, image }),
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

function isDuplicateToolConflict(error: unknown): boolean {
	return error instanceof Error && /Tool ".*" conflicts with /.test(error.message);
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	try {
		for (const tool of [listAppsTool, listWindowsTool, listContextsTool, observeTool, searchUiTool, expandUiTool, inspectUiTool, actTool, readTextTool, waitForTool, launchBrowserContextTool, navigateBrowserTool, evaluateBrowserTool]) pi.registerTool(tool);
	} catch (error) {
		if (isDuplicateToolConflict(error)) return;
		throw error;
	}

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
