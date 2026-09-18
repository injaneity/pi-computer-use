import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ensureComputerUseSetup,
	executeAct,
	executeEvaluateBrowser,
	executeExpandUi,
	executeInspectUi,
	executeJevObserve,
	executeJevRun,
	executeJevStep,
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
import { getComputerUseConfig, getLoadedComputerUseConfig, loadComputerUseConfig, resetComputerUseConfig, updateComputerUseConfig } from "../src/config.ts";
import { describeJevDecisionProvider, loadJevTextConfig } from "../src/jev/policy.ts";

const stateId = Type.String({ description: "Required state id owning every @e ref used by this operation" });
const point = { x: Type.Number(), y: Type.Number() };
const mouseButton = Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]));
const clickByRef = Type.Object({ action: Type.Literal("click"), ref: Type.String(), button: mouseButton, clickCount: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })) });
const clickByPoint = Type.Object({ action: Type.Literal("click"), ...point, button: mouseButton, clickCount: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })) });
const uiAction = Type.Union([
	Type.Object({ action: Type.Literal("press"), ref: Type.String({ description: "Actionable outline ref" }) }),
	clickByRef,
	clickByPoint,
	Type.Object({ action: Type.Literal("setText"), ref: Type.String({ description: "Editable outline ref" }), text: Type.String() }),
	Type.Object({ action: Type.Literal("typeText"), ref: Type.Optional(Type.String({ description: "Omit after a click to type into the focus established by that click" })), text: Type.String() }),
	Type.Object({ action: Type.Literal("keypress"), ref: Type.Optional(Type.String({ description: "Omit to send keys to the focused control" })), keys: Type.Array(Type.String(), { minItems: 1 }) }),
	Type.Object({ action: Type.Literal("scroll"), ref: Type.Optional(Type.String()), scrollX: Type.Optional(Type.Number()), scrollY: Type.Optional(Type.Number()) }),
	Type.Object({ action: Type.Literal("drag"), path: Type.Array(Type.Object(point), { minItems: 2 }) }),
	Type.Object({ action: Type.Literal("moveMouse"), ...point }),
]);

const conditionProperties = {
	ref: Type.Optional(Type.String({ description: "Specific @e ref to test", maxLength: 128 })),
	scopeRef: Type.Optional(Type.String({ description: "Restrict matching to this @e subtree", maxLength: 128 })),
	text: Type.Optional(Type.String({ description: "Text that must match", maxLength: 512 })),
	role: Type.Optional(Type.String({ description: "Exact normalized role", maxLength: 128 })),
	value: Type.Optional(Type.String({ description: "Exact normalized value; normally pair with ref" })),
	until: Type.Optional(Type.Union([Type.Literal("present"), Type.Literal("absent")], { description: "Desired condition, default present" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait, default 10000ms", minimum: 100, maximum: 60000 })),
};

const findTool = defineTool({
	name: "find_roots",
	label: "Find Roots",
	description: "Find a bounded, ranked set of controllable UI roots with refs, geometry, and focus state.",
	promptSnippet: "Find a target root before observe_ui when needed.",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Ranked app or title text", maxLength: 256 })),
		app: Type.Optional(Type.String({ description: "Exact normalized app name", maxLength: 256 })),
		bundleId: Type.Optional(Type.String({ description: "Exact bundle id" })),
		pid: Type.Optional(Type.Number({ description: "Exact process id" })),
		kind: Type.Optional(Type.Union([Type.Literal("window"), Type.Literal("menu"), Type.Literal("sheet"), Type.Literal("popover"), Type.Literal("dialog"), Type.Literal("browser_page")], { description: "Exact root kind" })),
	}),
	execute: executeFind,
});

const observeTool = defineTool({
	name: "observe_ui",
	label: "Observe UI",
	description: "Capture the current/frontmost root or one exact @r root and return a bounded UI outline.",
	promptSnippet: "Primary UI observation tool. Follow with search_ui, expand_ui, inspect_ui, or act_ui.",
	promptGuidelines: [
		"Use mode=semantic to skip OCR and images, visual to force them, and fused for automatic selection.",
		"Use @e outline refs from observe_ui/search_ui for act_ui; pictureOnly refs are coordinate-only and blocked by UI-tree-only policy.",
	],
	parameters: Type.Object({
		root: Type.Optional(Type.String({ description: "Exact @r ref issued by find_roots" })),
		mode: Type.Optional(Type.Union([Type.Literal("semantic"), Type.Literal("visual"), Type.Literal("fused")], { description: "Observation mode, default fused" })),
	}),
	execute: executeObserve,
});

const searchUiTool = defineTool({
	name: "search_ui",
	label: "Search UI",
	description: "Return a bounded, deterministically ranked search of the cached outline. At least one predicate is required.",
	promptSnippet: "Find targets not shown in the compact observe_ui output; refine broad searches instead of paging matches.",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Human-readable text or label", maxLength: 256 })),
		role: Type.Optional(Type.String({ description: "Exact normalized role, e.g. button", maxLength: 128 })),
		capability: Type.Optional(Type.String({ description: "Exact capability, e.g. press", maxLength: 128 })),
		stateId,
	}),
	execute: executeSearchUi,
});

