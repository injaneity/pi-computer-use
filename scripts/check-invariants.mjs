import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { noteAfterAct, noteFromLook } from "../src/note.ts";
import { countOutlineNodes, foldToBudget, graftScopedOutline, nodeByRef, parseLookResponse } from "../src/outline.ts";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const swift = fs.readFileSync(path.join(root, "native/macos/bridge.swift"), "utf8");
const ts = fs.readFileSync(path.join(root, "src/bridge.ts"), "utf8");
const noteTs = fs.readFileSync(path.join(root, "src/note.ts"), "utf8");
const configTs = fs.readFileSync(path.join(root, "src/config.ts"), "utf8");
const setupHelper = fs.readFileSync(path.join(root, "scripts/setup-helper.mjs"), "utf8");
const srcFiles = fs.readdirSync(path.join(root, "src"), { recursive: true })
	.filter((file) => typeof file === "string" && file.endsWith(".ts"))
	.map((file) => [file, fs.readFileSync(path.join(root, "src", file), "utf8")]);
const results = [];

function check(name, fn) {
	try {
		fn();
		results.push([name, true]);
		console.log(`PASS ${name}`);
	} catch (error) {
		results.push([name, false]);
		process.exitCode = 1;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

check("INV-1 static helper observation commands removed", () => {
	assert(!swift.includes("visionTargets"), "bridge.swift still contains visionTargets");
	assert(!swift.includes("axSnapshotTree"), "bridge.swift still contains axSnapshotTree");
	assert(!/case\s+"screenshot"/.test(swift), "bridge.swift still dispatches screenshot");
});

check("INV-1 static src lookCompat absent", () => {
	for (const [file, text] of srcFiles) {
		assert(!text.includes("lookCompat"), `lookCompat appears in src/${file}`);
	}
});

check("INV-2 static no TS coordinate transforms or capture dimensions", () => {
	for (const [file, text] of srcFiles) {
		assert(!/screenPointToCapturePoint|screenFrameToCaptureFrame/.test(text), `coordinate transform appears in src/${file}`);
		assert(!/\bcaptureWidth\b|\bcaptureHeight\b/.test(text), `capture dimensions appear in src/${file}`);
	}
});

check("INV-3 static scene fusion and auto-confirm absent", () => {
	for (const [file, text] of srcFiles) {
		assert(!/sceneAxTargetsFromSemantic|buildSceneProjection|autoConfirmButton|coordinateStateSignature/.test(text), `deleted scene/confirm helper appears in src/${file}`);
	}
});

check("INV-4 static act owns input command surface", () => {
	assert(srcFiles.some(([, text]) => /interface HelperActResult[\s\S]*outcome: ActOutcome/.test(text)), "TS helper act result does not carry outcome");
	for (const [file, text] of srcFiles) {
		assert(!/verifiedCoordinateClick|coordinateStateSignature/.test(text), `deleted verification helper appears in src/${file}`);
	}
	const deletedCommands = [
		"mouseClick", "mouseMove", "mouseDrag", "scrollWheel", "keyPress", "typeText", "setValue", "selectText",
		"axClickElement", "axPerformActionElement", "axFocusElement", "axFocusAtPoint", "axClickAtPoint",
		"axFindTextInput", "axFocusTextInput", "axPressElement", "axPressAtPoint",
	];
	for (const command of deletedCommands) {
		assert(!new RegExp(`case\\s+"${command}"`).test(swift), `bridge.swift still dispatches ${command}`);
		assert(!new RegExp(`bridgeCommand(?:<[^>]+>)?\\(\\s*["']${command}["']`).test(ts), `src still calls helper command ${command}`);
	}
});

check("INV-8 deleted architecture-v1 identifiers absent", () => {
	const deletedSrcIdentifiers = [
		"SceneProjection", "SceneTarget", "SceneEdge", "SceneAssociation", "buildSceneProjection",
		"sceneAssociationScore", "labelAssociationScore", "bestEdgesByVision", "clusterVisionUnknowns",
		"semanticSceneTarget", "visionSceneTarget", "searchSceneTargets", "sceneAxTargetsFromSemantic",
		"parseVisionTargets", "visionTargetByRef", "visionClickPoint", "formatVisionTargetLabel",
		"axCoordinateFallbackPoint", "screenPointToCapturePoint", "screenFrameToCaptureFrame",
		"frameCenter", "frameArea", "intersectionArea", "coordinateStateSignature",
		"verifiedCoordinateClick", "mouseClickAtCapturePoint", "autoConfirmButton", "refreshAxTargets",
		"axTreeRawForTarget", "semanticAxTree", "helperVisionTargets", "currentSemanticAxTargets",
		"currentVisionTargets", "currentScene", "lookCompat", "SceneToolDetails", "ScreenshotParams",
		"ScreenshotPayload", "performScreenshot", "coordinateVerification", "coordinateStateChanged",
	];
	for (const [file, text] of srcFiles) {
		for (const identifier of deletedSrcIdentifiers) {
			assert(!text.includes(identifier), `${identifier} appears in src/${file}`);
		}
	}
	const deletedNativeIdentifiers = ["visionTargets", "axSnapshotTree", "reacquireAxTarget"];
	for (const identifier of deletedNativeIdentifiers) {
		assert(!swift.includes(identifier), `${identifier} appears in native/macos/bridge.swift`);
	}
});

check("INV-5 listRoots seam stays platform-neutral", () => {
	assert(srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*isModal: boolean/.test(text)), "PlatformRoot lacks required isModal fact");
	assert(srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*metadata\?: Record<string, unknown>/.test(text)), "PlatformRoot lacks metadata escape hatch");
	assert(!srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*\bpairing:/.test(text)), "PlatformRoot must not require pairing");
	assert(!srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*\bsheetCount:/.test(text)), "PlatformRoot must not require sheetCount");
});

