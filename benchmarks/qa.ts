import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

const ALLOW_FOREGROUND_QA =
	process.argv.includes("--allow-foreground-qa") || process.env.PI_COMPUTER_USE_ALLOW_FOREGROUND_QA === "1";
const ALLOW_SCREEN_TAKEOVER =
	process.argv.includes("--allow-screen-takeover") || process.env.PI_COMPUTER_USE_ALLOW_SCREEN_TAKEOVER === "1";
const STRICT_AX_MODE = process.env.PI_COMPUTER_USE_STEALTH === "1" || process.env.PI_COMPUTER_USE_STRICT_AX === "1";
function argValue(name: string): string | undefined {
	const exact = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(exact));
	if (inline) return inline.slice(exact.length);
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUTPUT_PATH = argValue("--output");
const BASELINE_PATH = argValue("--baseline");
const CONFIG_PATH = path.resolve(process.cwd(), "benchmarks/config.json");
const HELPER_PATH = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "bridge");
const HELPER_SOURCE_PATH = path.resolve(process.cwd(), "native/macos/bridge.swift");

const BROWSER_APPS = ["Safari", "Google Chrome", "Chrome", "Chromium", "Firefox", "Helium", "Arc", "Brave Browser", "Microsoft Edge"];
const MATRIX = [
	{ app: "TextEdit", category: "native" },
	{ app: "Finder", category: "native" },
	{ app: "Reminders", category: "native" },
	...BROWSER_APPS.map((app) => ({ app, category: "browser" })),
];

type CaseRecord = {
	name: string;
	category: string;
	tool:
		| "screenshot"
		| "click"
		| "double_click"
		| "move_mouse"
		| "drag"
		| "scroll"
		| "keypress"
		| "type_text"
		| "set_text"
		| "wait"
		| "computer_actions";
	app?: string;
	status: "PASS" | "FAIL" | "SKIP";
	latencyMs?: number;
	hasImage?: boolean;
	axTargets?: number;
	axOnly?: boolean;
	axExecution?: boolean;
	fallbackUsed?: boolean;
	stealthCompatible?: boolean;
	executionVariant?: string;
	details?: string;
};

type BenchmarkSummary = {
	date: string;
	strictAxMode: boolean;
	allowScreenTakeover: boolean;
	host: string;
	cwd: string;
	metrics: ReturnType<typeof metrics>;
	goals?: {
		status: "PASS" | "FAIL";
		checks: Array<{ metric: string; current: number; target: number; status: "PASS" | "FAIL"; details: string }>;
	};
	comparison?: {
		baselinePath: string;
		status: "PASS" | "FAIL";
		checks: Array<{ metric: string; current: number; baseline: number; status: "PASS" | "FAIL"; details: string }>;
	};
	cases: CaseRecord[];
};

