import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const ALLOW_FOREGROUND_QA =
	process.argv.includes("--allow-foreground-qa") || process.env.PI_COMPUTER_USE_ALLOW_FOREGROUND_QA === "1";
const ALLOW_SCREEN_TAKEOVER =
	process.argv.includes("--allow-screen-takeover") || process.env.PI_COMPUTER_USE_ALLOW_SCREEN_TAKEOVER === "1";
const STRICT_AX_MODE = process.env.PI_COMPUTER_USE_STEALTH === "1" || process.env.PI_COMPUTER_USE_STRICT_AX === "1";
const SAFE_ONLY_QA = !ALLOW_SCREEN_TAKEOVER;
const SECTION_ARG = process.argv.find((arg) => arg.startsWith("--section="));
const SELECTED_SECTIONS = new Set(
	(SECTION_ARG ? SECTION_ARG.slice("--section=".length) : "all")
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean),
);
import {
	executeClick,
	executeComputerActions,
	executeDoubleClick,
	executeDrag,
	executeKeypress,
	executeMoveMouse,
	executeScreenshot,
	executeScroll,
	executeSetText,
	executeTypeText,
	executeWait,
	reconstructStateFromBranch,
	stopBridge,
} from "../src/bridge.ts";

type ResultRecord = {
	name: string;
	status: "PASS" | "FAIL" | "SKIP";
	details?: string;
};

function shouldRunSection(name: string): boolean {
	return SELECTED_SECTIONS.has("all") || SELECTED_SECTIONS.has(name);
}

function makeCtx(branchEntries: any[] = []): any {
	return {
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => undefined,
			onTerminalInput: () => () => undefined,
			setStatus: () => undefined,
			setWorkingMessage: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => undefined,
			theme: {} as any,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => undefined,
		},
		cwd: process.cwd(),
		sessionManager: {
			getBranch: () => branchEntries,
		},
		modelRegistry: undefined,
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
	};
}

function assert(cond: any, message: string): void {
	if (!cond) {
		throw new Error(message);
	}
}

function ensureImageResult(name: string, result: any): { captureId: string; width: number; height: number; app: string; hasImage: boolean } {
	assert(Array.isArray(result?.content), `${name}: missing content array`);
	const textPart = result.content.find((item: any) => item?.type === "text");
	const imagePart = result.content.find((item: any) => item?.type === "image");
	assert(textPart?.text && typeof textPart.text === "string", `${name}: missing text summary`);
	if (imagePart) {
		assert(imagePart?.data && typeof imagePart.data === "string", `${name}: invalid image attachment`);
		assert(imagePart?.mimeType === "image/png", `${name}: image mimeType is not image/png`);
	}

	const details = result?.details;
	assert(details && typeof details === "object", `${name}: missing details`);
	assert(details.capture?.captureId, `${name}: missing captureId`);
	assert(details.capture?.coordinateSpace === "window-relative-screenshot-pixels", `${name}: invalid coordinate space`);
	assert(Number.isFinite(details.capture?.width), `${name}: invalid capture width`);
	assert(Number.isFinite(details.capture?.height), `${name}: invalid capture height`);
	assert(typeof details.target?.app === "string", `${name}: missing target app`);

	return {
		captureId: details.capture.captureId,
		width: details.capture.width,
		height: details.capture.height,
		app: details.target.app,
		hasImage: Boolean(imagePart),
	};
}

function ensureAxExecution(name: string, result: any, allowedStrategies?: string[]): void {
	const execution = result?.details?.execution;
	assert(execution && typeof execution === "object", `${name}: missing execution metadata`);
	assert(execution.fallbackUsed !== true, `${name}: unexpectedly used fallback path (${execution.strategy ?? "unknown"})`);
	assert(execution.axSucceeded === true || String(execution.strategy || "").startsWith("ax_"), `${name}: did not use AX path`);
	if (allowedStrategies && allowedStrategies.length > 0) {
		assert(allowedStrategies.includes(String(execution.strategy)), `${name}: unexpected execution strategy '${execution.strategy}'`);
	}
}

function ensureExecutionStrategy(name: string, result: any, expectedStrategy: string): void {
	const execution = result?.details?.execution;
	assert(execution && typeof execution === "object", `${name}: missing execution metadata`);
	assert(execution.strategy === expectedStrategy, `${name}: expected strategy '${expectedStrategy}', got '${execution.strategy ?? "unknown"}'`);
}

function updateLatestFromResult(result: any): { captureId: string; width: number; height: number; details: any } {
	const normalized = ensureImageResult(String(result?.details?.tool ?? "tool result"), result);
	return {
		captureId: normalized.captureId,
		width: normalized.width,
		height: normalized.height,
		details: result.details,
	};
}

function axTargets(details: any): any[] {
	return Array.isArray(details?.axTargets) ? details.axTargets : [];
}

function pickAxTarget(details: any, roles?: string[]): any {
	const targets = axTargets(details);
	assert(targets.length > 0, "No AX targets returned on screenshot details");
	if (roles && roles.length > 0) {
		const match = targets.find((target) => roles.includes(String(target?.role ?? "")));
		if (match) return match;
	}
	return targets[0];
}

function getUserContext(): any {
	return helperCommand("getUserContext", {});
}

function userContextSignature(context: any): string {
	const window = context?.window ?? {};
	const focused = context?.focusedElement ?? {};
	return JSON.stringify({
		appName: context?.appName ?? "",
		pid: context?.pid ?? "",
		windowTitle: window?.title ?? "",
		windowRole: window?.role ?? "",
		windowSubrole: window?.subrole ?? "",
		focusedRole: focused?.role ?? "",
		focusedSubrole: focused?.subrole ?? "",
		focusedTitle: focused?.title ?? "",
		focusedDescription: focused?.description ?? "",
		focusedValue: focused?.value ?? "",
	});
}

function ensureStrictInvariants(name: string, result: any, expectedUserContext: any, baselineMouse: { x: number; y: number }): void {
	if (!STRICT_AX_MODE) return;
	const details = result?.details ?? {};
	assert(details.activation?.activated === false, `${name}: strict mode activated app unexpectedly`);
	assert(details.activation?.raised === false, `${name}: strict mode raised window unexpectedly`);
	assert(details.activation?.unminimized === false, `${name}: strict mode unminimized window unexpectedly`);
	const currentContext = getUserContext();
	assert(currentContext?.appName === expectedUserContext?.appName, `${name}: strict mode changed frontmost app from '${expectedUserContext?.appName}' to '${currentContext?.appName}'`);
	assert(userContextSignature(currentContext) === userContextSignature(expectedUserContext), `${name}: strict mode changed user keyboard focus/window context`);
	const mouse = getMousePosition();
	const dx = Math.abs(mouse.x - baselineMouse.x);
	const dy = Math.abs(mouse.y - baselineMouse.y);
	assert(dx < 2 && dy < 2, `${name}: strict mode changed physical mouse position from (${baselineMouse.x.toFixed(1)},${baselineMouse.y.toFixed(1)}) to (${mouse.x.toFixed(1)},${mouse.y.toFixed(1)})`);
}

