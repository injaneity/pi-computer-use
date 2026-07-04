#!/usr/bin/env -S node --experimental-transform-types
import {
	executeAct,
	executeFind,
	executeObserve,
	executeSearchUi,
	executeWaitFor,
} from "../src/bridge.ts";

const input = JSON.parse((await readStdin()) || process.env.CUBENCH_INPUT || "{}");
const started = Date.now();
const actions = [];
let toolCalls = 0;
let observations = 0;
let semanticActions = 0;
let coordinateActions = 0;

const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	ui: {
		select: async () => "Cancel",
		notify: () => undefined,
	},
	sessionManager: { getBranch: () => [] },
};

try {
	await observe();
	const row = await searchExact("invoice_123.pdf") ?? await searchFirst({ text: "invoice_123.pdf" });
	if (!row) throw new Error("Could not find target filename invoice_123.pdf");
	await act({ action: "click", ref: row.ref });

	let field = await searchFirst({ text: "New file name" }) ?? await searchFirst({ role: "AXTextField" }) ?? await searchFirst({ role: "AXTextArea" });
	if (field) {
		await act({ action: "setText", ref: field.ref, text: "paid_invoice_123.pdf" });
	} else {
		await act({ action: "keypress", keys: ["cmd", "a"] });
		await act({ action: "typeText", text: "paid_invoice_123.pdf" });
	}

	let button = await searchFirst({ text: "Rename Selected File" }) ?? await searchFirst({ text: "Rename" }) ?? await searchFirst({ text: "Apply" });
	if (!button) throw new Error("Could not find rename/apply button");
	const renameResult = await act({ action: "click", ref: button.ref });

	// The confirm-modal variant raises a sheet; the act's root delta is how
	// the agent learns about it. Observe the new root before searching it.
	let appeared = renameResult.details?.execution?.rootDelta?.find((delta) => delta.change === "appeared");
	if (!appeared && input.variant?.includes?.("confirm-modal")) {
		const roots = await tool(executeFind, { app: input.target?.appName ?? "Cubench", kind: "sheet" });
		const sheet = roots.details?.windows?.[0];
		if (sheet) appeared = { ref: sheet.windowRef, kind: sheet.kind, title: sheet.windowTitle, change: "appeared" };
	}
	if (appeared) {
		observations += 1;
		await tool(executeObserve, { root: appeared.ref, mode: "fused", image: "never" });
		const modal = await searchFirst({ text: "Confirm Rename", role: "AXButton" }) ?? await searchFirst({ text: "Confirm", role: "AXButton" }) ?? await searchFirst({ text: "Rename", role: "AXButton" }) ?? await searchFirst({ text: "Replace", role: "AXButton" }) ?? await searchFirst({ text: "OK", role: "AXButton" }) ?? await searchFirst({ text: "Confirm Rename" }) ?? await searchFirst({ text: "Confirm" }) ?? await searchFirst({ role: "AXButton" });
		if (!modal) throw new Error(`A root appeared (${appeared.kind} ${appeared.title ?? ""}) but no confirm control was found in it.`);
		await act({ action: "click", ref: modal.ref });
	}

	await waitFor({ text: "paid_invoice_123.pdf", timeoutMs: 5_000 }).catch(() => undefined);
	console.log(JSON.stringify(result("completed", "Done")));
} catch (error) {
	console.log(JSON.stringify(result("failed", error instanceof Error ? error.message : String(error))));
	process.exitCode = 1;
}

async function observe() {
	observations += 1;
	const app = input.target?.appName ?? "Cubench";
	const roots = await tool(executeFind, { app, kind: "window" });
	const root = roots.details?.windows?.[0]?.windowRef;
	return await tool(executeObserve, {
		app,
		windowTitle: input.target?.windowTitle,
		root,
		mode: "fused",
		image: "auto",
	});
}

async function searchFirst(params) {
	const result = await tool(executeSearchUi, { ...params, limit: 20 });
	return result.details?.matches?.[0];
}

async function searchExact(text) {
	const result = await tool(executeSearchUi, { text, limit: 50 });
	return result.details?.matches?.find((match) => match.label === text || match.node?.title === text || match.node?.value === text);
}

async function waitFor(params) {
	return await tool(executeWaitFor, params);
}

async function act(params) {
	if (params.ref) semanticActions += 1;
	else coordinateActions += 1;
	actions.push({ type: params.action, targetRef: params.ref, text: params.text });
	return await tool(executeAct, { ...params, responseMode: "confirmation" });
}

async function tool(executor, params) {
	toolCalls += 1;
	return await executor(`cubench-${toolCalls}`, params, undefined, undefined, ctx);
}

function result(status, finalMessage) {
	return {
		runId: input.runId,
		status,
		finalMessage,
		telemetry: {
			toolCalls,
			observations,
			screenshots: observations,
			semanticActions,
			coordinateActions,
			latencyMs: Date.now() - started,
		},
		actions,
	};
}

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.on("data", (chunk) => { data += chunk; });
		process.stdin.on("end", () => resolve(data));
	});
}