const expandUiTool = defineTool({
	name: "expand_ui",
	label: "Expand UI",
	description: "Unfold bounded local outline context for one @e ref.",
	promptSnippet: "Expand a specific ref instead of dumping unrelated UI.",
	parameters: Type.Object({ ref: Type.String(), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 8, description: "Subtree depth, default 3" })), stateId }),
	execute: executeExpandUi,
});

const inspectUiTool = defineTool({
	name: "inspect_ui",
	label: "Inspect UI",
	description: "Inspect one exact outline ref with fields, geometry, capabilities, and annotations.",
	promptSnippet: "Use when a target's evidence or provenance matters.",
	parameters: Type.Object({ ref: Type.String(), stateId }),
	execute: executeInspectUi,
});

const actTool = defineTool({
	name: "act_ui",
	label: "Act",
	description: "Perform one or more precisely targeted checked actions and return the successor state.",
	promptSnippet: "Pass dependent click/type steps together and use expect for observable completion.",
	promptGuidelines: ["After clicking an editable region, omit ref from typeText/keypress so input follows the established focus."],
	parameters: Type.Object({ stateId, expect: Type.Optional(Type.Object(conditionProperties)), actions: Type.Array(uiAction, { minItems: 1, maxItems: 20 }) }),
	execute: executeAct,
});

const readTextTool = defineTool({
	name: "read_text",
	label: "Read Text",
	description: "Read a fixed-size page from an @e UI ref or immutable @o truncated-output ref.",
	promptSnippet: "Use @e with its stateId; @o continuation refs don't need stateId.",
	parameters: Type.Object({ ref: Type.String(), offset: Type.Optional(Type.Number({ minimum: 0 })), stateId: Type.Optional(stateId) }),
	execute: executeReadText,
});

const waitForTool = defineTool({
	name: "wait_for",
	label: "Wait For",
	description: "Wait for one scoped UI condition and return the successor state.",
	promptSnippet: "Use after asynchronous UI changes instead of polling observe_ui.",
	parameters: Type.Object({ ...conditionProperties, stateId }),
	execute: executeWaitFor,
});

const launchBrowserTool = defineTool({
	name: "launch_browser",
	label: "Launch Browser Context",
	description: "Launch the configured Pi-managed CDP browser and return an observed browser-page state.",
	promptSnippet: "Use for browser work that needs a managed CDP context.",
	promptGuidelines: ["Prefer curl through bash when the page is directly fetchable."],
	parameters: Type.Object({ url: Type.Optional(Type.String({ maxLength: 8192 })) }),
	execute: executeLaunchBrowser,
});