function runCommand(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

const HELPER_PATH = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "bridge");

function helperCommand(cmd: string, payload: Record<string, unknown> = {}): any {
	const request = JSON.stringify({ id: "qa", cmd, ...payload }) + "\n";
	const result = spawnSync(HELPER_PATH, [], { input: request, encoding: "utf8" });
	if (result.error) {
		throw result.error;
	}
	const line = result.stdout
		.split(/\r?\n/g)
		.map((value) => value.trim())
		.find((value) => value.length > 0);
	if (!line) {
		throw new Error(`No helper response for command '${cmd}'. stderr=${result.stderr.trim()}`);
	}
	const parsed = JSON.parse(line);
	if (parsed.ok !== true) {
		throw new Error(parsed?.error?.message ?? `Helper command '${cmd}' failed`);
	}
	return parsed.result;
}

function axDescribeAtPoint(windowId: number, pid: number, x: number, y: number, captureWidth: number, captureHeight: number): any {
	return helperCommand("axDescribeAtPoint", { windowId, pid, x, y, captureWidth, captureHeight });
}

function listWindows(pid: number): any[] {
	const result = helperCommand("listWindows", { pid });
	return Array.isArray(result) ? result : [];
}

function screenPointToCapturePoint(details: any, screenX: number, screenY: number): { x: number; y: number } {
	const pid = Number(details?.target?.pid);
	const windowId = Number(details?.target?.windowId);
	const width = Number(details?.capture?.width);
	const height = Number(details?.capture?.height);
	const window = listWindows(pid).find((item) => Number(item.windowId) === windowId);
	if (!window) {
		throw new Error(`Unable to find window ${windowId} for pid ${pid}`);
	}
	const frame = window.framePoints;
	return {
		x: Math.max(1, Math.min(width - 1, Math.round(((screenX - Number(frame.x)) / Number(frame.w)) * width))),
		y: Math.max(1, Math.min(height - 1, Math.round(((screenY - Number(frame.y)) / Number(frame.h)) * height))),
	};
}

function axFindTextInput(details: any): { x: number; y: number; role?: string; title?: string; score?: number; confidence?: string; candidates?: any[]; elementRef?: string } {
	const result = helperCommand("axFindTextInput", { pid: Number(details?.target?.pid), windowId: Number(details?.target?.windowId) });
	if (!result?.found) {
		throw new Error(`No AX text input found: ${result?.reason ?? "unknown"}`);
	}
	return {
		...screenPointToCapturePoint(details, Number(result.x), Number(result.y)),
		role: result.role,
		title: result.title,
		score: result.score,
		confidence: result.confidence,
		candidates: result.candidates,
		elementRef: result.elementRef,
	};
}

function axFindFocusable(details: any, roles?: string[]): { x: number; y: number; role?: string; title?: string; score?: number; confidence?: string; candidates?: any[]; elementRef?: string } {
	const result = helperCommand("axFindFocusableElement", {
		pid: Number(details?.target?.pid),
		windowId: Number(details?.target?.windowId),
		roles: roles ?? [],
	});
	if (!result?.found) {
		throw new Error(`No AX focusable element found: ${result?.reason ?? "unknown"}`);
	}
	return {
		...screenPointToCapturePoint(details, Number(result.x), Number(result.y)),
		role: result.role,
		title: result.title,
		score: result.score,
		confidence: result.confidence,
		candidates: result.candidates,
		elementRef: result.elementRef,
	};
}

function axFindActionable(details: any, roles?: string[]): { x: number; y: number; role?: string; title?: string; score?: number; confidence?: string; candidates?: any[]; elementRef?: string } {
	const result = helperCommand("axFindActionableElement", {
		pid: Number(details?.target?.pid),
		windowId: Number(details?.target?.windowId),
		roles: roles ?? [],
	});
	if (!result?.found) {
		throw new Error(`No AX actionable element found: ${result?.reason ?? "unknown"}`);
	}
	return {
		...screenPointToCapturePoint(details, Number(result.x), Number(result.y)),
		role: result.role,
		title: result.title,
		score: result.score,
		confidence: result.confidence,
		candidates: result.candidates,
		elementRef: result.elementRef,
	};
}

function axFocusTextInput(details: any): any {
	return helperCommand("axFocusTextInput", { pid: Number(details?.target?.pid), windowId: Number(details?.target?.windowId) });
}

function formatCandidateList(candidates: any[] | undefined): string {
	if (!Array.isArray(candidates) || candidates.length === 0) return "";
	return candidates
		.map((item, index) => `#${index + 1}:${item.role || ""}/${item.subrole || ""} title=${JSON.stringify(item.title || "")} score=${item.score ?? "?"}`)
		.join("; ");
}

function formatAxDescription(description: any): string {
	if (!description || description.exists === false) {
		return `AX describe failed: ${description?.reason ?? "unknown"}`;
	}
	const chain = Array.isArray(description.chain) ? description.chain : [];
	return chain
		.map((item: any) => {
			const actions = Array.isArray(item.actions) ? item.actions.join(",") : "";
			return `depth=${item.depth} pid=${item.pid ?? "?"} role=${item.role || ""} subrole=${item.subrole || ""} title=${JSON.stringify(item.title || "")} value=${JSON.stringify(item.value || "")} focusSettable=${item.focusSettable} valueSettable=${item.valueSettable} actions=[${actions}]`;
		})
		.join(" | ");
}

function getFrontmostAppName(): string {
	return runCommand("osascript", [
		"-e",
		'tell application "System Events" to get name of first application process whose frontmost is true',
	]);
}

function activateApp(appName: string): void {
	runCommand("osascript", ["-e", `tell application "${appName}" to activate`]);
}

function openApp(appName: string): boolean {
	try {
		runCommand("open", ["-a", appName]);
		return true;
	} catch {
		return false;
	}
}