function enclosingFunctionName(text, index) {
	const prefix = text.slice(0, index);
	const matches = [...prefix.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)];
	return matches.at(-1)?.[1] ?? "(unknown)";
}

check("INV-6 static note is derived and disposable", () => {
	for (const match of noteTs.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)) {
		assert(/^note|^render/.test(match[1]), `src/note.ts exports non-note/render function ${match[1]}`);
	}
	assert(!/export\s+(let|const|var)\s+/.test(noteTs), "src/note.ts exports mutable or module state");
	const allowed = new Set(["captureCurrentTarget", "runActionTool", "reconstructStateFromBranch", "shutdownComputerUseSession"]);
	for (const match of ts.matchAll(/runtimeState\.currentNote\s*=/g)) {
		const fn = enclosingFunctionName(ts, match.index ?? 0);
		assert(allowed.has(fn), `runtimeState.currentNote assigned in ${fn}`);
	}
});

check("INV-7 static no label-confirm press regex", () => {
	for (const [file, text] of srcFiles) {
		assert(!/\/[^/\n]*(confirm|ok|continue|apply)[^/\n]*\/[gimsuyd]*[\s\S]{0,200}(\bpress\b|AXPress|axPress|axPerformActionElement)/i.test(text), `confirm-label press regex appears in src/${file}`);
		assert(!/(confirm|ok|continue|apply)[\s\S]{0,80}(includes|startsWith|endsWith|===|==)[\s\S]{0,200}(\bpress\b|AXPress|axPress|axPerformActionElement)/i.test(text), `confirm-label press comparison appears in src/${file}`);
	}
});

check("INV-8 tsc no unused locals", () => {
	execFileSync("npx", ["tsc", "--noEmit"], { cwd: root, stdio: "pipe" });
});

check("INV-9 immutable state ownership", () => {
	const state = fs.readFileSync(path.join(root, "src/state.ts"), "utf8");
	assert(!/runtimeState\.current(Target|Capture|Look|Outline|Note|ImageMode|StateTarget)/.test(ts), "global current UI state remains in bridge");
	assert(state.includes("class SavedStates") && state.includes("new StateStore<UiObservation>"), "unified bounded observation store is missing");
});

