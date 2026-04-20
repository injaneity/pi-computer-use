import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	executeClick,
	executeDoubleClick,
	executeDrag,
	executeKeypress,
	executeMoveMouse,
	executeScreenshot,
	executeScroll,
	executeTypeText,
	executeWait,
	prepareKeypressArguments,
	reconstructStateFromBranch,
	stopBridge,
} from "../src/bridge.js";

const MouseButtonSchema = StringEnum(["left", "right", "wheel", "back", "forward"] as const);

const screenshotTool = defineTool({
	name: "screenshot",
	label: "Screenshot",
	description: "Capture the current controlled macOS window, or select a new target window by app and title.",
	promptSnippet: "Capture and select a macOS window. Call this first and to switch windows.",
	promptGuidelines: [
		"Call screenshot first to choose a window and get coordinates.",
		"Call screenshot(app, windowTitle) to switch the controlled window.",
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
	description: "Click inside the current controlled window at screenshot-relative coordinates.",
	promptSnippet: "Click in the current window at coordinates from the latest screenshot.",
	promptGuidelines: [
		"Coordinates are window-relative screenshot pixels from the latest screenshot.",
		"This tool returns a fresh screenshot after a successful click.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Number({ description: "X coordinate in screenshot pixels" }),
		y: Type.Number({ description: "Y coordinate in screenshot pixels" }),
		button: Type.Optional(MouseButtonSchema),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeClick(toolCallId, params, signal, onUpdate, ctx);
	},
});

const doubleClickTool = defineTool({
	name: "double_click",
	label: "Double Click",
	description: "Double-click in the current controlled window at screenshot-relative coordinates.",
	promptSnippet: "Double-click at coordinates from the latest screenshot of the current window.",
	promptGuidelines: [
		"Use this for open/select behavior that needs a double-click.",
		"Returns an updated screenshot after success.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Number({ description: "X coordinate in screenshot pixels" }),
		y: Type.Number({ description: "Y coordinate in screenshot pixels" }),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeDoubleClick(toolCallId, params, signal, onUpdate, ctx);
	},
});

const moveMouseTool = defineTool({
	name: "move_mouse",
	label: "Move Mouse",
	description: "Move the mouse in the current controlled window to reveal hover-only UI.",
	promptSnippet: "Move the mouse to coordinates in the current window.",
	promptGuidelines: [
		"Use for hover states and tooltip-driven UI.",
		"Coordinates are from the latest screenshot; returns a fresh screenshot.",
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
	description: "Drag along a coordinate path in the current controlled window.",
	promptSnippet: "Drag along a screenshot-relative path in the current window.",
	promptGuidelines: [
		"Path points must come from the latest screenshot.",
		"Use at least two points. Returns an updated screenshot.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		path: Type.Array(
			Type.Object({
				x: Type.Number({ description: "X coordinate in screenshot pixels" }),
				y: Type.Number({ description: "Y coordinate in screenshot pixels" }),
			}),
			{ minItems: 2 },
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
	description: "Scroll at a point in the current controlled window using signed deltas.",
	promptSnippet: "Scroll at screenshot-relative coordinates in the current window.",
	promptGuidelines: [
		"scrollX and scrollY are signed input deltas.",
		"Returns a fresh screenshot after scrolling.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Number({ description: "X coordinate in screenshot pixels" }),
		y: Type.Number({ description: "Y coordinate in screenshot pixels" }),
		scrollX: Type.Number({ description: "Signed horizontal scroll delta" }),
		scrollY: Type.Number({ description: "Signed vertical scroll delta" }),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeScroll(toolCallId, params, signal, onUpdate, ctx);
	},
});

const typeTextTool = defineTool({
	name: "type_text",
	label: "Type Text",
	description: "Type text into the currently focused control in the current controlled window.",
	promptSnippet: "Type into the focused control in the current window.",
	promptGuidelines: [
		"Click a field first if needed, then call type_text.",
		"Returns an updated screenshot after typing.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.String({ description: "Text to type" }),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeTypeText(toolCallId, params, signal, onUpdate, ctx);
	},
});

const keypressTool = defineTool({
	name: "keypress",
	label: "Keypress",
	description: "Press a key or shortcut in the current controlled window.",
	promptSnippet: "Press keyboard shortcuts in the current window.",
	promptGuidelines: [
		"Use normalized key arrays like ['CMD','L'] or ['SHIFT','TAB'].",
		"Returns an updated screenshot after keypress.",
	],
	executionMode: "sequential",
	prepareArguments: prepareKeypressArguments,
	parameters: Type.Object({
		keys: Type.Array(Type.String({ description: "Key token, e.g. CMD, ENTER, A" }), { minItems: 1 }),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeKeypress(toolCallId, params, signal, onUpdate, ctx);
	},
});

const waitTool = defineTool({
	name: "wait",
	label: "Wait",
	description: "Pause briefly, then return a fresh screenshot of the current controlled window.",
	promptSnippet: "Wait briefly and refresh the current window screenshot.",
	promptGuidelines: [
		"Use this for loading, animations, and polling async UI updates.",
		"Returns a new screenshot after waiting.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		ms: Type.Optional(Type.Number({ description: "Milliseconds to wait (default ~1000ms)" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeWait(toolCallId, params, signal, onUpdate, ctx);
	},
});

export default function computerUseExtension(pi: ExtensionAPI): void {
	pi.registerTool(screenshotTool);
	pi.registerTool(clickTool);
	pi.registerTool(doubleClickTool);
	pi.registerTool(moveMouseTool);
	pi.registerTool(dragTool);
	pi.registerTool(scrollTool);
	pi.registerTool(typeTextTool);
	pi.registerTool(keypressTool);
	pi.registerTool(waitTool);

	pi.on("session_start", async (_event, ctx) => {
		reconstructStateFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructStateFromBranch(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopBridge();
	});
}
