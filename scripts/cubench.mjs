import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (!process.execArgv.includes("--experimental-transform-types")) {
	const child = spawnSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
	process.exit(child.status ?? 1);
}

const { executeAct, executeExpandUi, executeObserve, executeSearchUi } = await import("../src/bridge.ts");
const { foldToBudget, parseLookResponse } = await import("../src/outline.ts");

const root = path.resolve(new URL("..", import.meta.url).pathname);
const socketPath = process.env.PI_CU_SOCKET_PATH ?? path.join(os.homedir(), "Library/Caches/pi-computer-use/bridge.sock");
const outputPath = path.join(root, "scripts/cubench-results.json");
const preferredApps = ["Finder", "Safari", "Google Chrome", "Chrome", "System Settings", "Ghostty", "Terminal", "Code"];

function call(payload, timeoutMs = 20_000) {
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
			const envelope = JSON.parse(buffer.slice(0, newline));
			if (!envelope.ok) reject(new Error(`${payload.cmd} failed: ${envelope.error?.message ?? JSON.stringify(envelope.error)}`));
			else resolve(envelope.result);
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function timed(label, work) {
	const start = performance.now();
	const value = await work();
	return { label, value, wallMs: Math.round(performance.now() - start) };
}

function imageBytes(base64) {
	return Buffer.byteLength(base64 || "", "base64");
}

function textOf(result) {
	return (result.content ?? [])
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function outputStats(result) {
	const text = textOf(result);
	const renderedOutline = typeof result.details?.renderedOutline === "string" ? result.details.renderedOutline : "";
	return {
		textChars: text.length,
		textTokens: Math.ceil(text.length / 4),
		renderedOutlineChars: renderedOutline.length,
		renderedOutlineTokens: Math.ceil(renderedOutline.length / 4),
	};
}

function walkSerialized(node, visit) {
	visit(node);
	for (const child of Array.isArray(node?.children) ? node.children : []) walkSerialized(child, visit);
}

function actRefFromOutline(serialized) {
	let fallback;
	let best;
	walkSerialized(serialized.root, (node) => {
		if (!node?.wireRef || node.pictureOnly || !node.rect) return;
		fallback ??= node;
		if (!best && node.role !== "AXWindow" && node.role !== "AXApplication") best = node;
	});
	return best ?? fallback;
}

function windowScore(candidate) {
	const preferred = preferredApps.findIndex((name) => candidate.appName.toLowerCase().includes(name.toLowerCase()));
	const appScore = preferred < 0 ? preferredApps.length : preferred;
	const focusScore = candidate.isFocused ? -2 : candidate.isMain ? -1 : 0;
	return appScore * 10 + focusScore;
}

async function discoverWindows() {
	const apps = await call({ id: "cubench-apps", cmd: "listApps" });
	const windows = [];
	for (const app of Array.isArray(apps) ? apps : []) {
		const appWindows = await call({ id: `cubench-windows-${app.pid}`, cmd: "listWindows", pid: app.pid }).catch(() => []);
		for (const window of Array.isArray(appWindows) ? appWindows : []) {
			if (!Number.isFinite(window?.windowId) || window.isMinimized || window.isOnscreen === false) continue;
			windows.push({
				appName: app.appName ?? "Unknown App",
				bundleId: app.bundleId,
				pid: app.pid,
				title: window.title || window.windowTitle || "(untitled)",
				windowId: Math.trunc(window.windowId),
				isMain: window.isMain === true,
				isFocused: window.isFocused === true,
				pairing: window.pairing,
			});
		}
	}
	const unique = [...new Map(windows.map((window) => [window.windowId, window])).values()]
		.sort((a, b) => windowScore(a) - windowScore(b) || a.appName.localeCompare(b.appName) || a.title.localeCompare(b.title));
	if (unique.length < 3) throw new Error(`cubench needs at least 3 capturable windows; found ${unique.length}`);
	return unique.slice(0, Math.max(3, Math.min(5, unique.length)));
}

async function measureLook(window) {
	const auto = await timed("look-auto", () => call({ id: `cubench-look-auto-${window.windowId}`, cmd: "look", windowId: window.windowId, readText: "auto", maxDimension: 900 }));
	const explicit = await timed("look-explicit", () => call({ id: `cubench-look-explicit-${window.windowId}`, cmd: "look", windowId: window.windowId, readText: "auto", maxDimension: 1600 }));
	const parsed = parseLookResponse(auto.value).parsedOutline;
	const folded = foldToBudget(parsed);
	return {
		window,
		wallMs: auto.wallMs,
		outlineNodes: parsed.nodes.length,
		renderedOutlineChars: folded.text.length,
		renderedOutlineTokens: Math.ceil(folded.text.length / 4),
		imageBytes900: imageBytes(auto.value.image?.jpegBase64),
		imageBytes1600: imageBytes(explicit.value.image?.jpegBase64),
		timings: auto.value.timings ?? {},
	};
}

async function measureRoundTrip(window) {
	const ctx = { cwd: root, sessionManager: { getBranch: () => [] } };
	const observe = await timed("observe", () => executeObserve("cubench-observe", { window: window.windowId, mode: "fused", image: "never" }, undefined, undefined, ctx));
	const serialized = observe.value.details?.outline;
	if (!serialized?.root) throw new Error("observe did not return a serialized outline");
	const refNode = actRefFromOutline(serialized);
	const ref = refNode?.ref ?? serialized.root.ref;
	const role = refNode?.role && refNode.role !== "AXWindow" ? refNode.role : undefined;
	const capture = observe.value.details?.capture;
	const point = {
		x: Math.floor((capture?.width ?? 2) / 2),
		y: Math.floor((capture?.height ?? 2) / 2),
	};
	const search = await timed("search_ui", () => executeSearchUi("cubench-search", { role, limit: 8 }, undefined, undefined, ctx));
	const expand = await timed("expand_ui", () => executeExpandUi("cubench-expand", { ref, depth: 2 }, undefined, undefined, ctx));
	const act = await timed("act", () => executeAct("cubench-act", { action: "moveMouse", ...point, image: "never" }, undefined, undefined, ctx));
	return [observe, search, expand, act].map((entry) => ({
		tool: entry.label,
		wallMs: entry.wallMs,
		...outputStats(entry.value),
		outcome: entry.value.details?.execution?.outcome,
	}));
}

function printTable(title, rows, columns) {
	const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length)));
	const line = (row) => columns.map((column, index) => String(row[column] ?? "").padEnd(widths[index])).join("  ");
	console.log(`\n${title}`);
	console.log(line(Object.fromEntries(columns.map((column) => [column, column]))));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of rows) console.log(line(row));
}

const windows = await discoverWindows();
const looks = [];
for (const window of windows) looks.push(await measureLook(window));
const roundTrip = await measureRoundTrip(windows[0]);

printTable("cubench look", looks.map((look) => ({
	window: `${look.window.appName} — ${look.window.title}`.slice(0, 44),
	ms: look.wallMs,
	nodes: look.outlineNodes,
	tokens: look.renderedOutlineTokens,
	jpeg900: look.imageBytes900,
	jpeg1600: look.imageBytes1600,
})), ["window", "ms", "nodes", "tokens", "jpeg900", "jpeg1600"]);

printTable("cubench bridge round-trip", roundTrip.map((tool) => ({
	tool: tool.tool,
	ms: tool.wallMs,
	textChars: tool.textChars,
	textTokens: tool.textTokens,
	outlineTokens: tool.renderedOutlineTokens,
	outcome: tool.outcome ?? "",
})), ["tool", "ms", "textChars", "textTokens", "outlineTokens", "outcome"]);

const results = {
	capturedAt: new Date().toISOString(),
	windows,
	looks,
	roundTrip,
};
await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nWrote ${path.relative(root, outputPath)}`);