check("INV-10 resource-keyed scheduling", () => {
	assert(ts.includes("desktopResourceKey") && ts.includes("resourceScheduler.write"), "desktop writes are not resource scheduled");
	assert(!ts.includes("withRuntimeLock"), "global runtime lock remains");
});

check("INV-11 unified agent contract", () => {
	const extension = fs.readFileSync(path.join(root, "extensions/computer-use.ts"), "utf8");
	const tools = [...extension.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1]);
	const expected = ["find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui", "act_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser"];
	assert(JSON.stringify(tools) === JSON.stringify(expected), `unexpected public tool surface: ${tools.join(", ")}`);
	assert(!extension.includes('executionMode: "sequential"'), "computer-use tools remain globally sequential");
	assert(extension.includes("Required state id owning every @e ref"), "state-scoped ref contract is missing");
});

check("INV-12 parallel native transports", () => {
	const swift = fs.readFileSync(path.join(root, "native/macos/bridge.swift"), "utf8");
	const windows = fs.readFileSync(path.join(root, "native/windows/bridge-rs/src/main.rs"), "utf8");
	assert(swift.includes("Thread.detachNewThread") && swift.includes("physicalInputLock"), "macOS helper is not concurrent with protected physical input");
	assert(swift.includes("flock(lockFile, LOCK_EX | LOCK_NB)"), "macOS helper daemon is not singleton-safe");
	assert(windows.includes("thread::spawn") && windows.includes("physical_input_lock"), "Windows helper is not concurrent with protected physical input");
});

check("INV-14 native batches settle once", () => {
	const swift = fs.readFileSync(path.join(root, "native/macos/bridge.swift"), "utf8");
	const windows = fs.readFileSync(path.join(root, "native/windows/bridge-rs/src/main.rs"), "utf8");
	assert(ts.includes("currentPlatformBackend.actBatch") && ts.includes("dispatchUiTransaction"), "bridge does not route batches through the native transaction seam");
	assert(swift.includes('case "actBatch"') && swift.includes("deferRootDelta"), "macOS helper does not defer per-step root deltas");
	assert(windows.includes('"actBatch" => handle_act_batch') && windows.includes("deferRootDelta"), "Windows helper does not defer per-step root deltas");
	assert(swift.includes('response["stoppedAt"]') && windows.includes('response["stoppedAt"]'), "native batches do not report their checked stop boundary");
});

check("INV-15 semantic action postconditions", () => {
	const extension = fs.readFileSync(path.join(root, "extensions/computer-use.ts"), "utf8");
	const actions = fs.readFileSync(path.join(root, "src/actions.ts"), "utf8");
	const swift = fs.readFileSync(path.join(root, "native/macos/bridge.swift"), "utf8");
	assert(extension.includes("expect: Type.Optional") && extension.includes("timeoutMs"), "act_ui does not expose a semantic postcondition");
	assert(ts.includes('code: "postcondition_failed"') && ts.includes('status: "verified" | "preexisting" | "failed"'), "postcondition failure is not represented honestly");
	assert(ts.includes("outcomeAfterCheck") && actions.includes('check === "verified"') && actions.includes('return "worked"'), "newly verified expectations do not determine the request outcome");
	assert(swift.includes("waitForRootChange") && swift.includes("state.change.broadcast()"), "macOS waits are not change-notification assisted");
});

check("INV-16 clean headless contract and non-destructive helper install", () => {
	assert(!/stealth_mode|stealthMode|PI_COMPUTER_USE_STEALTH|PI_COMPUTER_USE_STRICT_AX/.test(configTs), "obsolete stealth configuration aliases remain");
	assert(!/tccutil[\s\S]{0,80}reset|resetTcc/i.test(setupHelper), "helper installation can reset macOS privacy grants");
	assert(setupHelper.includes("pi-computer-use Local Signing (com.injaneity.pi-computer-use)"), "stable bundle-specific local signing identity is missing");
	assert(setupHelper.includes("PI_COMPUTER_USE_HELPER_APP_PATH"), "helper installer lacks an isolated test destination");
});

