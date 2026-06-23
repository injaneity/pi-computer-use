import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ensureComputerUseSetup,
	executeArrangeWindow,
	executeClick,
	executeComputerActions,
	executeDoubleClick,
	executeDrag,
	executeEvaluateBrowser,
	executeKeypress,
	executeLaunchBrowserContext,
	executeListApps,
	executeListContexts,
	executeListWindows,
	executeMoveMouse,
	executeNavigateBrowser,
	executeReadText,
	executeScroll,
	executeSetText,
	executeScreenshot,
	executeSnapshot,
	executeTypeText,
	executeWait,
	executeWaitFor,
	reconstructStateFromBranch,
	stopBridge,
} from "../src/bridge.ts";
import { getLoadedComputerUseConfig, loadComputerUseConfig } from "../src/config.ts";

const contextIdSchema = Type.Optional(Type.String({ description: "Optional context id from list_contexts, e.g. desktop:@w1 or browser:<targetId>" }));
const windowSelectorSchema = Type.Optional(Type.Union([
	Type.String({ description: "Optional window ref from list_windows, e.g. @w1" }),
	Type.Number({ description: "Optional numeric windowId from list_windows" }),
]));
const stateIdSchema = Type.Optional(Type.String({ description: "Optional state id from the latest screenshot/snapshot" }));
const imageModeSchema = Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("never")], {
	description: "Optional screenshot attachment mode, default auto",
}));
const responseModeSchema = Type.Optional(Type.Union([Type.Literal("state"), Type.Literal("confirmation")], {
	description: "Optional response mode. Use confirmation to skip post-action state capture when you do not need updated state.",
}));

const listAppsTool = defineTool({
	name: "list_apps",
	label: "List Apps",
	description: "List running macOS apps that can be inspected for computer-use windows.",
	promptSnippet: "List running apps before choosing a target window when the app name is unknown or ambiguous.",
	promptGuidelines: [
		"Use this when you need to discover available apps before calling list_windows or screenshot.",
		"Prefer exact app names, bundle IDs, or PIDs from this result when targeting windows.",
	],
	executionMode: "sequential",
	parameters: Type.Object({}),
	execute: executeListApps,
});

const listWindowsTool = defineTool({
	name: "list_windows",
	label: "List Windows",
	description: "List controllable windows for running macOS apps, with titles, ids, geometry, and focus state.",
	promptSnippet: "List windows for an app before selecting a target with screenshot.",
	promptGuidelines: [
		"Use app, bundleId, or pid from list_apps to avoid ambiguity.",
		"Use this when multiple windows may exist or when screenshot selected the wrong window.",
		"After choosing a window, call screenshot with window=@wN to select and inspect it.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		app: Type.Optional(Type.String({ description: "Optional app name filter, e.g. Safari" })),
		bundleId: Type.Optional(Type.String({ description: "Optional bundle ID filter, e.g. com.apple.Safari" })),
		pid: Type.Optional(Type.Number({ description: "Optional process ID filter from list_apps" })),
	}),
	execute: executeListWindows,
});

const listContextsTool = defineTool({
	name: "list_contexts",
	label: "List Contexts",
	description: "List controllable contexts such as desktop windows and CDP-connected browser pages.",
	promptSnippet: "List available contexts before choosing what to inspect or control.",
	promptGuidelines: [
		"Use this when you need to choose between desktop windows and browser pages.",
		"Use snapshot with the returned contextId before taking context-grounded actions.",
	],
	executionMode: "sequential",
	parameters: Type.Object({}),
	execute: executeListContexts,
});

const snapshotTool = defineTool({
	name: "snapshot",
	label: "Snapshot",
	description: "Capture semantic state for a context. Browser contexts return CDP page text and browser accessibility targets; desktop contexts return macOS AX state.",
	promptSnippet: "Inspect a context by contextId from list_contexts.",
	promptGuidelines: [
		"Prefer this over screenshot when working from a contextId.",
		"Use browser page text and returned refs when available instead of relying on visual coordinates.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		contextId: Type.String({ description: "Context id from list_contexts, e.g. desktop:@w1 or browser:<targetId>" }),
		scopeRef: Type.Optional(Type.String({ description: "Optional desktop AX ref to expand as a scoped subtree, e.g. @e4" })),
		maxNodes: Type.Optional(Type.Number({ description: "Maximum desktop AX nodes to return, default 120" })),
		maxDepth: Type.Optional(Type.Number({ description: "Maximum desktop AX depth to traverse, default 4" })),
		image: imageModeSchema,
	}),
	execute: executeSnapshot,
});