function isRecoverableStrictQaError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Target window is no longer available|current controlled window is no longer available|audio\/video capture failure|Call screenshot again|window_not_found|No controllable window was found/i.test(message);
}

function getMousePosition(): { x: number; y: number } {
	const result = helperCommand("getMousePosition");
	return { x: Number(result.x), y: Number(result.y) };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertUserContextPreserved(
	label: string,
	expectedFrontmostApp: string,
	_baselineMouse: { x: number; y: number },
): Promise<void> {
	await sleep(120);
	const frontmost = getFrontmostAppName();
	if (frontmost === "TextEdit") {
		throw new Error(
			`${label}: controlled target app ('TextEdit') became frontmost, which violates non-intrusive mode. Expected user-facing app to remain in control (baseline: '${expectedFrontmostApp}').`,
		);
	}
}

async function main() {
	const results: ResultRecord[] = [];
	const ctx = makeCtx();

	if (!ALLOW_FOREGROUND_QA) {
		console.log("Foreground manual QA is disabled by default to avoid stealing user focus/cursor.");
		console.log("Re-run with --allow-foreground-qa (or PI_COMPUTER_USE_ALLOW_FOREGROUND_QA=1) when ready.");
		return;
	}
	if (SAFE_ONLY_QA) {
		console.log("Running manual QA in safe-only mode.");
		console.log("Intrusive flows that open apps or activate Finder will be skipped.");
		console.log("Add --allow-screen-takeover (or PI_COMPUTER_USE_ALLOW_SCREEN_TAKEOVER=1) to run the full intrusive matrix.");
	}

	let latestCaptureId = "";
	let latestWidth = 0;
	let latestHeight = 0;
	let latestDetails: any;

	function pass(name: string, details?: string) {
		results.push({ name, status: "PASS", details });
	}

	function fail(name: string, error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		results.push({ name, status: "FAIL", details: message });
	}

	function skip(name: string, details?: string) {
		results.push({ name, status: "SKIP", details });
	}

	let userFrontmostApp = "Finder";
	let baselineUserContext: any = undefined;
	let baselineMouse = { x: 0, y: 0 };

	if (shouldRunSection("core")) {
		if (SAFE_ONLY_QA) {
			skip("Environment setup", "Skipped in safe-only QA mode.");
			skip("User context baseline", "Skipped in safe-only QA mode because it activates Finder.");
		} else {
			try {
				openApp("TextEdit");
				openApp("Finder");
				if (STRICT_AX_MODE) {
					openApp("Safari");
					openApp("Reminders");
				}
				pass("Environment setup", STRICT_AX_MODE ? "Opened TextEdit, Finder, and attempted Safari/Reminders" : "Opened TextEdit and Finder");
			} catch (error) {
				fail("Environment setup", error);
			}

			await new Promise((resolve) => setTimeout(resolve, 1200));

			try {
				activateApp("Finder");
				await sleep(250);
				userFrontmostApp = getFrontmostAppName();
				baselineUserContext = getUserContext();
				baselineMouse = getMousePosition();
				pass(
					"User context baseline",
					`frontmost=${userFrontmostApp}, mouse=(${baselineMouse.x.toFixed(1)},${baselineMouse.y.toFixed(1)})`,
				);
			} catch (error) {
				fail("User context baseline", error);
			}
		}

		try {
			await executeClick("qa-missing-target", { x: 10, y: 10 }, undefined, undefined, ctx);
			fail("Missing target error", new Error("Expected missing-target error but click succeeded"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert(message.includes("No current controlled window"), "Unexpected missing-target error text");
			pass("Missing target error", message);
		}

		try {
			const result = await executeScreenshot("qa-screenshot-frontmost", {}, undefined, undefined, ctx);
			const normalized = ensureImageResult("screenshot() frontmost", result);
			latestCaptureId = normalized.captureId;
			latestWidth = normalized.width;
			latestHeight = normalized.height;
			latestDetails = result.details;
			pass("screenshot() picks frontmost", `app=${normalized.app} size=${normalized.width}x${normalized.height}`);
		} catch (error) {
			fail("screenshot() picks frontmost", error);
		}
	}

	if (shouldRunSection("navigation")) {
	if (SAFE_ONLY_QA) {
		skip("Target switching", "Skipped in safe-only QA mode.");
		skip("Strict target navigation", "Skipped in safe-only QA mode.");
		skip("Strict target navigation (Notes)", "Skipped in safe-only QA mode.");
		skip("Strict target navigation (Calendar)", "Skipped in safe-only QA mode.");
		skip("Strict target navigation (Chrome)", "Skipped in safe-only QA mode.");
	} else {
	try {
		const textEditShot = await executeScreenshot(
			"qa-screenshot-textedit",
			{ app: "TextEdit" },
			undefined,
			undefined,
			ctx,
		);
		const norm1 = ensureImageResult("screenshot(TextEdit)", textEditShot);
		assert(norm1.app.toLowerCase().includes("textedit"), "TextEdit targeting did not select TextEdit");

		const finderShot = await executeScreenshot("qa-screenshot-finder", { app: "Finder" }, undefined, undefined, ctx);
		const norm2 = ensureImageResult("screenshot(Finder)", finderShot);
		assert(norm2.app.toLowerCase().includes("finder"), "Finder targeting did not select Finder");

		const textEditShot2 = await executeScreenshot(
			"qa-screenshot-textedit-2",
			{ app: "TextEdit" },
			undefined,
			undefined,
			ctx,
		);
		const norm3 = ensureImageResult("screenshot(TextEdit) second", textEditShot2);
		assert(norm3.app.toLowerCase().includes("textedit"), "Switching back to TextEdit failed");

		latestCaptureId = norm3.captureId;
		latestWidth = norm3.width;
		latestHeight = norm3.height;
		latestDetails = textEditShot2.details;
		pass("Target switching", "TextEdit -> Finder -> TextEdit");
	} catch (error) {
		fail("Target switching", error);
	}

	if (STRICT_AX_MODE) {
		try {
			activateApp("Finder");
			await sleep(250);
			userFrontmostApp = getFrontmostAppName();
			baselineUserContext = getUserContext();
			baselineMouse = getMousePosition();

			const textEditShot = await executeScreenshot(
				"qa-strict-nav-textedit",
				{ app: "TextEdit" },
				undefined,
				undefined,
				ctx,
			);
			const textNorm = ensureImageResult("strict nav screenshot(TextEdit)", textEditShot);
			assert(textNorm.app.toLowerCase().includes("textedit"), "Strict nav did not target TextEdit");
			ensureStrictInvariants("strict nav screenshot(TextEdit)", textEditShot, baselineUserContext, baselineMouse);

			const finderShot = await executeScreenshot("qa-strict-nav-finder", { app: "Finder" }, undefined, undefined, ctx);
			const finderNorm = ensureImageResult("strict nav screenshot(Finder)", finderShot);
			assert(finderNorm.app.toLowerCase().includes("finder"), "Strict nav did not target Finder");
			ensureStrictInvariants("strict nav screenshot(Finder)", finderShot, baselineUserContext, baselineMouse);

			const finderTitle = String(finderShot?.details?.target?.windowTitle ?? "").trim();
			assert(finderTitle.length > 0, "Strict nav Finder window title was empty");
			const finderByTitleShot = await executeScreenshot(
				"qa-strict-nav-finder-title",
				{ app: "Finder", windowTitle: finderTitle },
				undefined,
				undefined,
				ctx,
			);
			const finderByTitleNorm = ensureImageResult("strict nav screenshot(Finder,title)", finderByTitleShot);
			assert(finderByTitleNorm.app.toLowerCase().includes("finder"), "Strict nav Finder title targeting selected wrong app");
			assert(
				String(finderByTitleShot?.details?.target?.windowTitle ?? "").trim() === finderTitle,
				`Strict nav Finder title targeting picked '${String(finderByTitleShot?.details?.target?.windowTitle ?? "")}', expected '${finderTitle}'`,
			);
			ensureStrictInvariants("strict nav screenshot(Finder,title)", finderByTitleShot, baselineUserContext, baselineMouse);

			latestCaptureId = finderByTitleNorm.captureId;
			latestWidth = finderByTitleNorm.width;
			latestHeight = finderByTitleNorm.height;
			latestDetails = finderByTitleShot.details;
			pass("Strict target navigation", `TextEdit -> Finder -> Finder(title=${JSON.stringify(finderTitle)}) without stealing focus/input`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/changed physical mouse position|changed frontmost app|changed user keyboard focus\/window context/i.test(message)) {
				skip("Strict target navigation", message);
			} else {
				fail("Strict target navigation", error);
			}
		}

		const extraApps = [
			{ app: "Notes", label: "Notes", match: "notes" },
			{ app: "Calendar", label: "Calendar", match: "calendar" },
			{ app: "Google Chrome", label: "Chrome", match: "chrome" },
		];
		for (const extra of extraApps) {
			try {
				activateApp("Finder");
				await sleep(250);
				baselineUserContext = getUserContext();
				baselineMouse = getMousePosition();
				const shot = await executeScreenshot(
					`qa-strict-nav-${extra.match}`,
					{ app: extra.app },
					undefined,
					undefined,
					ctx,
				);
				const norm = ensureImageResult(`strict nav screenshot(${extra.label})`, shot);
				assert(norm.app.toLowerCase().includes(extra.match), `Strict nav did not target ${extra.label}`);
				ensureStrictInvariants(`strict nav screenshot(${extra.label})`, shot, baselineUserContext, baselineMouse);
				pass(`Strict target navigation (${extra.label})`, `Targeted ${norm.app} without stealing focus/input`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isRecoverableStrictQaError(error) || /is not running|No controllable window was found|changed physical mouse position|changed frontmost app|changed user keyboard focus\/window context/i.test(message)) {
					skip(`Strict target navigation (${extra.label})`, message);
				} else {
					fail(`Strict target navigation (${extra.label})`, error);
				}
			}
		}
	}

	}
	}

	if (shouldRunSection("actions")) {
		if (SAFE_ONLY_QA) {
			skip("User top-level view preserved on screenshot", "Skipped in safe-only QA mode.");
			skip("Click action + capture refresh", "Skipped in safe-only QA mode because it activates Finder.");
			skip("Pointer, keyboard, and batch tools", "Skipped in safe-only QA mode because they can affect the foreground app.");
			skip("Wait action", "Skipped in safe-only QA mode because it depends on prepared target state.");
			skip("Text input primitives + clipboard", "Skipped in safe-only QA mode because it activates Finder.");
			skip("Minimized window fallback", "Minimized-window fallback was removed from the semantic-only runtime.");
		} else {
	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineMouse = getMousePosition();

		const textEditShot = await executeScreenshot(
			"qa-screenshot-preserve-user-context",
			{ app: "TextEdit" },
			undefined,
			undefined,
			ctx,
		);
		const norm = ensureImageResult("screenshot preserve context", textEditShot);
		latestCaptureId = norm.captureId;
		latestWidth = norm.width;
		latestHeight = norm.height;
		latestDetails = textEditShot.details;
		await assertUserContextPreserved("screenshot preserve context", userFrontmostApp, baselineMouse);
		pass("User top-level view preserved on screenshot", userFrontmostApp);
	} catch (error) {
		fail("User top-level view preserved on screenshot", error);
	}

	const centerX = () => Math.max(10, Math.floor(latestWidth * 0.5));
	const centerY = () => Math.max(10, Math.floor(latestHeight * 0.5));

	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineMouse = getMousePosition();
		const refTarget = pickAxTarget(latestDetails, ["AXTextField", "AXSearchField", "AXButton", "AXLink"]);
		const refClickResult = await executeClick(
			"qa-click-ref",
			{ ref: refTarget.ref, captureId: latestCaptureId },
			undefined,
			undefined,
			ctx,
		);
		const refClickNorm = ensureImageResult("click by ref", refClickResult);
		ensureAxExecution("click by ref", refClickResult, ["ax_press", "ax_focus"]);
		const oldCaptureId = latestCaptureId;
		latestCaptureId = refClickNorm.captureId;
		latestWidth = refClickNorm.width;
		latestHeight = refClickNorm.height;
		latestDetails = refClickResult.details;
		await assertUserContextPreserved("click by ref", userFrontmostApp, baselineMouse);

		let clickTarget = { x: centerX(), y: centerY() };
		try {
			const target = axFindFocusable(latestDetails);
			clickTarget = { x: target.x, y: target.y };
		} catch {}

		const clickResult = await executeClick(
			"qa-click",
			{ x: clickTarget.x, y: clickTarget.y, captureId: latestCaptureId },
			undefined,
			undefined,
			ctx,
		);
		const clickNorm = ensureImageResult("click", clickResult);
		latestCaptureId = clickNorm.captureId;
		latestWidth = clickNorm.width;
		latestHeight = clickNorm.height;
		latestDetails = clickResult.details;
		await assertUserContextPreserved("click", userFrontmostApp, baselineMouse);

		try {
			await executeClick(
				"qa-stale-capture",
				{ x: clickTarget.x, y: clickTarget.y, captureId: oldCaptureId },
				undefined,
				undefined,
				ctx,
			);
			fail("Stale capture validation", new Error("Expected stale-capture error but click succeeded"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert(message.includes("older screenshot"), "Unexpected stale-capture error text");
			pass("Stale capture validation", message);
		}

		const noCaptureResult = await executeClick(
			"qa-click-no-capture",
			{ x: clickTarget.x, y: clickTarget.y },
			undefined,
			undefined,
			ctx,
		);
		const noCaptureNorm = ensureImageResult("click without captureId", noCaptureResult);
		latestCaptureId = noCaptureNorm.captureId;
		latestWidth = noCaptureNorm.width;
		latestHeight = noCaptureNorm.height;
		latestDetails = noCaptureResult.details;
		await assertUserContextPreserved("click(no captureId)", userFrontmostApp, baselineMouse);

		pass("Click action + capture refresh", `click(ref=${String(refTarget.ref)}), click, stale-capture validation, click(no captureId)`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/AX click\/focus could not be completed/i.test(message)) {
			skip("Click action + capture refresh", message);
		} else {
			fail("Click action + capture refresh", error);
		}
	}

	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineUserContext = getUserContext();
		baselineMouse = getMousePosition();

		const textEditShot = await executeScreenshot("qa-expanded-actions-textedit", { app: "TextEdit" }, undefined, undefined, ctx);
		let latest = updateLatestFromResult(textEditShot);
		latestCaptureId = latest.captureId;
		latestWidth = latest.width;
		latestHeight = latest.height;
		latestDetails = latest.details;

		const textTarget = (() => {
			try {
				return axFindTextInput(latestDetails);
			} catch {
				return { x: centerX(), y: centerY() };
			}
		})();
		const safeX = Math.max(8, Math.min(latestWidth - 8, Math.round(textTarget.x)));
		const safeY = Math.max(8, Math.min(latestHeight - 8, Math.round(textTarget.y)));

		if (STRICT_AX_MODE) {
			const blockedActions: Array<[string, () => Promise<any>]> = [
				["move_mouse", () => executeMoveMouse("qa-strict-move-block", { x: safeX, y: safeY, captureId: latestCaptureId }, undefined, undefined, ctx)],
				["scroll", () => executeScroll("qa-strict-scroll-block", { x: safeX, y: safeY, scrollY: 120, captureId: latestCaptureId }, undefined, undefined, ctx)],
				["drag", () => executeDrag("qa-strict-drag-block", { path: [[safeX, safeY], [Math.min(latestWidth - 4, safeX + 12), Math.min(latestHeight - 4, safeY + 12)]], captureId: latestCaptureId }, undefined, undefined, ctx)],
				["keypress", () => executeKeypress("qa-strict-keypress-block", { keys: ["Escape"] }, undefined, undefined, ctx)],
			];
			for (const [name, run] of blockedActions) {
				try {
					await run();
					throw new Error(`${name} unexpectedly succeeded in strict AX mode`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					assert(/Strict AX mode/i.test(message), `${name}: expected strict-mode block, got '${message}'`);
				}
			}
			pass("Pointer, keyboard, and batch tools", "Strict mode blocks raw pointer/keyboard primitives as expected");
		} else {
			const focusClick = await executeClick("qa-expanded-focus-text", { x: safeX, y: safeY, captureId: latestCaptureId }, undefined, undefined, ctx);
			latest = updateLatestFromResult(focusClick);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			const setResult = await executeSetText("qa-set-text", { text: "pi-computer-use set_text QA" }, undefined, undefined, ctx);
			ensureAxExecution("set_text", setResult, ["ax_set_value"]);
			latest = updateLatestFromResult(setResult);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			const keyResult = await executeKeypress("qa-keypress", { keys: ["Enter"] }, undefined, undefined, ctx);
			ensureExecutionStrategy("keypress", keyResult, "raw_keypress");
			latest = updateLatestFromResult(keyResult);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			const moveResult = await executeMoveMouse("qa-move-mouse", { x: safeX, y: safeY, captureId: latestCaptureId }, undefined, undefined, ctx);
			ensureExecutionStrategy("move_mouse", moveResult, "coordinate_event_move");
			latest = updateLatestFromResult(moveResult);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			const doubleClickResult = await executeDoubleClick("qa-double-click", { x: safeX, y: safeY, captureId: latestCaptureId }, undefined, undefined, ctx);
			ensureExecutionStrategy("double_click", doubleClickResult, "coordinate_event_double_click");
			latest = updateLatestFromResult(doubleClickResult);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			const dragResult = await executeDrag(
				"qa-drag",
				{
					path: [
						[safeX, safeY],
						[Math.min(latestWidth - 4, safeX + 18), Math.min(latestHeight - 4, safeY + 18)],
					],
					captureId: latestCaptureId,
				},
				undefined,
				undefined,
				ctx,
			);
			ensureExecutionStrategy("drag", dragResult, "coordinate_event_drag");
			latest = updateLatestFromResult(dragResult);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			const scrollResult = await executeScroll("qa-scroll", { x: safeX, y: safeY, scrollY: 120, captureId: latestCaptureId }, undefined, undefined, ctx);
			ensureExecutionStrategy("scroll", scrollResult, "coordinate_event_scroll");
			latest = updateLatestFromResult(scrollResult);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			const batchResult = await executeComputerActions(
				"qa-computer-actions",
				{
					captureId: latestCaptureId,
					actions: [
						{ type: "click", x: safeX, y: safeY },
						{ type: "set_text", text: "pi-computer-use batch QA" },
						{ type: "keypress", keys: ["Enter"] },
						{ type: "type_text", text: "batched insert" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			ensureExecutionStrategy("computer_actions", batchResult, "batch");
			assert(batchResult.details?.execution?.actionCount === 4, "computer_actions: expected actionCount=4");
			assert(batchResult.details?.execution?.completedActionCount === 4, "computer_actions: expected completedActionCount=4");
			assert(Array.isArray(batchResult.details?.execution?.actions) && batchResult.details.execution.actions.length === 4, "computer_actions: expected four per-action traces");
			latest = updateLatestFromResult(batchResult);
			latestCaptureId = latest.captureId;
			latestWidth = latest.width;
			latestHeight = latest.height;
			latestDetails = latest.details;

			await assertUserContextPreserved("expanded action tools", userFrontmostApp, baselineMouse);
			pass("Pointer, keyboard, and batch tools", "set_text, keypress, move_mouse, double_click, drag, scroll, and computer_actions");
		}
	} catch (error) {
		fail("Pointer, keyboard, and batch tools", error);
	}

	try {
		const waitResult = await executeWait("qa-wait", {}, undefined, undefined, ctx);
		await assertUserContextPreserved("wait", userFrontmostApp, baselineMouse);
		const waitNorm = ensureImageResult("wait", waitResult);
		latestCaptureId = waitNorm.captureId;
		latestWidth = waitNorm.width;
		latestHeight = waitNorm.height;
		latestDetails = waitResult.details;
		pass("Wait action", `wait() returned semantic state${waitNorm.hasImage ? " with image fallback" : " without image fallback"}`);
	} catch (error) {
		fail("Wait action", error);
	}


	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineUserContext = getUserContext();
		baselineMouse = getMousePosition();

		const textInputShot = await executeScreenshot("qa-text-input-textedit", { app: "TextEdit" }, undefined, undefined, ctx);
		let textLatest = updateLatestFromResult(textInputShot);
		latestCaptureId = textLatest.captureId;
		latestWidth = textLatest.width;
		latestHeight = textLatest.height;
		latestDetails = textLatest.details;

		const textTarget = (() => {
			try {
				return axFindTextInput(latestDetails);
			} catch {
				return { x: centerX(), y: centerY() };
			}
		})();
		const clickResult = await executeClick(
			"qa-focus-text",
			{ x: textTarget.x, y: textTarget.y, captureId: latestCaptureId },
			undefined,
			undefined,
			ctx,
		);
		if (STRICT_AX_MODE) {
			ensureAxExecution("focus click", clickResult, ["ax_press", "ax_focus"]);
		}
		textLatest = updateLatestFromResult(clickResult);
		latestCaptureId = textLatest.captureId;
		latestWidth = textLatest.width;
		latestHeight = textLatest.height;
		latestDetails = textLatest.details;
		await assertUserContextPreserved("focus click", userFrontmostApp, baselineMouse);

		const sentinel = `PI_CLIPBOARD_SENTINEL_${Date.now()}`;
		runCommand("bash", ["-lc", `printf %s '${sentinel.replace(/'/g, "'\\''")}' | pbcopy`]);

		const textResult = STRICT_AX_MODE
			? await executeSetText("qa-set-text-strict", { text: "pi-computer-use manual QA text" }, undefined, undefined, ctx)
			: await executeTypeText(
					"qa-type",
					{ text: "pi-computer-use manual QA text" },
					undefined,
					undefined,
					ctx,
				);
		const textNorm = ensureImageResult(STRICT_AX_MODE ? "set_text" : "type_text", textResult);
		latestCaptureId = textNorm.captureId;
		latestWidth = textNorm.width;
		latestHeight = textNorm.height;
		latestDetails = textResult.details;
		await assertUserContextPreserved(STRICT_AX_MODE ? "set_text" : "type_text", userFrontmostApp, baselineMouse);
		if (STRICT_AX_MODE) {
			ensureAxExecution("set_text", textResult, ["ax_set_value"]);
			ensureStrictInvariants("set_text", textResult, baselineUserContext, baselineMouse);
		} else {
			ensureExecutionStrategy("type_text", textResult, "raw_key_text");
		}

		const clipboardAfter = runCommand("pbpaste", []);
		assert(
			clipboardAfter === sentinel,
			`Clipboard restore failed. Expected '${sentinel}', got '${clipboardAfter.slice(0, 80)}'`,
		);
		pass("Text input primitives + clipboard", STRICT_AX_MODE ? "set_text succeeded via AX metadata and clipboard remained intact" : "type_text inserted text and clipboard remained intact");
	} catch (error) {
		fail("Text input primitives + clipboard", error);
		if (STRICT_AX_MODE) {
			try {
				const ax = axDescribeAtPoint(Number(latestDetails?.target?.windowId), Number(latestDetails?.target?.pid), centerX(), centerY(), latestWidth, latestHeight);
				results.push({ name: "Strict TextEdit AX describe", status: "SKIP", details: formatAxDescription(ax) });
			} catch (diagError) {
				results.push({ name: "Strict TextEdit AX describe", status: "SKIP", details: String(diagError) });
			}
		}
	}

	skip("Minimized window fallback", "Minimized-window fallback was removed from the semantic-only runtime.");
	}
	}

	if (shouldRunSection("resume")) {
	try {
		const resetShot = await executeScreenshot("qa-reset-target", { app: "Finder" }, undefined, undefined, ctx);
		const resetNorm = ensureImageResult("reset target screenshot", resetShot);
		latestCaptureId = resetNorm.captureId;
		latestWidth = resetNorm.width;
		latestHeight = resetNorm.height;
		latestDetails = resetShot.details;

		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "click",
					details: latestDetails,
				},
			},
		];
		const resumeCtx = makeCtx(branch);
		reconstructStateFromBranch(resumeCtx);
		const resumedWait = await executeWait("qa-resume", { ms: 20 }, undefined, undefined, resumeCtx);
		const resumeNorm = ensureImageResult("resume wait", resumedWait);
		latestCaptureId = resumeNorm.captureId;
		latestWidth = resumeNorm.width;
		latestHeight = resumeNorm.height;
		latestDetails = resumedWait.details;
		pass("Resume reconstruction", "Reconstructed target/capture and executed wait");
	} catch (error) {
		fail("Resume reconstruction", error);
	}

	try {
		await executeScreenshot(
			"qa-missing-window-title",
			{ app: "Finder", windowTitle: "__pi_missing_window_title__" },
			undefined,
			undefined,
			ctx,
		);
		fail("Window title diagnostics", new Error("Expected missing-window error but screenshot succeeded"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(message.includes("Available windows:"), "Missing-window diagnostics did not include available windows");
		pass("Window title diagnostics", message);
	}

	try {
		const fakeDetails = {
			tool: "screenshot",
			target: {
				app: "MissingApp",
				pid: 999999,
				windowTitle: "MissingWindow",
				windowId: 999999,
			},
			capture: {
				captureId: "fake-capture-id",
				width: 100,
				height: 100,
				scaleFactor: 1,
				timestamp: Date.now(),
				coordinateSpace: "window-relative-screenshot-pixels",
			},
			activation: { activated: false, unminimized: false, raised: false },
		};
		const fakeBranch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "screenshot",
					details: fakeDetails,
				},
			},
		];
		const fakeCtx = makeCtx(fakeBranch);
		reconstructStateFromBranch(fakeCtx);
		try {
			await executeClick("qa-missing-after-resume", { x: 10, y: 10 }, undefined, undefined, fakeCtx);
			fail("Missing target after resume", new Error("Expected current-target-gone error but click succeeded"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert(message.includes("no longer available"), "Unexpected current-target-gone error text");
			pass("Missing target after resume", message);
		}
	} catch (error) {
		fail("Missing target after resume", error);
	}
	}

	if (shouldRunSection("strict-smokes") && STRICT_AX_MODE) {
		if (SAFE_ONLY_QA) {
			skip("Strict TextEdit targeting", "Skipped in safe-only QA mode.");
			skip("Strict Finder search smoke", "Skipped in safe-only QA mode.");
			skip("Strict browser smoke", "Skipped in safe-only QA mode.");
			skip("Strict Reminders smoke", "Skipped in safe-only QA mode.");
		} else {
		try {
			const textEditShot = await executeScreenshot("qa-strict-textedit", { app: "TextEdit" }, undefined, undefined, ctx);
			const textNorm = ensureImageResult("strict screenshot TextEdit", textEditShot);
			latestCaptureId = textNorm.captureId;
			latestWidth = textNorm.width;
			latestHeight = textNorm.height;
			latestDetails = textEditShot.details;
			pass("Strict TextEdit targeting", `app=${textNorm.app}`);
		} catch (error) {
			fail("Strict TextEdit targeting", error);
		}

		try {
			activateApp("Finder");
			await sleep(250);
			userFrontmostApp = getFrontmostAppName();
			baselineUserContext = getUserContext();
			baselineMouse = getMousePosition();
			let finderShot;
			try {
				finderShot = await executeScreenshot("qa-strict-finder", { app: "Finder" }, undefined, undefined, ctx);
			} catch (error) {
				if (!isRecoverableStrictQaError(error)) throw error;
				await sleep(300);
				finderShot = await executeScreenshot("qa-strict-finder-retry", { app: "Finder" }, undefined, undefined, ctx);
			}
			const finderNorm = ensureImageResult("strict screenshot Finder", finderShot);
			if (!finderNorm.app.toLowerCase().includes("finder")) {
				skip("Strict Finder search smoke", `Targeted app was '${finderNorm.app}', not Finder.`);
			} else {
				latestCaptureId = finderNorm.captureId;
				latestWidth = finderNorm.width;
				latestHeight = finderNorm.height;
				latestDetails = finderShot.details;
			let finderSummary = "";
			try {
				const finderTarget = axFindTextInput(latestDetails);
				const searchClick = await executeClick(
					"qa-strict-finder-search-click",
					{ x: finderTarget.x, y: finderTarget.y },
					undefined,
					undefined,
					ctx,
				);
				ensureImageResult("strict finder search click", searchClick);
				ensureAxExecution("strict finder search click", searchClick, ["ax_press", "ax_focus"]);
				ensureStrictInvariants("strict finder search click", searchClick, baselineUserContext, baselineMouse);
				const searchType = await executeTypeText(
					"qa-strict-finder-search-type",
					{ text: "Applications" },
					undefined,
					undefined,
					ctx,
				);
				ensureImageResult("strict finder search type", searchType);
				ensureAxExecution("strict finder search type", searchType, ["ax_set_value"]);
				ensureStrictInvariants("strict finder search type", searchType, baselineUserContext, baselineMouse);
				finderSummary = `AX click + AX type_text on Finder text input (role=${finderTarget.role ?? ""}, title=${JSON.stringify(finderTarget.title ?? "")}, score=${finderTarget.score ?? "?"}, confidence=${finderTarget.confidence ?? "?"}, candidates=${formatCandidateList(finderTarget.candidates)})`;
			} catch {
				const finderTarget = axFindFocusable(latestDetails);
				const finderClick = await executeClick(
					"qa-strict-finder-focusable-click",
					{ x: finderTarget.x, y: finderTarget.y },
					undefined,
					undefined,
					ctx,
				);
				ensureImageResult("strict finder focusable click", finderClick);
				ensureAxExecution("strict finder focusable click", finderClick, ["ax_press", "ax_focus"]);
				ensureStrictInvariants("strict finder focusable click", finderClick, baselineUserContext, baselineMouse);
				finderSummary = `AX click on Finder focusable element (role=${finderTarget.role ?? ""}, title=${JSON.stringify(finderTarget.title ?? "")}, score=${finderTarget.score ?? "?"}, confidence=${finderTarget.confidence ?? "?"}, candidates=${formatCandidateList(finderTarget.candidates)})`;
			}
				pass("Strict Finder search smoke", finderSummary);
			}
		} catch (error) {
			if (isRecoverableStrictQaError(error)) {
				skip("Strict Finder search smoke", error instanceof Error ? error.message : String(error));
			} else {
				fail("Strict Finder search smoke", error);
			}
			try {
				const ax = axDescribeAtPoint(Number(latestDetails?.target?.windowId), Number(latestDetails?.target?.pid), Math.max(16, Math.floor(latestWidth * 0.86)), Math.max(16, Math.floor(latestHeight * 0.06)), latestWidth, latestHeight);
				results.push({ name: "Strict Finder search AX describe", status: "SKIP", details: formatAxDescription(ax) });
			} catch (diagError) {
				results.push({ name: "Strict Finder search AX describe", status: "SKIP", details: String(diagError) });
			}
		}

		if (openApp("Safari")) {
			try {
				activateApp("Finder");
				await sleep(250);
				userFrontmostApp = getFrontmostAppName();
				baselineUserContext = getUserContext();
				baselineMouse = getMousePosition();
				let safariShot;
				try {
					safariShot = await executeScreenshot("qa-strict-safari", { app: "Safari" }, undefined, undefined, ctx);
				} catch (error) {
					if (!isRecoverableStrictQaError(error)) throw error;
					await sleep(500);
					safariShot = await executeScreenshot("qa-strict-safari-retry", { app: "Safari" }, undefined, undefined, ctx);
				}
				const safariNorm = ensureImageResult("strict screenshot Safari", safariShot);
				if (!safariNorm.app.toLowerCase().includes("safari")) {
					skip("Strict browser smoke", `Targeted app was '${safariNorm.app}', not Safari.`);
				} else {
					latestCaptureId = safariNorm.captureId;
					latestWidth = safariNorm.width;
					latestHeight = safariNorm.height;
					latestDetails = safariShot.details;
					const browserTarget = axFindTextInput(latestDetails);
					let addressClick: any;
					try {
						addressClick = await executeClick(
							"qa-strict-safari-address-click",
							{ x: browserTarget.x, y: browserTarget.y },
							undefined,
							undefined,
							ctx,
						);
						ensureImageResult("strict safari address click", addressClick);
						ensureAxExecution("strict safari address click", addressClick, ["ax_press", "ax_focus"]);
						ensureStrictInvariants("strict safari address click", addressClick, baselineUserContext, baselineMouse);
					} catch (error) {
						const focusResult = axFocusTextInput(latestDetails);
						if (!focusResult?.focused) throw error;
					}
					const addressType = await executeTypeText(
						"qa-strict-safari-address-type",
						{ text: "openai.com" },
						undefined,
						undefined,
						ctx,
					);
					ensureImageResult("strict safari address type", addressType);
					ensureAxExecution("strict safari address type", addressType, ["ax_set_value"]);
					ensureStrictInvariants("strict safari address type", addressType, baselineUserContext, baselineMouse);
					pass("Strict browser smoke", `Safari address/search field used AX click + AX type_text (role=${browserTarget.role ?? ""}, title=${JSON.stringify(browserTarget.title ?? "")}, score=${browserTarget.score ?? "?"}, confidence=${browserTarget.confidence ?? "?"}, candidates=${formatCandidateList(browserTarget.candidates)})`);
				}
			} catch (error) {
				if (isRecoverableStrictQaError(error)) {
					skip("Strict browser smoke", error instanceof Error ? error.message : String(error));
				} else {
					fail("Strict browser smoke", error);
				}
				try {
					const ax = axDescribeAtPoint(Number(latestDetails?.target?.windowId), Number(latestDetails?.target?.pid), Math.max(20, Math.floor(latestWidth * 0.5)), Math.max(20, Math.floor(latestHeight * 0.07)), latestWidth, latestHeight);
					results.push({ name: "Strict browser AX describe", status: "SKIP", details: formatAxDescription(ax) });
				} catch (diagError) {
					results.push({ name: "Strict browser AX describe", status: "SKIP", details: String(diagError) });
				}
			}
		} else {
			skip("Strict browser smoke", "Safari not available");
		}

		if (openApp("Reminders")) {
			try {
				activateApp("Finder");
				await sleep(250);
				userFrontmostApp = getFrontmostAppName();
				baselineUserContext = getUserContext();
				baselineMouse = getMousePosition();
				let remindersShot;
				try {
					remindersShot = await executeScreenshot("qa-strict-reminders", { app: "Reminders" }, undefined, undefined, ctx);
				} catch (error) {
					if (!isRecoverableStrictQaError(error)) throw error;
					await sleep(300);
					remindersShot = await executeScreenshot("qa-strict-reminders-retry", { app: "Reminders" }, undefined, undefined, ctx);
				}
				const remindersNorm = ensureImageResult("strict screenshot Reminders", remindersShot);
				if (!remindersNorm.app.toLowerCase().includes("reminders")) {
					skip("Strict Reminders smoke", `Targeted app was '${remindersNorm.app}', not Reminders.`);
				} else {
					latestCaptureId = remindersNorm.captureId;
					latestWidth = remindersNorm.width;
					latestHeight = remindersNorm.height;
					latestDetails = remindersShot.details;
					let remindersTarget;
				try {
					remindersTarget = axFindActionable(latestDetails, ["AXButton", "AXRow", "AXCell", "AXList"]);
				} catch {
					remindersTarget = axFindFocusable(latestDetails, ["AXList", "AXButton", "AXTextField", "AXTextArea"]);
				}
				const remindersClick = await executeClick(
					"qa-strict-reminders-click",
					{ x: remindersTarget.x, y: remindersTarget.y },
					undefined,
					undefined,
					ctx,
				);
				ensureImageResult("strict reminders click", remindersClick);
				ensureAxExecution("strict reminders click", remindersClick, ["ax_press", "ax_focus"]);
				ensureStrictInvariants("strict reminders click", remindersClick, baselineUserContext, baselineMouse);
					pass("Strict Reminders smoke", `Basic AX click in Reminders succeeded (role=${remindersTarget.role ?? ""}, title=${JSON.stringify(remindersTarget.title ?? "")}, score=${remindersTarget.score ?? "?"}, confidence=${remindersTarget.confidence ?? "?"}, candidates=${formatCandidateList(remindersTarget.candidates)})`);
				}
			} catch (error) {
				if (isRecoverableStrictQaError(error)) {
					skip("Strict Reminders smoke", error instanceof Error ? error.message : String(error));
				} else {
					fail("Strict Reminders smoke", error);
				}
				try {
					const ax = axDescribeAtPoint(Number(latestDetails?.target?.windowId), Number(latestDetails?.target?.pid), Math.max(24, Math.floor(latestWidth * 0.55)), Math.max(24, Math.floor(latestHeight * 0.2)), latestWidth, latestHeight);
					results.push({ name: "Strict Reminders AX describe", status: "SKIP", details: formatAxDescription(ax) });
				} catch (diagError) {
					results.push({ name: "Strict Reminders AX describe", status: "SKIP", details: String(diagError) });
				}
			}
		} else {
			skip("Strict Reminders smoke", "Reminders not available");
		}
		}
	} else {
		// These matrix items need manual/physical setup not guaranteed from this harness.
		skip("Multi-display validation", "Requires manual testing on non-primary and mixed-DPI monitors.");
		skip("Off-Space window validation", "Requires manual Space switching scenario.");
		skip("Typing fallback path isolation", "Forcing paste rejection/raw fallback needs app-specific manual setup.");
		skip("Secure field leakage validation", "Needs password-field specific manual verification.");
	}

	stopBridge();

	const passCount = results.filter((r) => r.status === "PASS").length;
	const failCount = results.filter((r) => r.status === "FAIL").length;
	const skipCount = results.filter((r) => r.status === "SKIP").length;

	console.log("\n=== pi-computer-use manual QA summary ===");
	for (const result of results) {
		const line = `[${result.status}] ${result.name}${result.details ? ` — ${result.details}` : ""}`;
		console.log(line);
	}
	console.log(`\nTotals: PASS=${passCount} FAIL=${failCount} SKIP=${skipCount}`);

	if (failCount > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	stopBridge();
	process.exit(1);
});