check("INV-17 macOS agent cursor stays native, configurable, and headless-safe", () => {
	assert(configTs.includes("cursor_overlay: boolean") && configTs.includes("PI_COMPUTER_USE_CURSOR_OVERLAY"), "agent cursor config is incomplete");
	assert(swift.includes('policy != "ax_only"'), "strict-headless actions can display the agent cursor");
	assert(swift.includes('request["cursorOverlay"] as? Bool ?? true'), "native helper ignores the cursor overlay flag");
	assert(swift.includes("app.processIdentifier != getpid()"), "helper overlay can leak into root discovery");
	assert(swift.includes("AgentCursor.shared.animate(to:"), "native grounded actions do not drive the agent cursor");
	assert(!swift.includes("completed.wait()") && !swift.includes("agentCursorLock"), "agent cursor can delay action delivery");
});

check("INV-18 consolidated actions and diff-first resulting views", () => {
	const actions = fs.readFileSync(path.join(root, "src/actions.ts"), "utf8");
	const view = fs.readFileSync(path.join(root, "src/view.ts"), "utf8");
	const macBackend = fs.readFileSync(path.join(root, "src/platform/macos/backend.ts"), "utf8");
	const extension = fs.readFileSync(path.join(root, "extensions/computer-use.ts"), "utf8");
	assert(actions.includes("prepareAction") && actions.includes("canRetryInForeground"), "action preparation and safe recovery are not consolidated");
	assert(!fs.existsSync(path.join(root, "src/interaction.ts")), "superseded interaction policy module still exists");
	assert(!ts.includes("responseMode") && !extension.includes("responseMode"), "alternate confirmation-only action path still exists");
	assert(ts.includes("currentFocus") && ts.includes('escalationReason = "side_effect_free_didnt"'), "runner does not preserve action focus or recover checked keyboard failures");
	assert(view.includes("stabilizeRefs") && view.includes("changesBetween"), "resulting-state ref stabilization or change rendering is missing");
	assert(ts.includes('view: "full" | "diff"') && ts.includes("Changes ("), "agent result does not expose changes-first resulting views");
	assert(extension.includes("const uiAction = Type.Union") && extension.includes("omit ref from typeText"), "agent action schema is not discriminated or focus-aware");
	assert(!ts.includes("preserveFocus") && macBackend.includes("preserveFocus") && swift.includes("!preserveFocus"), "native focus continuity leaks through the coordinator or is not enforced by the backend");
});

check("INV-8 swift typecheck", () => {
	const triple = process.arch === "x64" ? "x86_64-apple-macosx14.0" : "arm64-apple-macosx14.0";
	execFileSync("xcrun", [
		"swiftc", "-target", triple, "-parse-as-library",
		"-module-cache-path", path.join(os.tmpdir(), `pi-computer-use-swift-typecheck-${process.arch}`),
		"-framework", "ApplicationServices",
		"-framework", "AppKit",
		"-framework", "ScreenCaptureKit",
		"-framework", "Foundation",
		"-framework", "SwiftUI",
		"-typecheck",
		"native/macos/agent_cursor.swift",
		"native/macos/agent_cursor_motion.swift",
		"native/macos/bridge.swift",
	], { cwd: root, stdio: "pipe" });
});

function call(socketPath, payload, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`timeout calling ${payload.cmd}`));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			socket.end();
			const parsed = JSON.parse(buffer.slice(0, newline));
			if (!parsed.ok) reject(new Error(parsed.error?.message ?? `${payload.cmd} failed`));
			else resolve(parsed.result);
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function callEnvelope(socketPath, payload, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`timeout calling ${payload.cmd}`));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			socket.end();
			resolve(JSON.parse(buffer.slice(0, newline)));
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function walk(node, visit) {
	visit(node);
	for (const child of Array.isArray(node?.children) ? node.children : []) walk(child, visit);
}

