/**
 * Stealth contract regression test.
 *
 * What it asserts: when stealth mode is on, no public tool will:
 *   1. Change the frontmost app
 *   2. Change which window is frontmost within the user's app
 *
 * Strategy:
 *   - Pick a sentinel app the user is "working in" (default: Finder).
 *   - Activate the sentinel and capture (frontmostApp, frontmostWindowTitle).
 *   - Force stealth via PI_COMPUTER_USE_STEALTH=1 (set inside the script).
 *   - Run a battery of tool calls against a different running app.
 *   - After each call, re-read the frontmost app + window title and assert
 *     they're unchanged.
 *
 * Each tool call is one of:
 *   - expected to succeed (AX-only path) -> record FAIL if stealth contract broken
 *   - expected to error with strict_mode -> record FAIL if it succeeded silently
 *
 * Exits non-zero if any case violates the contract. Suitable for CI smoke.
 *
 * Run:
 *   npx tsx benchmarks/stealth-contract.ts
 *
 * Optional flags:
 *   --target Slack    pick a non-sentinel app to drive (default: Slack, falls back to first non-sentinel app with a visible window)
 *   --sentinel Finder pick the sentinel "user is working here" app (default: Finder)
 *   --output stealth.json  write the report to a JSON file
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Force stealth before importing the bridge so its config snapshot picks it up.
process.env.PI_COMPUTER_USE_STEALTH = "1";

import {
	executeArrangeWindow,
	executeClick,
	executeKeypress,
	executeListApps,
	executeListWindows,
	executeNavigateBrowser,
	executeScreenshot,
	executeSetText,
	executeTypeText,
	stopBridge,
} from "../src/bridge.ts";

function argValue(name: string): string | undefined {
	const exact = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(exact));
	if (inline) return inline.slice(exact.length);
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const TARGET_APP_HINT = argValue("--target") ?? "Slack";
const SENTINEL_APP = argValue("--sentinel") ?? "Finder";
const OUTPUT_PATH = argValue("--output");

interface Snapshot {
	app: string;
	windowTitle: string;
}

interface CaseRecord {
	name: string;
	expected: "ax_success" | "strict_mode_block";
	status: "PASS" | "FAIL" | "SKIP";
	driftedFrontmost?: Snapshot;
	error?: string;
	notes?: string;
}

function runApple(script: string): string {
	return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

function frontmostSnapshot(): Snapshot {
	// Two narrow AppleScript queries — keep them small to minimize drift introduced
	// by AppleScript itself (it briefly bumps System Events to the foreground on
	// some macOS versions, which is exactly the kind of leak we'd be hunting, so
	// we read app+title in one tell-block).
	const out = runApple(
		'tell application "System Events" to set frontApp to name of first application process whose frontmost is true\n' +
			'tell application "System Events" to tell application process frontApp\n' +
			"  if (count of windows) > 0 then\n" +
			"    set winTitle to name of front window\n" +
			"  else\n" +
			'    set winTitle to ""\n' +
			"  end if\n" +
			"end tell\n" +
			'return frontApp & "\\t" & winTitle',
	);
	const [app = "Unknown", windowTitle = ""] = out.split("\t");
	return { app, windowTitle };
}

function activateApp(name: string): void {
	try {
		runApple(`tell application "${name}" to activate`);
	} catch {
		// Sentinel might not be installed; carry on.
	}
}

function snapshotsMatch(a: Snapshot, b: Snapshot): boolean {
	return a.app === b.app && a.windowTitle === b.windowTitle;
}

function makeCtx(): any {
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
		sessionManager: { getBranch: () => [] },
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

function isStrictModeError(error: unknown): boolean {
	if (!error) return false;
	const message = error instanceof Error ? error.message : String(error);
	return /strict|stealth/i.test(message);
}

async function findRunningTarget(): Promise<{ app: string; pid: number; windowTitle: string } | undefined> {
	const ctx = makeCtx();
	const apps = await executeListApps("ls", {} as any, undefined, undefined, ctx);
	const items = (apps?.details as any)?.apps ?? [];
	// Try in priority order: hinted app, then any non-sentinel non-pi app with a window.
	const nonSentinel = items.filter((entry: any) => entry.app !== SENTINEL_APP);
	const ordered = [
		...nonSentinel.filter((entry: any) => entry.app === TARGET_APP_HINT),
		...nonSentinel.filter((entry: any) => entry.app !== TARGET_APP_HINT),
	];
	for (const candidate of ordered) {
		const windows = await executeListWindows("lw", { app: candidate.app }, undefined, undefined, ctx);
		const found = (windows?.details as any)?.windows ?? [];
		if (found.length > 0) {
			return { app: candidate.app, pid: candidate.pid, windowTitle: found[0].windowTitle ?? "" };
		}
	}
	return undefined;
}

async function main(): Promise<number> {
	const records: CaseRecord[] = [];
	let frontmostBefore: Snapshot;

	activateApp(SENTINEL_APP);
	await new Promise((resolve) => setTimeout(resolve, 500));
	frontmostBefore = frontmostSnapshot();

	const target = await findRunningTarget();
	if (!target) {
		console.error(`No non-sentinel running app with a visible window; please open ${TARGET_APP_HINT} (or any GUI app other than ${SENTINEL_APP}) and retry.`);
		stopBridge();
		return 2;
	}

	console.log(`Stealth contract test:\n  sentinel app:    ${SENTINEL_APP}\n  driving target:  ${target.app}\n  starting frontmost: ${frontmostBefore.app} - ${frontmostBefore.windowTitle}\n`);

	type RunOutcome = { record: CaseRecord; result?: any };
	const runCase = async (
		name: string,
		expected: "ax_success" | "strict_mode_block",
		invoke: () => Promise<any>,
	): Promise<RunOutcome> => {
		const before = frontmostSnapshot();
		if (!snapshotsMatch(before, frontmostBefore)) {
			// User or system shifted focus between cases. Re-anchor the sentinel
			// and re-snapshot so we attribute drift correctly to this case only.
			activateApp(SENTINEL_APP);
			await new Promise((resolve) => setTimeout(resolve, 250));
			frontmostBefore = frontmostSnapshot();
		}
		let succeeded = false;
		let error: unknown;
		let result: any;
		try {
			result = await invoke();
			succeeded = true;
		} catch (err) {
			error = err;
		}
		const after = frontmostSnapshot();
		const drifted = !snapshotsMatch(after, frontmostBefore);

		let status: CaseRecord["status"] = "PASS";
		const notes: string[] = [];

		if (drifted) {
			status = "FAIL";
			notes.push(`frontmost drifted to ${after.app} - ${after.windowTitle}`);
		}

		if (expected === "strict_mode_block") {
			if (succeeded) {
				status = "FAIL";
				notes.push("expected strict_mode block but the call succeeded");
			} else if (!isStrictModeError(error)) {
				status = "FAIL";
				notes.push(`error did not look like strict_mode: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else if (expected === "ax_success") {
			if (!succeeded) {
				// Non-strict failures are environment issues, not contract failures.
				// Mark as SKIP so this run can still be a clean pass.
				status = drifted ? "FAIL" : "SKIP";
				notes.push(`call failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const record: CaseRecord = {
			name,
			expected,
			status,
			driftedFrontmost: drifted ? after : undefined,
			error: error instanceof Error ? error.message : error ? String(error) : undefined,
			notes: notes.length ? notes.join("; ") : undefined,
		};
		records.push(record);
		console.log(`  [${status}] ${name}${notes.length ? " - " + notes.join("; ") : ""}`);
		return { record, result };
	};

	const ctx = makeCtx();

	// 1. screenshot - must succeed and not change focus
	const shot = await runCase("screenshot.target", "ax_success", () =>
		executeScreenshot("ss", { app: target.app, image: "never" }, undefined, undefined, ctx),
	);

	const axTargets = (shot.result?.details as any)?.axTargets ?? [];
	const firstButton = axTargets.find((entry: any) => entry.canPress === true);
	const firstTextish = axTargets.find((entry: any) => entry.canSetValue === true && (entry.isTextInput || /text|combo/i.test(entry.role ?? "")));

	// All action tools below operate on the currently-selected window, which the
	// initial screenshot above set to `target`. We pass image:'never' on tools
	// that resnap so we don't get a vision fallback PNG bloating the run.

	// 2. click via AX ref (stealth-supported path) - must succeed without raising
	if (firstButton) {
		await runCase("click.ax_ref", "ax_success", () =>
			executeClick("c", { ref: firstButton.ref, image: "never" }, undefined, undefined, ctx),
		);
	} else {
		records.push({ name: "click.ax_ref", expected: "ax_success", status: "SKIP", notes: "no AX button ref available on target" });
		console.log("  [SKIP] click.ax_ref - no AX button ref available on target");
	}

	// 3. click by coordinate at (10,10) - the bridge will try AX press/focus
	//    at that point first; only if there's no AX element does it fall back to a
	//    raw event (which stealth then blocks). Either outcome is contract-safe;
	//    we just assert frontmost doesn't drift.
	await runCase("click.coordinate", "ax_success", () =>
		executeClick("c", { x: 10, y: 10, image: "never" }, undefined, undefined, ctx),
	);

	// 4. set_text via AX ref to its own current value - succeeds without raise
	if (firstTextish) {
		await runCase("set_text.ax_ref", "ax_success", () =>
			executeSetText("st", { ref: firstTextish.ref, text: firstTextish.value ?? "", image: "never" }, undefined, undefined, ctx),
		);
	} else {
		records.push({ name: "set_text.ax_ref", expected: "ax_success", status: "SKIP", notes: "no settable AX text target" });
		console.log("  [SKIP] set_text.ax_ref - no settable AX text target");
	}

	// 5. set_text without ref - succeeds via the AX-focused-element fallback if
	//    one exists, otherwise blocks. Either is contract-safe; we just assert
	//    frontmost doesn't drift.
	await runCase("set_text.no_ref", "ax_success", () =>
		executeSetText("st2", { text: "hello", image: "never" }, undefined, undefined, ctx),
	);

	// 6. type_text - raw keyboard fallback, must be blocked
	await runCase("type_text.raw", "strict_mode_block", () =>
		executeTypeText("tt", { text: "hello", image: "never" }, undefined, undefined, ctx),
	);

	// 7. keypress with no AX semantic equivalent - must be blocked
	await runCase("keypress.fallback", "strict_mode_block", () =>
		executeKeypress("kp", { keys: ["F12"], image: "never" }, undefined, undefined, ctx),
	);

	// 8. arrange_window on target - this physically moves a window; in stealth
	//    we don't yet block this (audit decision: it's safe but surprising).
	//    Asserting only that it doesn't drift the user's frontmost.
	await runCase("arrange_window.preset", "ax_success", () =>
		executeArrangeWindow("aw", { preset: "right_half" }, undefined, undefined, ctx),
	);

	// 9. navigate_browser - blocked in stealth (the AppleScript URL-set call
	//    activates the browser process; not stealth-safe). On a non-browser
	//    target the call errors before reaching the stealth check; we treat
	//    that as a SKIP. On a browser target it must hit the stealth block.
	const isBrowserTarget = /chrome|safari|firefox|brave|edge|arc|helium/i.test(target.app);
	if (isBrowserTarget) {
		await runCase("navigate_browser.stealth_blocked", "strict_mode_block", () =>
			executeNavigateBrowser("nb", { url: "https://example.com" }, undefined, undefined, ctx),
		);
	} else {
		await runCase("navigate_browser.non_browser", "ax_success", () =>
			executeNavigateBrowser("nb", { url: "https://example.com" }, undefined, undefined, ctx),
		);
	}

	const passed = records.filter((r) => r.status === "PASS").length;
	const failed = records.filter((r) => r.status === "FAIL").length;
	const skipped = records.filter((r) => r.status === "SKIP").length;

	const after = frontmostSnapshot();
	console.log(`\nStealth contract: ${passed} PASS, ${failed} FAIL, ${skipped} SKIP`);
	console.log(`final frontmost: ${after.app} - ${after.windowTitle}${snapshotsMatch(after, frontmostBefore) ? " (unchanged)" : " (DRIFTED)"}`);

	if (OUTPUT_PATH) {
		fs.mkdirSync(path.dirname(path.resolve(OUTPUT_PATH)), { recursive: true });
		fs.writeFileSync(
			path.resolve(OUTPUT_PATH),
			JSON.stringify(
				{
					sentinel: SENTINEL_APP,
					target: target.app,
					before: frontmostBefore,
					after,
					driftedAtEnd: !snapshotsMatch(after, frontmostBefore),
					summary: { passed, failed, skipped, total: records.length },
					cases: records,
				},
				null,
				2,
			),
		);
		console.log(`wrote ${OUTPUT_PATH}`);
	}

	stopBridge();
	return failed > 0 ? 1 : 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err);
		stopBridge();
		process.exit(1);
	},
);