function readJsonFile(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runningApps(): Set<string> {
	try {
		const output = runCommand("osascript", [
			"-e",
			'tell application "System Events" to get name of (application processes where background only is false)',
		]);
		return new Set(
			output
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

function goalStatus(current: ReturnType<typeof metrics>) {
	const goals = readJsonFile(CONFIG_PATH)?.goals ?? {};
	const checks = Object.entries(goals).map(([metric, target]) => {
		const currentValue = Number((current as any)[metric] ?? 0);
		const goalValue = Number(target ?? 0);
		const higherIsBetter = metric === "axOnlyRatio";
		const status = higherIsBetter ? currentValue >= goalValue : currentValue <= goalValue;
		const details = higherIsBetter ? `expected >= ${goalValue}, got ${currentValue}` : `expected <= ${goalValue}, got ${currentValue}`;
		return { metric, current: currentValue, target: goalValue, status: (status ? "PASS" : "FAIL") as "PASS" | "FAIL", details };
	});
	return { status: (checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL") as "PASS" | "FAIL", checks };
}

function compareMetrics(current: ReturnType<typeof metrics>, baseline: ReturnType<typeof metrics>) {
	const config = readJsonFile(CONFIG_PATH)?.regressionTolerance ?? {};
	const higherIsBetter = new Set(["axOnlyRatio", "axExecutionRatio", "navigationAxOnlyRatio", "targetingAxOnlyRatio"]);
	const checks = Object.entries(config).map(([metric, tolerance]) => {
		const currentValue = Number((current as any)[metric] ?? 0);
		const baselineValue = Number((baseline as any)[metric] ?? 0);
		const allowed = Number(tolerance ?? 0);
		const status = higherIsBetter.has(metric)
			? currentValue + allowed >= baselineValue
			: currentValue <= baselineValue + allowed;
		const details = higherIsBetter.has(metric)
			? `expected >= ${baselineValue - allowed}, got ${currentValue}`
			: `expected <= ${baselineValue + allowed}, got ${currentValue}`;
		return { metric, current: currentValue, baseline: baselineValue, status: (status ? "PASS" : "FAIL") as "PASS" | "FAIL", details };
	});
	return { status: (checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL") as "PASS" | "FAIL", checks };
}

function isRunningApp(appName: string, apps: Set<string>): boolean {
	return apps.has(appName);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureHelperCurrent(): void {
	try {
		const helperMtime = fs.existsSync(HELPER_PATH) ? fs.statSync(HELPER_PATH).mtimeMs : 0;
		const sourceMtime = fs.statSync(HELPER_SOURCE_PATH).mtimeMs;
		if (helperMtime >= sourceMtime) return;
		runCommand(process.execPath, ["scripts/build-native.mjs", "--output", HELPER_PATH]);
	} catch (error) {
		throw new Error(`Failed to build current helper before benchmarking: ${error instanceof Error ? error.message : String(error)}`);
	}
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
		sessionManager: { getBranch: () => branchEntries },
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

function runCommand(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function openApp(appName: string): boolean {
	try {
		runCommand("open", ["-a", appName]);
		return true;
	} catch {
		return false;
	}
}

function runAppleScript(lines: string[]): void {
	runCommand("osascript", lines.flatMap((line) => ["-e", line]));
}

function prepareAppWindow(appName: string): void {
	if (appName === "TextEdit") {
		runAppleScript([`tell application "TextEdit" to activate`, `tell application "TextEdit" to make new document`]);
		return;
	}
	if (appName === "Finder") {
		runAppleScript([`tell application "Finder" to activate`, `tell application "Finder" to make new Finder window to home`]);
		return;
	}
	if (appName === "Reminders") {
		runAppleScript([`tell application "Reminders" to activate`]);
		return;
	}
}

function summarizeResult(result: any): { hasImage: boolean; axTargets: number; fallbackUsed: boolean; axExecution: boolean; stealthCompatible: boolean; executionVariant: string } {
	const content = Array.isArray(result?.content) ? result.content : [];
	const details = result?.details ?? {};
	return {
		hasImage: content.some((item: any) => item?.type === "image"),
		axTargets: Array.isArray(details?.axTargets) ? details.axTargets.length : 0,
		fallbackUsed: details?.execution?.fallbackUsed === true,
		axExecution: details?.execution?.axSucceeded === true || String(details?.execution?.strategy ?? "").startsWith("ax_"),
		stealthCompatible: details?.execution?.stealthCompatible === true,
		executionVariant: String(details?.execution?.variant ?? "unknown"),
	};
}

function preferredAxTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	const label = (target: any) => String(target?.title || target?.description || target?.value || "").trim();
	for (const role of ["AXTextField", "AXSearchField"]) {
		const match = targets.find((target: any) => String(target?.role ?? "") === role && label(target).length > 0);
		if (match) return match;
	}
	for (const role of ["AXButton", "AXLink", "AXRow", "AXCell"]) {
		const match = targets.find((target: any) => String(target?.role ?? "") === role && label(target).length > 0);
		if (match) return match;
	}
	return targets.find((target: any) => Array.isArray(target?.actions) && target.actions.includes("AXPress")) ?? targets[0];
}

function preferredTextTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	return targets.find((target: any) =>
		["AXTextField", "AXSearchField", "AXTextArea", "AXTextView", "AXEditableText", "AXComboBox"].includes(String(target?.role ?? "")) &&
		target?.canSetValue === true &&
		typeof target?.ref === "string"
	);
}

function preferredScrollTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	return targets.find((target: any) => target?.canScroll === true && typeof target?.ref === "string");
}

function preferredAdjustTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	return targets.find((target: any) => (target?.canIncrement === true || target?.canDecrement === true) && typeof target?.ref === "string");
}

function captureCenter(details: any): { x: number; y: number } {
	const width = Math.max(20, Number(details?.capture?.width ?? 100));
	const height = Math.max(20, Number(details?.capture?.height ?? 100));
	return {
		x: Math.max(8, Math.min(width - 8, Math.round(width * 0.5))),
		y: Math.max(8, Math.min(height - 8, Math.round(height * 0.5))),
	};
}

function metrics(records: CaseRecord[]) {
	const executed = records.filter((record) => record.status !== "SKIP");
	const passed = executed.filter((record) => record.status === "PASS");
	const navigation = executed.filter((record) => record.tool === "screenshot" || record.tool === "wait");
	const targeting = executed.filter((record) => record.tool === "click" || record.tool === "set_text");
	const primitives = executed.filter((record) =>
		["double_click", "move_mouse", "drag", "scroll", "keypress", "type_text"].includes(record.tool),
	);
	const batches = executed.filter((record) => record.tool === "computer_actions");
	const ratio = (subset: CaseRecord[], predicate: (record: CaseRecord) => boolean) =>
		subset.length ? Number((subset.filter(predicate).length / subset.length).toFixed(3)) : 0;
	const avgLatency = (subset: CaseRecord[]) =>
		subset.length
			? Math.round(subset.reduce((sum, record) => sum + (record.latencyMs ?? 0), 0) / subset.length)
			: 0;
	const byCategory = Object.fromEntries(
		Array.from(new Set(records.map((record) => record.category))).map((category) => {
			const subset = records.filter((record) => record.category === category);
			return [
				category,
				{
					total: subset.length,
					executed: subset.filter((record) => record.status !== "SKIP").length,
					passed: subset.filter((record) => record.status === "PASS").length,
					skipped: subset.filter((record) => record.status === "SKIP").length,
				},
			];
		}),
	);
	return {
		total: records.length,
		executed: executed.length,
		passed: passed.length,
		failed: executed.filter((record) => record.status === "FAIL").length,
		skipped: records.filter((record) => record.status === "SKIP").length,
		axOnlyRatio: ratio(executed, (record) => record.axOnly === true),
		visionFallbackRatio: ratio(executed, (record) => record.hasImage === true),
		axExecutionRatio: ratio(targeting, (record) => record.axExecution === true && record.fallbackUsed !== true),
		stealthCompatibleRatio: ratio(executed, (record) => record.stealthCompatible === true),
		navigationAxOnlyRatio: ratio(navigation, (record) => record.axOnly === true),
		targetingAxOnlyRatio: ratio(targeting, (record) => record.axOnly === true && record.axExecution === true),
		primitivePassRatio: ratio(primitives, (record) => record.status === "PASS"),
		batchPassRatio: ratio(batches, (record) => record.status === "PASS"),
		avgLatencyMs: avgLatency(executed),
		avgNavigationLatencyMs: avgLatency(navigation),
		avgTargetingLatencyMs: avgLatency(targeting),
		avgPrimitiveLatencyMs: avgLatency(primitives),
		avgBatchLatencyMs: avgLatency(batches),
		coverage: byCategory,
	};
}

function normalizeRecord(record: CaseRecord): CaseRecord {
	if (
		record.status === "FAIL" &&
		/No controllable window was found|No frontmost controllable window was found|No current controlled window|window is no longer available|is not running/i.test(record.details ?? "")
	) {
		return { ...record, status: "SKIP", details: record.details };
	}
	return record;
}

async function benchmarkCase(
	name: string,
	category: string,
	tool: CaseRecord["tool"],
	app: string | undefined,
	run: () => Promise<any>,
): Promise<{ record: CaseRecord; result?: any }> {
	const start = performance.now();
	try {
		const result = await run();
		const summary = summarizeResult(result);
		return {
			record: normalizeRecord({
				name,
				category,
				tool,
				app,
				status: "PASS",
				latencyMs: Math.round(performance.now() - start),
				hasImage: summary.hasImage,
				axTargets: summary.axTargets,
				axOnly: !summary.hasImage,
				axExecution: summary.axExecution,
				fallbackUsed: summary.fallbackUsed,
				stealthCompatible: summary.stealthCompatible,
				executionVariant: summary.executionVariant,
				details: `axTargets=${summary.axTargets} hasImage=${summary.hasImage} axExecution=${summary.axExecution} fallback=${summary.fallbackUsed} variant=${summary.executionVariant} stealthCompatible=${summary.stealthCompatible}`,
			}),
			result,
		};
	} catch (error) {
		return {
			record: normalizeRecord({
				name,
				category,
				tool,
				app,
				status: "FAIL",
				latencyMs: Math.round(performance.now() - start),
				details: error instanceof Error ? error.message : String(error),
			}),
		};
	}
}

async function main() {
	if (!ALLOW_FOREGROUND_QA) {
		console.log("Foreground QA benchmark is disabled by default.");
		console.log("Re-run with --allow-foreground-qa (or PI_COMPUTER_USE_ALLOW_FOREGROUND_QA=1).");
		process.exitCode = 1;
		return;
	}

	ensureHelperCurrent();
	const records: CaseRecord[] = [];
	const ctx = makeCtx();
	const apps = runningApps();

	const frontmost = await benchmarkCase("frontmost-screenshot", "baseline", "screenshot", undefined, async () => {
		return await executeScreenshot("bench-frontmost", {}, undefined, undefined, ctx);
	});
	records.push(frontmost.record);

	for (const item of MATRIX) {
		let available = isRunningApp(item.app, apps);
		if (!available && ALLOW_SCREEN_TAKEOVER) {
			available = openApp(item.app);
			if (available) {
				await sleep(400);
			}
		}
		if (available && ALLOW_SCREEN_TAKEOVER) {
			prepareAppWindow(item.app);
			await sleep(250);
		}
		if (!available) {
			records.push({ name: `${item.app}-navigation`, category: item.category, tool: "screenshot", app: item.app, status: "SKIP", details: "App not running" });
			records.push({ name: `${item.app}-targeting`, category: item.category, tool: "click", app: item.app, status: "SKIP", details: "App not running" });
			continue;
		}

		const shot = await benchmarkCase(`${item.app}-navigation`, item.category, "screenshot", item.app, async () => {
			return await executeScreenshot(`bench-${item.app}-shot`, { app: item.app }, undefined, undefined, ctx);
		});
		if (
			STRICT_AX_MODE &&
			item.category === "browser" &&
			shot.record.status === "FAIL" &&
			/String AX mode cannot create an isolated browser window|Strict AX mode cannot create an isolated browser window/.test(String(shot.record.details ?? ""))
		) {
			shot.record = { ...shot.record, status: "SKIP", details: "Strict AX mode requires an already-open dedicated browser window" };
		}
		if (
			shot.record.status === "PASS" &&
			item.app === "Finder" &&
			shot.record.axTargets === 0 &&
			["", "(untitled)"].includes(String(shot.result?.details?.target?.windowTitle ?? ""))
		) {
			shot.record = { ...shot.record, status: "SKIP", details: "Finder is showing the desktop, not a controllable Finder window" };
		}
		records.push(shot.record);
		if (shot.record.status !== "PASS") continue;

		const details = shot.result?.details;
		const target = preferredAxTarget(details);
		if (shot.record.hasImage || (shot.record.axTargets ?? 0) < 3) {
			records.push({
				name: `${item.app}-targeting`,
				category: item.category,
				tool: "click",
				app: item.app,
				status: "SKIP",
				details: "Semantic AX target coverage was too sparse for AX-first targeting",
			});
		} else if (!target?.ref || !details?.capture?.captureId) {
			records.push({
				name: `${item.app}-targeting`,
				category: item.category,
				tool: "click",
				app: item.app,
				status: "SKIP",
				details: "No AX target available from screenshot details",
			});
		} else {
			const click = await benchmarkCase(`${item.app}-targeting`, item.category, "click", item.app, async () => {
				return await executeClick(`bench-${item.app}-click`, { ref: target.ref, captureId: details.capture.captureId }, undefined, undefined, ctx);
			});
			records.push(click.record);
		}

		if (item.app === "TextEdit" && details?.capture?.captureId) {
			let currentDetails = details;
			let point = captureCenter(currentDetails);
			await executeClick(
				"bench-TextEdit-focus",
				{ x: point.x, y: point.y, captureId: currentDetails.capture.captureId },
				undefined,
				undefined,
				ctx,
			).catch(() => undefined);

			const runTextEditCase = async (
				name: string,
				tool: CaseRecord["tool"],
				run: () => Promise<any>,
			): Promise<void> => {
				const record = await benchmarkCase(name, item.category, tool, item.app, run);
				records.push(record.record);
				if (record.record.status === "PASS" && record.result?.details) {
					currentDetails = record.result.details;
					point = captureCenter(currentDetails);
				}
			};

			await runTextEditCase("TextEdit-set-text", "set_text", async () => {
				const textTarget = preferredTextTarget(currentDetails);
				return await executeSetText("bench-TextEdit-set-text", { text: "pi-computer-use benchmark set_text", ref: textTarget?.ref }, undefined, undefined, ctx);
			});

			if (STRICT_AX_MODE) {
				const textTarget = preferredTextTarget(currentDetails);
				if (textTarget?.ref) {
					await runTextEditCase("TextEdit-batch-ax", "computer_actions", async () => {
						return await executeComputerActions(
							"bench-TextEdit-batch-ax",
							{
								captureId: currentDetails.capture.captureId,
								actions: [
									{ type: "set_text", ref: textTarget.ref, text: "pi-computer-use benchmark AX batch" },
								],
							},
							undefined,
							undefined,
							ctx,
						);
					});
				} else {
					records.push({ name: "TextEdit-batch-ax", category: item.category, tool: "computer_actions", app: item.app, status: "SKIP", details: "No AX ref available for strict batch" });
				}

				const scrollTarget = preferredScrollTarget(currentDetails);
				if (scrollTarget?.ref) {
					await runTextEditCase("TextEdit-scroll-ax", "scroll", async () => {
						return await executeScroll("bench-TextEdit-scroll-ax", { ref: scrollTarget.ref, scrollY: 120, captureId: currentDetails.capture.captureId }, undefined, undefined, ctx);
					});
				} else {
					records.push({ name: "TextEdit-scroll-ax", category: item.category, tool: "scroll", app: item.app, status: "SKIP", details: "No AX scroll ref available" });
				}

				const adjustTarget = preferredAdjustTarget(currentDetails);
				if (adjustTarget?.ref) {
					await runTextEditCase("TextEdit-drag-adjust-ax", "drag", async () => {
						return await executeDrag(
							"bench-TextEdit-drag-adjust-ax",
							{
								ref: adjustTarget.ref,
								path: [
									[point.x, point.y],
									[Math.min(Number(currentDetails.capture.width) - 4, point.x + 24), point.y],
								],
								captureId: currentDetails.capture.captureId,
							},
							undefined,
							undefined,
							ctx,
						);
					});
				} else {
					records.push({ name: "TextEdit-drag-adjust-ax", category: item.category, tool: "drag", app: item.app, status: "SKIP", details: "No AX adjustable ref available" });
				}

				for (const tool of ["double_click", "move_mouse", "keypress", "type_text"] as const) {
					records.push({ name: `TextEdit-${tool}`, category: item.category, tool, app: item.app, status: "SKIP", details: "Strict AX mode intentionally blocks raw primitive coverage" });
				}
			} else {
				await runTextEditCase("TextEdit-keypress", "keypress", async () => {
					return await executeKeypress("bench-TextEdit-keypress", { keys: ["Enter"] }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-type-text", "type_text", async () => {
					return await executeTypeText("bench-TextEdit-type-text", { text: "benchmark raw insertion" }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-move-mouse", "move_mouse", async () => {
					return await executeMoveMouse("bench-TextEdit-move", { x: point.x, y: point.y, captureId: currentDetails.capture.captureId }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-double-click", "double_click", async () => {
					return await executeDoubleClick("bench-TextEdit-double", { x: point.x, y: point.y, captureId: currentDetails.capture.captureId }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-drag", "drag", async () => {
					return await executeDrag(
						"bench-TextEdit-drag",
						{
							path: [
								[point.x, point.y],
								[Math.min(Number(currentDetails.capture.width) - 4, point.x + 18), Math.min(Number(currentDetails.capture.height) - 4, point.y + 18)],
							],
							captureId: currentDetails.capture.captureId,
						},
						undefined,
						undefined,
						ctx,
					);
				});
				await runTextEditCase("TextEdit-scroll", "scroll", async () => {
					return await executeScroll("bench-TextEdit-scroll", { x: point.x, y: point.y, scrollY: 120, captureId: currentDetails.capture.captureId }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-batch", "computer_actions", async () => {
					const textTarget = preferredTextTarget(currentDetails);
					return await executeComputerActions(
						"bench-TextEdit-batch",
						{
							captureId: currentDetails.capture.captureId,
							actions: [
								{ type: "move_mouse", x: point.x, y: point.y },
								{ type: "click", x: point.x, y: point.y },
								{ type: "set_text", ref: textTarget?.ref, text: "pi-computer-use benchmark batch" },
								{ type: "keypress", keys: ["Enter"] },
								{ type: "type_text", text: "batch insertion" },
							],
						},
						undefined,
						undefined,
						ctx,
					);
				});
			}
		}

		if (item.app === "Finder" && details) {
			const waitCtx = makeCtx([{ type: "message", message: { role: "toolResult", toolName: "screenshot", details } }]);
			reconstructStateFromBranch(waitCtx);
			const wait = await benchmarkCase(`${item.app}-wait`, item.category, "wait", item.app, async () => {
				return await executeWait(`bench-${item.app}-wait`, { ms: 20 }, undefined, undefined, waitCtx);
			});
			records.push(wait.record);
		}
	}

	stopBridge();

	const benchmarkMetrics = metrics(records);
	const summary: BenchmarkSummary = {
		date: new Date().toISOString(),
		strictAxMode: STRICT_AX_MODE,
		allowScreenTakeover: ALLOW_SCREEN_TAKEOVER,
		host: os.hostname(),
		cwd: process.cwd(),
		metrics: benchmarkMetrics,
		goals: goalStatus(benchmarkMetrics),
		cases: records,
	};
	if (BASELINE_PATH) {
		const baseline = readJsonFile(path.resolve(BASELINE_PATH));
		summary.comparison = {
			baselinePath: path.resolve(BASELINE_PATH),
			...compareMetrics(summary.metrics, baseline.metrics),
		};
	}

	const text = JSON.stringify(summary, null, 2);
	console.log(text);
	if (OUTPUT_PATH) {
		fs.writeFileSync(path.resolve(OUTPUT_PATH), text);
	}
	if (summary.metrics.failed > 0 || summary.goals?.status === "FAIL" || summary.comparison?.status === "FAIL") {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	stopBridge();
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