const navigateBrowserTool = defineTool({
	name: "navigate_browser",
	label: "Navigate Browser",
	description: "Navigate an observed CDP browser-page state to an HTTP(S) URL.",
	promptSnippet: "Native browser windows use act_ui; this tool is CDP-only.",
	parameters: Type.Object({ url: Type.String({ maxLength: 8192 }), stateId }),
	execute: executeNavigateBrowser,
});

const evaluateBrowserTool = defineTool({
	name: "evaluate_browser",
	label: "Evaluate Browser",
	description: "Evaluate targeted JavaScript in a CDP browser-page state; returned output is strictly bounded.",
	promptSnippet: "Prefer observe/search/read; return selected fields, aggregates, or bounded slices.",
	parameters: Type.Object({ stateId, expression: Type.String({ maxLength: 65_536 }) }),
	execute: executeEvaluateBrowser,
});

const jevObserveTool = defineTool({
	name: "jev_observe",
	label: "Jev Observe",
	description: "Observe a CDP browser page as jev's indexed action space: one code-owned id per actionable element with its supported operations and dropdown option targets.",
	promptSnippet: "Use before jev_step; the returned table lists executable action ids.",
	promptGuidelines: [
		"A jev state is separate from observe_ui states; jev_step and jev_run only accept jev states.",
		"Prefer curated browser tools when a stable API exists; jev is for operating the page's own UI.",
	],
	parameters: Type.Object({
		root: Type.Optional(Type.String({ description: "Exact @r ref issued by find_roots for a browser_page root", maxLength: 64 })),
	}),
	execute: executeJevObserve,
});

const jevStepTool = defineTool({
	name: "jev_step",
	label: "Jev Step",
	description: "Execute one observed jev action through code-owned guards (freshness, geometry, click occlusion) and return the successor state.",
	promptSnippet: "Pass an action id from jev_observe; omit it with a goal to let the TypeSafe policy choose one.",
	promptGuidelines: [
		"The executor never accepts selectors, coordinates, or scripts; only an observed action id.",
		"A stale page consumes the decision without mutating; observe again before retrying.",
	],
	parameters: Type.Object({
		stateId,
		action: Type.Optional(Type.String({ description: "Code-owned action id from jev_observe, e.g. e3", maxLength: 64 })),
		goal: Type.Optional(Type.String({ description: "Natural-language goal; required when action is omitted so the TypeSafe policy can decide", maxLength: 4000 })),
		text: Type.Optional(Type.String({ description: "Explicit TYPE_TEXT value; otherwise the configured text helper generates it", maxLength: 2000 })),
	}),
	execute: executeJevStep,
});

const jevRunTool = defineTool({
	name: "jev_run",
	label: "Jev Run",
	description: "Run jev's bounded autonomous policy loop for one goal and return the execution trace; a DONE choice is never treated as verified success.",
	promptSnippet: "Use when the whole goal should be driven by the TypeSafe policy instead of step-by-step agent choices.",
	promptGuidelines: ["Verify the final outcome independently; jev_run reports an unverified run status."],
	parameters: Type.Object({
		goal: Type.String({ description: "Natural-language goal for the whole run", maxLength: 4000 }),
		stateId: Type.Optional(stateId),
		root: Type.Optional(Type.String({ description: "Exact @r ref issued by find_roots for a browser_page root", maxLength: 64 })),
		maxSteps: Type.Optional(Type.Number({ description: "Action budget; capped by configuration and the engine limit", minimum: 1, maximum: 60 })),
	}),
	execute: executeJevRun,
});