const readTextTool = defineTool({
	name: "read_text",
	label: "Read Text",
	description: "Read text from a text-bearing desktop AX ref or a browser context, with offset/limit pagination.",
	promptSnippet: "Use this to fetch full text after snapshot/screenshot shows a truncated text-bearing ref or browser page text.",
	promptGuidelines: [
		"For desktop, pass ref and stateId from the latest screenshot/snapshot.",
		"For browser contexts, pass contextId; ref is optional and page text is returned.",
		"Use offset and limit to page through long content instead of requesting large screenshots.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		ref: Type.Optional(Type.String({ description: "Optional text-bearing ref from screenshot/snapshot, e.g. @e1" })),
		contextId: contextIdSchema,
		offset: Type.Optional(Type.Number({ description: "Character offset, default 0" })),
		limit: Type.Optional(Type.Number({ description: "Maximum characters to return, default 4000" })),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
	}),
	execute: executeReadText,
});

const waitForTool = defineTool({
	name: "wait_for",
	label: "Wait For",
	description: "Wait until a desktop AX or browser context condition appears or disappears.",
	promptSnippet: "Use this after actions/navigation when a target may still be loading instead of repeatedly calling wait and snapshot.",
	promptGuidelines: [
		"Provide text and/or role to wait for.",
		"Use gone=true to wait for loading indicators or dialogs to disappear.",
		"For browser contexts, pass contextId. For desktop, pass window/contextId if needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Text substring to wait for" })),
		role: Type.Optional(Type.String({ description: "Optional exact AX/browser role to wait for" })),
		gone: Type.Optional(Type.Boolean({ description: "Wait for the condition to disappear instead of appear" })),
		timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds, default 10000" })),
		contextId: contextIdSchema,
		window: windowSelectorSchema,
		stateId: stateIdSchema,
	}),
	execute: executeWaitFor,
});

const screenshotTool = defineTool({
	name: "screenshot",
	label: "Screenshot",
	description: "Capture the current controlled macOS window, returning semantic AX targets and attaching an image only when fallback is needed.",
	promptSnippet: "Capture and select a macOS window. Call this first and to switch windows.",
	promptGuidelines: [
		"Call screenshot first to choose a window and inspect the latest UI state.",
		"If screenshot returns AX targets, prefer refs for click and set_text before coordinate or focus-based actions.",
		"Call screenshot(app, windowTitle) to switch the controlled window.",
		"For browsers, prefer a separate window for agent work instead of opening a new tab in the user's current window.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		app: Type.Optional(Type.String({ description: "Optional app name, e.g. Safari" })),
		windowTitle: Type.Optional(Type.String({ description: "Optional window title filter" })),
		window: windowSelectorSchema,
		image: imageModeSchema,
	}),
	execute: executeScreenshot,
});

const clickTool = defineTool({
	name: "click",
	label: "Click",
	description: "Click in a desktop window or browser context by ref or screenshot-relative coordinates.",
	promptSnippet: "Click using a ref from the latest screenshot/snapshot, or desktop screenshot coordinates.",
	promptGuidelines: [
		"For desktop snapshots, prefer AX refs like @e1 before coordinates.",
		"For browser snapshots, pass contextId, stateId, and a browser ref like @r1.",
		"Coordinates are window-relative screenshot pixels from the latest desktop screenshot.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixels" })),
		y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixels" })),
		ref: Type.Optional(Type.String({ description: "Optional target ref from the latest screenshot/snapshot, e.g. @e1 or @r1" })),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		clickCount: Type.Optional(Type.Number({ description: "Number of clicks, default 1" })),
		contextId: contextIdSchema,
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
	}),
	execute: executeClick,
});

const doubleClickTool = defineTool({
	name: "double_click",
	label: "Double Click",
	description: "Double-click inside the current controlled window by AX target ref or screenshot-relative coordinates.",
	promptSnippet: "Double-click using coordinates from the latest screenshot or an AX target ref like @e1.",
	promptGuidelines: [
		"Use this for opening files, selecting rows, or controls that explicitly need a double-click.",
		"Coordinates are window-relative screenshot pixels from the latest screenshot.",
		"Prefer AX refs when the latest screenshot includes a matching target.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixels" })),
		y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixels" })),
		ref: Type.Optional(Type.String({ description: "Optional target ref from the latest screenshot/snapshot, e.g. @e1 or @r1" })),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		contextId: contextIdSchema,
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
	}),
	execute: executeDoubleClick,
});

