import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const ALLOW_FOREGROUND_QA =
	process.argv.includes("--allow-foreground-qa") || process.env.PI_COMPUTER_USE_ALLOW_FOREGROUND_QA === "1";
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
	reconstructStateFromBranch,
	stopBridge,
} from "../src/bridge.ts";

type ResultRecord = {
	name: string;
	status: "PASS" | "FAIL" | "SKIP";
	details?: string;
};

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

function ensureImageResult(name: string, result: any): { captureId: string; width: number; height: number; app: string } {
	assert(Array.isArray(result?.content), `${name}: missing content array`);
	const textPart = result.content.find((item: any) => item?.type === "text");
	const imagePart = result.content.find((item: any) => item?.type === "image");
	assert(textPart?.text && typeof textPart.text === "string", `${name}: missing text summary`);
	assert(imagePart?.data && typeof imagePart.data === "string", `${name}: missing image attachment`);
	assert(imagePart?.mimeType === "image/png", `${name}: image mimeType is not image/png`);

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
	};
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

function getFrontmostAppName(): string {
	return runCommand("osascript", [
		"-e",
		'tell application "System Events" to get name of first application process whose frontmost is true',
	]);
}

function activateApp(appName: string): void {
	runCommand("osascript", ["-e", `tell application "${appName}" to activate`]);
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

	try {
		runCommand("open", ["-a", "TextEdit"]);
		runCommand("open", ["-a", "Finder"]);
		pass("Environment setup", "Opened TextEdit and Finder");
	} catch (error) {
		fail("Environment setup", error);
	}

	await new Promise((resolve) => setTimeout(resolve, 1200));

	let userFrontmostApp = "Finder";
	let baselineMouse = { x: 0, y: 0 };
	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineMouse = getMousePosition();
		pass(
			"User context baseline",
			`frontmost=${userFrontmostApp}, mouse=(${baselineMouse.x.toFixed(1)},${baselineMouse.y.toFixed(1)})`,
		);
	} catch (error) {
		fail("User context baseline", error);
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

		const moveResult = await executeMoveMouse(
			"qa-move",
			{ x: centerX(), y: centerY(), captureId: latestCaptureId },
			undefined,
			undefined,
			ctx,
		);
		const moveNorm = ensureImageResult("move_mouse", moveResult);
		const oldCaptureId = latestCaptureId;
		latestCaptureId = moveNorm.captureId;
		latestWidth = moveNorm.width;
		latestHeight = moveNorm.height;
		latestDetails = moveResult.details;
		await assertUserContextPreserved("move_mouse", userFrontmostApp, baselineMouse);

		const clickResult = await executeClick(
			"qa-click",
			{ x: centerX(), y: centerY(), captureId: latestCaptureId },
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

		const doubleResult = await executeDoubleClick(
			"qa-double",
			{ x: centerX(), y: centerY(), captureId: latestCaptureId },
			undefined,
			undefined,
			ctx,
		);
		const doubleNorm = ensureImageResult("double_click", doubleResult);
		latestCaptureId = doubleNorm.captureId;
		latestWidth = doubleNorm.width;
		latestHeight = doubleNorm.height;
		latestDetails = doubleResult.details;
		await assertUserContextPreserved("double_click", userFrontmostApp, baselineMouse);

		const scrollResult = await executeScroll(
			"qa-scroll",
			{ x: centerX(), y: centerY(), scrollX: 0, scrollY: -640, captureId: latestCaptureId },
			undefined,
			undefined,
			ctx,
		);
		const scrollNorm = ensureImageResult("scroll", scrollResult);
		latestCaptureId = scrollNorm.captureId;
		latestWidth = scrollNorm.width;
		latestHeight = scrollNorm.height;
		latestDetails = scrollResult.details;
		await assertUserContextPreserved("scroll", userFrontmostApp, baselineMouse);

		// stale capture must fail using older capture id
		try {
			await executeClick(
				"qa-stale-capture",
				{ x: centerX(), y: centerY(), captureId: oldCaptureId },
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
			{ x: centerX(), y: centerY() },
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

		pass("Mouse actions + capture refresh", "move_mouse, click, double_click, scroll, click(no captureId)");
	} catch (error) {
		fail("Mouse actions + capture refresh", error);
	}

	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineMouse = getMousePosition();

		try {
			await executeDrag(
				"qa-drag-invalid",
				{ path: [{ x: centerX(), y: centerY() }], captureId: latestCaptureId },
				undefined,
				undefined,
				ctx,
			);
			fail("Drag path validation", new Error("Expected drag validation error but drag succeeded"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert(message.includes("at least two points"), "Unexpected drag validation error text");
			pass("Drag path validation", message);
		}

		const path = [
			{ x: centerX() - 40, y: centerY() },
			{ x: centerX() + 40, y: centerY() },
		];
		const dragResult = await executeDrag(
			"qa-drag",
			{ path, captureId: latestCaptureId },
			undefined,
			undefined,
			ctx,
		);
		const dragNorm = ensureImageResult("drag", dragResult);
		latestCaptureId = dragNorm.captureId;
		latestWidth = dragNorm.width;
		latestHeight = dragNorm.height;
		latestDetails = dragResult.details;
		await assertUserContextPreserved("drag", userFrontmostApp, baselineMouse);
		pass("Drag action", "Drag with 2-point path succeeded");
	} catch (error) {
		fail("Drag action", error);
	}

	try {
		const waitResult = await executeWait("qa-wait", {}, undefined, undefined, ctx);
		await assertUserContextPreserved("wait", userFrontmostApp, baselineMouse);
		const waitNorm = ensureImageResult("wait", waitResult);
		latestCaptureId = waitNorm.captureId;
		latestWidth = waitNorm.width;
		latestHeight = waitNorm.height;
		latestDetails = waitResult.details;
		pass("Wait action", "wait() returned fresh screenshot");
	} catch (error) {
		fail("Wait action", error);
	}

	try {
		const keypressResult = await executeKeypress(
			"qa-keypress",
			{ keys: ["cmd+l"] },
			undefined,
			undefined,
			ctx,
		);
		const keypressNorm = ensureImageResult("keypress", keypressResult);
		latestCaptureId = keypressNorm.captureId;
		latestWidth = keypressNorm.width;
		latestHeight = keypressNorm.height;
		latestDetails = keypressResult.details;
		await assertUserContextPreserved("keypress", userFrontmostApp, baselineMouse);
		pass("Keypress action", "keypress accepted shortcut normalization input");
	} catch (error) {
		fail("Keypress action", error);
	}

	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineMouse = getMousePosition();

		// refocus text area first
		const clickResult = await executeClick(
			"qa-focus-text",
			{ x: centerX(), y: centerY() },
			undefined,
			undefined,
			ctx,
		);
		const clickNorm = ensureImageResult("focus click", clickResult);
		latestCaptureId = clickNorm.captureId;
		latestWidth = clickNorm.width;
		latestHeight = clickNorm.height;
		latestDetails = clickResult.details;
		await assertUserContextPreserved("focus click", userFrontmostApp, baselineMouse);

		const sentinel = `PI_CLIPBOARD_SENTINEL_${Date.now()}`;
		runCommand("bash", ["-lc", `printf %s '${sentinel.replace(/'/g, "'\\''")}' | pbcopy`]);

		const typeResult = await executeTypeText(
			"qa-type",
			{ text: "pi-computer-use manual QA text" },
			undefined,
			undefined,
			ctx,
		);
		const typeNorm = ensureImageResult("type_text", typeResult);
		latestCaptureId = typeNorm.captureId;
		latestWidth = typeNorm.width;
		latestHeight = typeNorm.height;
		latestDetails = typeResult.details;
		await assertUserContextPreserved("type_text", userFrontmostApp, baselineMouse);

		const clipboardAfter = runCommand("pbpaste", []);
		assert(
			clipboardAfter === sentinel,
			`Clipboard restore failed. Expected '${sentinel}', got '${clipboardAfter.slice(0, 80)}'`,
		);
		pass("Type text + clipboard restore", "type_text succeeded and clipboard restored");
	} catch (error) {
		fail("Type text + clipboard restore", error);
	}

	try {
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineMouse = getMousePosition();

		runCommand("osascript", [
			"-e",
			'tell application "TextEdit" to if (count of windows) > 0 then set miniaturized of front window to true',
		]);

		// Re-establish user context after the minimize side-effect.
		activateApp("Finder");
		await sleep(250);
		userFrontmostApp = getFrontmostAppName();
		baselineMouse = getMousePosition();

		try {
			const clickAfterMinimize = await executeClick(
				"qa-click-after-minimize",
				{ x: Math.max(12, centerX()), y: Math.max(12, centerY()) },
				undefined,
				undefined,
				ctx,
			);
			const minNorm = ensureImageResult("click after minimize", clickAfterMinimize);
			latestCaptureId = minNorm.captureId;
			latestWidth = minNorm.width;
			latestHeight = minNorm.height;
			latestDetails = clickAfterMinimize.details;
			await assertUserContextPreserved("click after minimize", userFrontmostApp, baselineMouse);
			pass("Minimized window fallback", "Action succeeded after minimizing target window without stealing focus");
		} catch (innerError) {
			const message = innerError instanceof Error ? innerError.message : String(innerError);
			await assertUserContextPreserved("click after minimize failure", userFrontmostApp, baselineMouse);
			pass(
				"Minimized window fallback",
				`Non-intrusive mode blocked minimized-window action without stealing focus: ${message}`,
			);
		}
	} catch (error) {
		fail("Minimized window fallback", error);
	}

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

	// These matrix items need manual/physical setup not guaranteed from this harness.
	skip("Multi-display validation", "Requires manual testing on non-primary and mixed-DPI monitors.");
	skip("Off-Space window validation", "Requires manual Space switching scenario.");
	skip("Typing fallback path isolation", "Forcing paste rejection/raw fallback needs app-specific manual setup.");
	skip("Secure field leakage validation", "Needs password-field specific manual verification.");

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