function windowLabel(window) {
	if (!window) return "unknown window";
	return `${window.appName ?? window.app ?? "unknown app"} — ${window.title ?? window.windowTitle ?? "(untitled)"} (${window.windowId ?? "no windowId"})`;
}

async function pidForWindow(socketPath, windowId) {
	const apps = await call(socketPath, { id: "inv-apps", cmd: "listApps" });
	for (const app of Array.isArray(apps) ? apps : []) {
		const windows = ((await call(socketPath, { id: `inv-roots-${app.pid}`, cmd: "listRoots", pid: app.pid }).catch(() => ({ roots: [] }))).roots) ?? [];
		const match = Array.isArray(windows) ? windows.find((window) => window?.windowId === windowId) : undefined;
		if (match) return { pid: app.pid, appName: app.appName, title: match.title ?? match.windowTitle };
	}
	return undefined;
}

async function liveChecks() {
	if (process.env.PI_CU_LIVE !== "1") {
		console.log("SKIP LIVE invariants (set PI_CU_LIVE=1)");
		return;
	}
	try {
		const socketPath = process.env.PI_CU_SOCKET_PATH ?? path.join(os.homedir(), "Library/Caches/pi-computer-use/bridge.sock");
		const diagnostics = await call(socketPath, { id: "inv-diagnostics", cmd: "diagnostics" });
		check("LIVE diagnostics current protocol", () => assert(diagnostics.protocolVersion === 6, `protocolVersion=${diagnostics.protocolVersion}`));
		const explicitWindowId = process.env.PI_CU_LIVE_WINDOW_ID ? Number(process.env.PI_CU_LIVE_WINDOW_ID) : undefined;
		let windows = [];
		try {
			const frontmost = await call(socketPath, { id: "inv-frontmost", cmd: "getFrontmost" });
			windows = ((await call(socketPath, { id: "inv-roots", cmd: "listRoots", pid: frontmost.pid })).roots) ?? [];
			check("LIVE listRoots pairing", () => {
				assert(Array.isArray(windows), "listRoots did not return an array");
				for (const window of windows) {
					assert(["exact", "high", "low"].includes(window?.metadata?.pairing?.confidence), `invalid pairing ${JSON.stringify(window?.metadata?.pairing)}`);
				}
			});
		} catch (error) {
			if (!explicitWindowId) throw error;
			console.log(`SKIP LIVE listRoots pairing (${error.message}; explicit PI_CU_LIVE_WINDOW_ID=${explicitWindowId})`);
		}
		let target = explicitWindowId && Number.isFinite(explicitWindowId)
			? { windowId: Math.trunc(explicitWindowId), title: "PI_CU_LIVE_WINDOW_ID", appName: "explicit target" }
			: Array.isArray(windows) ? windows.find((window) => Number.isFinite(window?.windowId)) : undefined;
		if (explicitWindowId && !Number.isFinite(explicitWindowId)) {
			throw new Error(`PI_CU_LIVE_WINDOW_ID must be numeric, got ${process.env.PI_CU_LIVE_WINDOW_ID}`);
		}
		if (!target) {
			console.log("SKIP LIVE look (no capturable frontmost window; Accessibility may be missing)");
			return;
		}
		const look = await call(socketPath, { id: "inv-look", cmd: "look", windowId: target.windowId, readText: "always" }, 20000);
		if (explicitWindowId) {
			target = { ...target, ...look.window, title: look.window?.title ?? target.title };
		}
		const pidInfo = await pidForWindow(socketPath, target.windowId);
		if (pidInfo) {
			target = { ...target, ...pidInfo, appName: pidInfo.appName ?? target.appName, title: pidInfo.title ?? target.title };
		}
		check("LIVE look one moment", () => {
			assert(typeof look.capturedAt === "number", "missing capturedAt");
			assert(look.image && look.outline, "missing image or outline");
		});
		check("LIVE rects within image", () => {
			walk(look.outline, (node) => {
				const rect = node?.rect;
				if (!rect) return;
				assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= look.image.width + 0.01 && rect.y + rect.h <= look.image.height + 0.01, `rect out of bounds ${JSON.stringify(rect)}`);
			});
		});
		check("LIVE text annotations", () => {
			let found = false;
			walk(look.outline, (node) => {
				if (Array.isArray(node?.text) && node.text.length) found = true;
			});
			assert(found, "no text annotations");
		});
		check("LIVE window pairing", () => {
			assert(look.window?.metadata?.pairing, "missing window.metadata.pairing");
		});
		const parsedForNote = parseLookResponse(look).parsedOutline;
		check("LIVE note derivation", () => {
			assert(parsedForNote, "parseLookResponse did not return parsed outline");
			const note = noteFromLook(undefined, parsedForNote, {
				windowRef: target.windowRef ?? `@window-${target.windowId}`,
				title: target.title ?? target.windowTitle ?? "(untitled)",
				pairing: look.window?.metadata?.pairing?.confidence ?? "low",
				pairingScore: look.window?.metadata?.pairing?.score,
			});
			const topLevel = parsedForNote.root.children.length ? parsedForNote.root.children : [parsedForNote.root];
			for (const top of topLevel) {
				const region = note.regions.find((candidate) => candidate.status === "seen" && candidate.key.startsWith(`${top.role || "AXUnknown"}:`));
				assert(region, `top-level region not marked seen for ${top.ref}`);
			}
			const targetNode = parsedForNote.nodes.find((node) => node !== parsedForNote.root) ?? parsedForNote.root;
			const acted = noteAfterAct(note, targetNode.ref, parsedForNote, {
				window: {
					windowRef: note.windowRef,
					title: note.title,
					pairing: note.pairing,
				},
			});
			assert(acted.regions.some((region) => region.status === "changed" && region.detail === "acted here"), "synthetic act did not mark a region changed");
			const hasFrontier = parsedForNote.nodes.some((node) => node.truncated || (node.scrollExtent && node.scrollExtent.seen < node.scrollExtent.total));
			if (hasFrontier) {
				assert(acted.regions.some((region) => region.status === "never-looked"), "frontier node did not create never-looked note entry");
			} else {
				console.log(`SKIP LIVE note frontier (no truncated or partially scrolled node in ${windowLabel(target)})`);
			}
		});
		console.log("LIVE INV-4 act behavior is limited to hitTest, stale_ref, and stale_look; side-effect verification belongs to cubench.");
		assert(Number.isFinite(target.pid), `could not resolve pid for ${windowLabel(target)}`);
		const centerX = Math.floor(look.image.width / 2);
		const centerY = Math.floor(look.image.height / 2);
		const hit = await call(socketPath, { id: "inv-hit-test", cmd: "hitTest", lookId: look.lookId, windowId: target.windowId, x: centerX, y: centerY }, 10000);
		const staleRef = await callEnvelope(socketPath, { id: "inv-act-stale-ref", cmd: "act", lookId: look.lookId, pid: target.pid, target: { ref: "bogus-ref-for-invariant" }, action: "press", params: {} }, 10000);
		const staleLook = await callEnvelope(socketPath, { id: "inv-act-stale-look", cmd: "act", lookId: "bogus-look-for-invariant", pid: target.pid, target: { x: centerX, y: centerY }, action: "moveMouse", params: {} }, 10000);
		check("LIVE hitTest and stale act errors", () => {
			assert(Number.isFinite(target.pid), `could not resolve pid for ${windowLabel(target)}`);
			assert(hit && typeof hit.role === "string", `hitTest did not return a node: ${JSON.stringify(hit)}`);
			assert(staleRef.ok === false && staleRef.error?.code === "stale_ref", `bogus ref did not return stale_ref: ${JSON.stringify(staleRef)}`);
			assert(staleLook.ok === false && staleLook.error?.code === "stale_look", `bogus look did not return stale_look: ${JSON.stringify(staleLook)}`);
		});
		check("LIVE foldToBudget preserves full outline", () => {
			const parsed = parseLookResponse(look).parsedOutline;
			assert(parsed, "parseLookResponse did not return parsed outline");
			const folded = foldToBudget(parsed, { maxDepth: 1, maxNodes: 20 });
			const budgetCut = foldToBudget(parsed, { maxDepth: 10, maxNodes: 5 });
			assert(/more nodes not shown/.test(budgetCut.text.split("\n").at(-1) ?? ""), "budget-cut fold lacks receipt line");
			const defaultFold = foldToBudget(parsed);
			for (const focused of parsed.nodes.filter((node) => node.focused)) {
				assert(defaultFold.renderedRefs.includes(focused.ref), `focused ref ${focused.ref} was not rendered by default fold`);
			}
			const foldedLines = folded.text.split("\n").filter((line) => line.includes(" ▸ "));
			assert(foldedLines.length > 0, "no folded lines rendered");
			for (const line of foldedLines) assert(/▸ \(\d+/.test(line), `folded line lacks count: ${line}`);
			assert(folded.nodeCount === countOutlineNodes(parsed.root), `node count mismatch ${folded.nodeCount}`);
			assert(folded.fullUnfoldLineCount === folded.nodeCount, "full unfold count differs from total nodes");
		});
		const fullOutline = parseLookResponse(look).parsedOutline;
		const truncated = fullOutline?.nodes.find((node) => node.truncated && node.wireRef);
		if (!fullOutline || !truncated) {
			console.log(`SKIP LIVE scoped graft (no truncated node in ${windowLabel(target)})`);
		} else {
			const beforeRefs = new Map(fullOutline.nodes.map((node) => [node.ref, node.wireRef]));
			const beforeMax = Math.max(...fullOutline.nodes.map((node) => Number(/^@e(\d+)$/.exec(node.ref)?.[1] ?? 0)));
			const state = { stateId: "full-state", capture: { width: look.image.width, height: look.image.height } };
			const scopedLook = await call(socketPath, { id: "inv-look-scope", cmd: "look", windowId: target.windowId, readText: "auto", scopeRef: truncated.wireRef, maxDimension: 1 }, 20000);
			check("LIVE scoped graft preserves full state", () => {
				const scopedOutline = parseLookResponse(scopedLook).parsedOutline;
				assert(scopedOutline, "scoped look did not parse");
				graftScopedOutline(fullOutline, truncated.ref, scopedOutline);
				for (const [ref, wireRef] of beforeRefs) {
					const node = nodeByRef(fullOutline, ref);
					assert(node, `pre-existing ref disappeared: ${ref}`);
					assert(node.wireRef === wireRef, `pre-existing ref changed elementRef: ${ref}`);
				}
				assert(state.stateId === "full-state" && state.capture.width === look.image.width && state.capture.height === look.image.height, "state/capture sentinel changed");
				const afterMax = Math.max(...fullOutline.nodes.map((node) => Number(/^@e(\d+)$/.exec(node.ref)?.[1] ?? 0)));
				assert(afterMax >= beforeMax, "ref counter moved backwards");
				for (const node of fullOutline.nodes) {
					const number = Number(/^@e(\d+)$/.exec(node.ref)?.[1] ?? 0);
					if (!beforeRefs.has(node.ref)) assert(number > beforeMax, `new ref did not continue numbering: ${node.ref}`);
				}
			});
		}
	} catch (error) {
		results.push(["LIVE", false]);
		process.exitCode = 1;
		console.error(`FAIL LIVE ${error.message}`);
	}
}

await liveChecks();
if (results.some(([, ok]) => !ok)) process.exit(1);