const moveMouseTool = defineTool({
	name: "move_mouse",
	label: "Move Mouse",
	description: "Move the mouse to screenshot-relative coordinates in the current controlled window.",
	promptSnippet: "Move the mouse in the current window using coordinates from the latest screenshot.",
	promptGuidelines: [
		"Use this only when hover state matters; prefer semantic AX refs for normal activation.",
		"Coordinates are window-relative screenshot pixels from the latest screenshot.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Number({ description: "X coordinate in screenshot pixels" }),
		y: Type.Number({ description: "Y coordinate in screenshot pixels" }),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
	}),
	execute: executeMoveMouse,
});

const dragTool = defineTool({
	name: "drag",
	label: "Drag",
	description: "Drag along a path of screenshot-relative coordinates in the current controlled window.",
	promptSnippet: "Drag in the current window using a path from the latest screenshot.",
	promptGuidelines: [
		"Use this for sliders, resizing, selection, and drag-and-drop.",
		"Path points are window-relative screenshot pixels from the latest screenshot.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		path: Type.Optional(Type.Array(
			Type.Object({ x: Type.Number(), y: Type.Number() }),
			{ minItems: 2, description: "At least two points, each as {x,y}" },
		)),
		ref: Type.Optional(Type.String({ description: "Optional AX adjustable target ref from the latest screenshot, e.g. @e1" })),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
	}),
	execute: executeDrag,
});

const scrollTool = defineTool({
	name: "scroll",
	label: "Scroll",
	description: "Scroll at screenshot-relative coordinates in the current controlled window.",
	promptSnippet: "Scroll in the current window using coordinates from the latest screenshot.",
	promptGuidelines: [
		"Use positive scrollY to scroll down and negative scrollY to scroll up.",
		"Coordinates are window-relative screenshot pixels from the latest screenshot.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixels" })),
		y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixels" })),
		ref: Type.Optional(Type.String({ description: "Optional scroll target ref from the latest screenshot/snapshot, e.g. @e1 or @r1" })),
		scrollX: Type.Optional(Type.Number({ description: "Horizontal scroll delta in pixels" })),
		scrollY: Type.Optional(Type.Number({ description: "Vertical scroll delta in pixels" })),
		contextId: contextIdSchema,
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
	}),
	execute: executeScroll,
});

const keypressTool = defineTool({
	name: "keypress",
	label: "Keypress",
	description: "Press one key, a key sequence, or a modifier chord in the current controlled window.",
	promptSnippet: "Press keys like Enter, Tab, Escape, Cmd+L, or [\"Command\", \"L\"].",
	promptGuidelines: [
		"Use this for Enter, Tab, Escape, shortcuts, arrow keys, deletion, and form submission.",
		"For a shortcut followed by another key, use chord strings like ['Command+L', 'Enter']. Use ['Command', 'L'] only when the whole call is one chord.",
		"Use type_text for literal text insertion.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
		keys: Type.Array(Type.String({ description: "Key name or chord, e.g. Enter, Tab, Cmd+L" }), {
			minItems: 1,
			description: "Keys to press. Modifier arrays like ['Command','L'] are treated as one chord.",
		}),
	}),
	execute: executeKeypress,
});

const typeTextTool = defineTool({
	name: "type_text",
	label: "Type Text",
	description: "Insert text into the currently focused control in the current controlled window.",
	promptSnippet: "Type into the focused control in the current window.",
	promptGuidelines: [
		"Click a field first if needed, then call type_text.",
		"This inserts at the current cursor/selection. Use set_text with ref when you need to replace a whole AX text value.",
		"Returns the latest semantic state and attaches an image only when fallback is needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.String({ description: "Text to type" }),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
	}),
	execute: executeTypeText,
});

const setTextTool = defineTool({
	name: "set_text",
	label: "Set Text",
	description: "Replace a text control value by AX set-value, or by clearing then typing keyboard events when requested.",
	promptSnippet: "Replace a text control value. Defaults to AX set-value; use method=keyboard when real typing events are required.",
	promptGuidelines: [
		"Use this when you need replacement semantics rather than insertion.",
		"Prefer set_text with ref from the latest screenshot when a matching text field is available.",
		"Default method is ax, which uses AX setValue and may not trigger keyboard-only app semantics.",
		"Use method=keyboard to focus the field, clear it with AX when possible, and type real keyboard text events.",
		"If no ref is available, click a field first if needed, then call set_text.",
		"For Enter, Tab, backspace, or shortcuts, use keypress.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.String({ description: "Replacement text value" }),
		ref: Type.Optional(Type.String({ description: "Optional text target ref from the latest screenshot/snapshot, e.g. @e1 or @r1" })),
		method: Type.Optional(Type.Union([Type.Literal("ax"), Type.Literal("keyboard")], { description: "Replacement backend. ax uses AX setValue (default); keyboard focuses the field, clears it with AX when possible, then types real key events." })),
		contextId: contextIdSchema,
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
		responseMode: responseModeSchema,
	}),
	execute: executeSetText,
});