function formatConfigStatus(): string {
	const loaded = getLoadedComputerUseConfig();
	return [
		"pi-computer-use configuration",
		`browser_use: ${loaded.config.browser_use ? "enabled" : "disabled"}`,
		`managed_browser: ${loaded.config.managed_browser}`,
		`headless: ${loaded.config.headless ? "enabled" : "disabled"}`,
		`cursor_overlay: ${loaded.config.cursor_overlay ? "enabled" : "disabled"}`,
		`jev_enabled: ${loaded.config.jev_enabled ? "enabled" : "disabled"}`,
		`jev_decide: ${loaded.config.jev_decide ? "enabled" : "disabled"}`,
		`jev_backend: ${loaded.config.jev_backend}${loaded.config.jev_model ? ` (${loaded.config.jev_model})` : ""}`,
		`jev_decision: ${describeJevDecisionProvider()}`,
		`jev_gateway_zdr: ${loaded.config.jev_gateway_zdr ? "on" : "off"}`,
		`jev_max_steps: ${loaded.config.jev_max_steps}`,
		`jev_text_helper: ${loadJevTextConfig() ? "credentialed" : "no credential"}`,
		"",
		"Sources:",
		...loaded.sources.map((source) => `- ${source.path}: ${source.error ? `error: ${source.error}` : source.exists ? "loaded" : "not found"}`),
		`- env overrides: ${Object.keys(loaded.env).join(", ") || "none"}`,
	].join("\n");
}

/** Apply `/computer-use <setting> on|off` as a session-scoped override. */
function applyConfigCommand(args: string): string | undefined {
	const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const [subject, value] = tokens;
	const enabled = ["on", "enable", "enabled", "true", "1"].includes(value ?? "");
	const disabled = ["off", "disable", "disabled", "false", "0"].includes(value ?? "");
	if (!enabled && !disabled) return `Unknown value '${value ?? ""}'. Use on or off.`;
	if (subject === "jev" || subject === "jev-enabled") {
		updateComputerUseConfig({ jev_enabled: enabled });
		return `jev tools ${enabled ? "enabled" : "disabled"} for this session.`;
	}
	if (subject === "jev-decide" || subject === "jev-decision" || subject === "decide") {
		updateComputerUseConfig({ jev_decide: enabled });
		return `jev decision-making ${enabled ? "enabled" : "disabled"} for this session.`;
	}
	return `Unknown setting '${subject}'. Use: jev on|off, jev-decide on|off.`;
}

const BASE_TOOLS = [findTool, observeTool, searchUiTool, expandUiTool, inspectUiTool, actTool, readTextTool, waitForTool, launchBrowserTool, navigateBrowserTool, evaluateBrowserTool];
const JEV_TOOLS = [jevObserveTool, jevStepTool, jevRunTool];
const JEV_TOOL_NAMES = ["jev_observe", "jev_step", "jev_run"];
let jevToolsRegistered = false;

/**
 * Keep the model-facing surface aligned with `jev_enabled`. The jev tools are
 * registered lazily and only active while the layer is enabled, so a disabled
 * layer contributes no prompt snippet and no callable tool. `setActiveTools`
 * makes the switch reversible in-session, including via `/computer-use jev on`.
 */
function syncJevTools(pi: ExtensionAPI): void {
	const enabled = getComputerUseConfig().jev_enabled;
	if (enabled && !jevToolsRegistered) {
		for (const tool of JEV_TOOLS) pi.registerTool(tool);
		jevToolsRegistered = true;
	}
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
	const base = pi.getActiveTools().filter((name) => !JEV_TOOL_NAMES.includes(name));
	pi.setActiveTools(enabled ? [...base, ...JEV_TOOL_NAMES] : base);
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	for (const tool of BASE_TOOLS) pi.registerTool(tool);

	pi.registerCommand("computer-use", {
		description: "Show pi-computer-use configuration, or set jev on|off and jev-decide on|off",
		handler: async (args, ctx) => {
			loadComputerUseConfig(ctx.cwd);
			const change = applyConfigCommand(String(args ?? ""));
			syncJevTools(pi);
			ctx.ui.notify([change, formatConfigStatus()].filter(Boolean).join("\n\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// A new session drops session-scoped toggles before reloading files and env.
		resetComputerUseConfig(ctx.cwd);
		syncJevTools(pi);
		reconstructStateFromBranch(ctx);
		if (!ctx.hasUI) return;
		try { await ensureComputerUseSetup(ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
	});

	pi.on("session_shutdown", async () => {
		await shutdownComputerUseSession();
	});
}
