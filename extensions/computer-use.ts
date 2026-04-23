import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	ensureComputerUseSetup,
	executeClick,
	executeComputerActions,
	executeDoubleClick,
	executeDrag,
	executeKeypress,
	executeMoveMouse,
	executeScroll,
	executeSetText,
	executeScreenshot,
	executeTypeText,
	executeWait,
	reconstructStateFromBranch,
	stopBridge,
} from "../src/bridge.js";

const screenshotTool = defineTool({
	name: "screenshot",
	label: "Screenshot",
	description: "Capture the current controlled macOS window, returning semantic AX targets and attaching an image only when fallback is needed.",
	promptSnippet: "Capture and select a macOS window. Call this first and to switch windows.",
	promptGuidelines: [
		"Call screenshot first to choose a window and inspect the latest UI state.",
		"If screenshot returns AX targets, prefer those targets over coordinate clicks.",
		"Call screenshot(app, windowTitle) to switch the controlled window.",
		"For browsers, prefer a separate window for agent work instead of opening a new tab in the user's current window.",
		"In strict AX mode, do not bootstrap a new browser window; target an existing dedicated browser window instead.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		app: Type.Optional(Type.String({ description: "Optional app name, e.g. Safari" })),
		windowTitle: Type.Optional(Type.String({ description: "Optional window title filter" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeScreenshot(toolCallId, params, signal, onUpdate, ctx);
	},
});

const clickTool = defineTool({
	name: "click",
	label: "Click",
	description: "Click inside the current controlled window by AX target ref or screenshot-relative coordinates.",
	promptSnippet: "Click in the current window using coordinates from the latest screenshot or an AX target ref like @e1.",
	promptGuidelines: [
		"When screenshot returns AX targets, prefer click(ref=@eN) and use coordinates only when no suitable AX target is available.",
		"Coordinates are window-relative screenshot pixels from the latest screenshot.",
		"This tool returns the latest semantic state and attaches an image only when fallback is needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixels" })),
		y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixels" })),
		ref: Type.Optional(Type.String({ description: "Optional AX target ref from the latest screenshot, e.g. @e1" })),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		clickCount: Type.Optional(Type.Number({ description: "Number of clicks, default 1" })),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeClick(toolCallId, params, signal, onUpdate, ctx);
	},
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
		ref: Type.Optional(Type.String({ description: "Optional AX target ref from the latest screenshot, e.g. @e1" })),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeDoubleClick(toolCallId, params, signal, onUpdate, ctx);
	},
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
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeMoveMouse(toolCallId, params, signal, onUpdate, ctx);
	},
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
		path: Type.Array(
			Type.Union([
				Type.Object({ x: Type.Number(), y: Type.Number() }),
				Type.Tuple([Type.Number(), Type.Number()]),
			]),
			{ minItems: 2, description: "At least two points, each as {x,y} or [x,y]" },
		),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeDrag(toolCallId, params, signal, onUpdate, ctx);
	},
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
		x: Type.Number({ description: "X coordinate in screenshot pixels" }),
		y: Type.Number({ description: "Y coordinate in screenshot pixels" }),
		scrollX: Type.Optional(Type.Number({ description: "Horizontal scroll delta in pixels" })),
		scrollY: Type.Optional(Type.Number({ description: "Vertical scroll delta in pixels" })),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeScroll(toolCallId, params, signal, onUpdate, ctx);
	},
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
		keys: Type.Array(Type.String({ description: "Key name or chord, e.g. Enter, Tab, Cmd+L" }), {
			minItems: 1,
			description: "Keys to press. Modifier arrays like ['Command','L'] are treated as one chord.",
		}),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeKeypress(toolCallId, params, signal, onUpdate, ctx);
	},
});

const typeTextTool = defineTool({
	name: "type_text",
	label: "Type Text",
	description: "Insert text into the currently focused control in the current controlled window.",
	promptSnippet: "Type into the focused control in the current window.",
	promptGuidelines: [
		"Click a field first if needed, then call type_text.",
		"This inserts at the current cursor/selection. Use set_text when you need to replace the whole focused value.",
		"Returns the latest semantic state and attaches an image only when fallback is needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.String({ description: "Text to type" }),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeTypeText(toolCallId, params, signal, onUpdate, ctx);
	},
});

const setTextTool = defineTool({
	name: "set_text",
	label: "Set Text",
	description: "Replace the value of the currently focused AX text control.",
	promptSnippet: "Replace the focused text control value using AX set-value semantics.",
	promptGuidelines: [
		"Use this when you need replacement semantics rather than insertion.",
		"Click a field first if needed, then call set_text.",
		"For Enter, Tab, backspace, or shortcuts, use keypress.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.String({ description: "Replacement text value" }),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeSetText(toolCallId, params, signal, onUpdate, ctx);
	},
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
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeWait(toolCallId, params, signal, onUpdate, ctx);
	},
});

const batchedActionSchema = Type.Union([
	Type.Object({
		type: Type.Literal("click"),
		x: Type.Optional(Type.Number()),
		y: Type.Optional(Type.Number()),
		ref: Type.Optional(Type.String()),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		clickCount: Type.Optional(Type.Number()),
		captureId: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("double_click"),
		x: Type.Optional(Type.Number()),
		y: Type.Optional(Type.Number()),
		ref: Type.Optional(Type.String()),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
		captureId: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("move_mouse"),
		x: Type.Number(),
		y: Type.Number(),
		captureId: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("drag"),
		path: Type.Array(Type.Union([Type.Object({ x: Type.Number(), y: Type.Number() }), Type.Tuple([Type.Number(), Type.Number()])]), {
			minItems: 2,
		}),
		captureId: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("scroll"),
		x: Type.Number(),
		y: Type.Number(),
		scrollX: Type.Optional(Type.Number()),
		scrollY: Type.Optional(Type.Number()),
		captureId: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("keypress"),
		keys: Type.Array(Type.String(), { minItems: 1 }),
	}),
	Type.Object({
		type: Type.Literal("type_text"),
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("set_text"),
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("wait"),
		ms: Type.Optional(Type.Number()),
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
	],
	executionMode: "sequential",
	parameters: Type.Object({
		actions: Type.Array(batchedActionSchema, { minItems: 1, maxItems: 20, description: "One to twenty actions to run sequentially" }),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id for the batch" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeComputerActions(toolCallId, params, signal, onUpdate, ctx);
	},
});

function isDuplicateToolConflict(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /Tool ".*" conflicts with /.test(error.message);
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	try {
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
		pi.registerTool(computerActionsTool);
	} catch (error) {
		if (isDuplicateToolConflict(error)) {
			return;
		}

		throw error;
	}

	pi.on("session_start", async (_event, ctx) => {
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
		reconstructStateFromBranch(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopBridge();
	});
}