const waitTool = defineTool({
	name: "wait",
	label: "Wait",
	description: "Pause briefly, then return the latest semantic state of the current controlled window.",
	promptSnippet: "Wait briefly and refresh the current window state.",
	promptGuidelines: [
		"Use this for loading, animations, and polling async UI updates.",
		"Returns the latest semantic state and attaches an image only when fallback is needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		ms: Type.Optional(Type.Number({ description: "Milliseconds to wait (default ~1000ms)" })),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	execute: executeWait,
});

const arrangeWindowTool = defineTool({
	name: "arrange_window",
	label: "Arrange Window",
	description: "Move or resize a target window for deterministic layout before interacting with it.",
	promptSnippet: "Arrange a window using a preset or explicit frame before screenshot/action flows.",
	promptGuidelines: [
		"Use this to make screenshots and coordinates more predictable.",
		"Prefer presets like center_large, left_half, or right_half unless exact geometry matters.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		window: windowSelectorSchema,
		preset: Type.Optional(Type.Union([
			Type.Literal("center_large"),
			Type.Literal("left_half"),
			Type.Literal("right_half"),
			Type.Literal("top_half"),
			Type.Literal("bottom_half"),
		])),
		x: Type.Optional(Type.Number({ description: "Window x position in screen points" })),
		y: Type.Optional(Type.Number({ description: "Window y position in screen points" })),
		width: Type.Optional(Type.Number({ description: "Window width in screen points" })),
		height: Type.Optional(Type.Number({ description: "Window height in screen points" })),
		image: imageModeSchema,
	}),
	execute: executeArrangeWindow,
});

const launchBrowserContextTool = defineTool({
	name: "launch_browser_context",
	label: "Launch Browser Context",
	description: "Launch a Pi-managed Helium or Chrome instance with CDP enabled and return browser contexts.",
	promptSnippet: "Use this when no browser_page contexts are available or an existing browser was not launched with CDP.",
	promptGuidelines: [
		"Prefer this for full browser use instead of controlling an arbitrary existing browser window.",
		"After launch, call snapshot with a returned browser contextId.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		browser: Type.Optional(Type.Union([Type.Literal("helium"), Type.Literal("chrome")], { description: "Browser to launch, default helium" })),
		url: Type.Optional(Type.String({ description: "Initial URL, default about:blank" })),
		port: Type.Optional(Type.Number({ description: "Optional CDP port; default is an available local port" })),
	}),
	execute: executeLaunchBrowserContext,
});

const evaluateBrowserTool = defineTool({
	name: "evaluate_browser",
	label: "Evaluate Browser",
	description: "Evaluate JavaScript in a CDP-connected browser context and return the JSON-serializable value.",
	promptSnippet: "Use this for browser-only inspection when snapshot text/refs are insufficient.",
	promptGuidelines: [
		"Use a browser contextId from list_contexts.",
		"Prefer snapshot for normal page reading; use evaluate_browser for targeted browser state queries.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		contextId: Type.String({ description: "Browser context id from list_contexts, e.g. browser:<targetId>" }),
		expression: Type.String({ description: "JavaScript expression to evaluate with Runtime.evaluate returnByValue semantics" }),
	}),
	execute: executeEvaluateBrowser,
});

const navigateBrowserTool = defineTool({
	name: "navigate_browser",
	label: "Navigate Browser",
	description: "Navigate a target browser window directly to a URL or search string without relying on address-bar keyboard focus.",
	promptSnippet: "Navigate a browser window directly to a URL using a window ref like @w1.",
	promptGuidelines: [
		"Use this for browser navigation instead of Command+L/type_text/Enter when you know the destination URL.",
		"Pass an explicit window ref from list_windows when the browser has multiple windows.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		url: Type.String({ description: "URL or browser-search string to open" }),
		contextId: contextIdSchema,
		window: windowSelectorSchema,
		image: imageModeSchema,
	}),
	execute: executeNavigateBrowser,
});

const batchedActionSchema = Type.Union([
	Type.Object({
		type: Type.Literal("click"),
		x: Type.Optional(Type.Number()),
		y: Type.Optional(Type.Number()),
		ref: Type.Optional(Type.String()),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		clickCount: Type.Optional(Type.Number()),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("double_click"),
		x: Type.Optional(Type.Number()),
		y: Type.Optional(Type.Number()),
		ref: Type.Optional(Type.String()),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("move_mouse"),
		x: Type.Number(),
		y: Type.Number(),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("drag"),
		path: Type.Optional(Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), {
			minItems: 2,
		})),
		ref: Type.Optional(Type.String()),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("scroll"),
		x: Type.Optional(Type.Number()),
		y: Type.Optional(Type.Number()),
		ref: Type.Optional(Type.String()),
		scrollX: Type.Optional(Type.Number()),
		scrollY: Type.Optional(Type.Number()),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("keypress"),
		keys: Type.Array(Type.String(), { minItems: 1 }),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("type_text"),
		text: Type.String(),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("set_text"),
		text: Type.String(),
		ref: Type.Optional(Type.String()),
		method: Type.Optional(Type.Union([Type.Literal("ax"), Type.Literal("keyboard")])),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	Type.Object({
		type: Type.Literal("wait"),
		ms: Type.Optional(Type.Number()),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
]);

const computerActionsTool = defineTool({
	name: "computer_actions",
	label: "Computer Actions",
	description: "Execute a batch of computer-use actions in the current controlled window, then return one latest state update.",
	promptSnippet: "Batch actions like click+type_text+keypress when no intermediate screenshot is needed.",
	promptGuidelines: [
		"Use this to save turns/tokens when the next actions are obvious from the latest screenshot.",
		"Do not batch when you need to inspect the result of an intermediate action before deciding the next action.",
		"Coordinates and refs come from the latest screenshot; the tool returns one state update after all actions finish.",
		"Per-action metadata reports whether each action used the stealth or default implementation variant.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		actions: Type.Array(batchedActionSchema, { minItems: 1, maxItems: 20, description: "One to twenty actions to run sequentially" }),
		window: windowSelectorSchema,
		stateId: stateIdSchema,
		image: imageModeSchema,
	}),
	execute: executeComputerActions,
});

function formatConfigStatus(): string {
	const loaded = getLoadedComputerUseConfig();
	const lines = [
		"pi-computer-use config",
		"",
		`browser_use: ${loaded.config.browser_use ? "enabled" : "disabled"}`,
		`stealth_mode: ${loaded.config.stealth_mode ? "enabled" : "disabled"}`,
		"",
		"Sources:",
	];
	for (const source of loaded.sources) {
		const status = source.error ? `error: ${source.error}` : source.exists ? "loaded" : "not found";
		lines.push(`- ${source.path}: ${status}`);
	}
	const envKeys = Object.keys(loaded.env);
	lines.push(`- env overrides: ${envKeys.length ? envKeys.join(", ") : "none"}`);
	return lines.join("\n");
}

function isDuplicateToolConflict(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /Tool ".*" conflicts with /.test(error.message);
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	try {
		pi.registerTool(listAppsTool);
		pi.registerTool(listWindowsTool);
		pi.registerTool(listContextsTool);
		pi.registerTool(snapshotTool);
		pi.registerTool(readTextTool);
		pi.registerTool(waitForTool);
		pi.registerTool(screenshotTool);
		pi.registerTool(clickTool);
		pi.registerTool(doubleClickTool);
		pi.registerTool(moveMouseTool);
		pi.registerTool(dragTool);
		pi.registerTool(scrollTool);
		pi.registerTool(keypressTool);
		pi.registerTool(typeTextTool);
		pi.registerTool(setTextTool);
		pi.registerTool(waitTool);
		pi.registerTool(arrangeWindowTool);
		pi.registerTool(navigateBrowserTool);
		pi.registerTool(launchBrowserContextTool);
		pi.registerTool(evaluateBrowserTool);
		pi.registerTool(computerActionsTool);
	} catch (error) {
		if (isDuplicateToolConflict(error)) {
			return;
		}

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

		if (!ctx.hasUI) {
			return;
		}

		try {
			await ensureComputerUseSetup(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-computer-use is not ready yet. ${message}`, "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadComputerUseConfig(ctx.cwd);
		reconstructStateFromBranch(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopBridge();
	});
}
