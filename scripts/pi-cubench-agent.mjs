#!/usr/bin/env node
import {
	executeAct,
	executeFind,
	executeObserve,
	executeSearchUi,
	shutdownComputerUseSession,
} from "../src/bridge.ts";

const gateway = process.env.CUBENCH_GATEWAY;
if (!gateway) throw new Error("CUBENCH_GATEWAY is required");

const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => [] } };
let calls = 0;
let stateId;
let root;

try {
	const session = await request("POST", "/session", {});
	await selectRoot();
	await observe();
	if (/^Rename /.test(session.instruction)) await rename(session.instruction);
	else if (/^Turn on /.test(session.instruction)) await toggle(session.instruction);
	else throw new Error(`Unsupported Cubench instruction: ${session.instruction}`);
	await request("POST", "/done", { message: "done" });
} catch (error) {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
} finally {
	await shutdownComputerUseSession();
}

async function request(method, pathname, body) {
	const response = await fetch(`${gateway}${pathname}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${method} ${pathname} failed: ${response.status}`);
	return await response.json();
}

async function tool(executor, params) {
	calls += 1;
	return await executor(`cubench-${calls}`, params, undefined, undefined, ctx);
}

async function selectRoot() {
	const found = await tool(executeFind, { app: "Chromium", kind: "window" });
	const windows = found.details?.windows ?? [];
	const candidate = windows.find((item) => /cubench/i.test(item.windowTitle)) ?? windows.find((item) => item.isFocused) ?? windows[0];
	if (!candidate) throw new Error("Could not find the headed Cubench Chromium window");
	root = candidate.windowRef;
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({ root, window: candidate.windowTitle, app: candidate.app, bundleId: candidate.bundleId }));
}

async function observe() {
	const result = await tool(executeObserve, { root, mode: "fused", image: "auto" });
	stateId = result.details?.capture?.stateId;
	if (!stateId) throw new Error("Cubench observation did not return a desktop state");
	return result;
}

async function search(params) {
	const result = await tool(executeSearchUi, { stateId, ...params, limit: 50 });
	return result.details?.matches ?? [];
}

async function exact(text) {
	const matches = await search({ text });
	return matches.find((match) => match.label === text || match.node?.title === text || match.node?.value === text) ?? matches[0];
}

async function act(actions, expect) {
	const result = await tool(executeAct, { stateId, actions, expect, image: "auto" });
	stateId = result.details?.capture?.stateId;
	if (!stateId) throw new Error("Cubench action did not return a resulting desktop state");
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({
		actions,
		outcome: result.details?.execution?.outcome,
		steps: result.details?.execution?.steps?.map((step) => ({ grounding: step.performed?.grounding, delivery: step.performed?.delivery, policy: step.deliveryPolicy, escalated: step.escalatedToForeground })) ?? [],
		stateId,
		values: result.details?.changes?.flatMap((change) => change.type === "updated" && change.fields?.value !== undefined ? [{ ref: change.ref, value: change.fields.value }] : []) ?? [],
	}));
	return result;
}

async function rename(instruction) {
	const match = /^Rename (.*) to (.*)\.$/.exec(instruction);
	if (!match) throw new Error(`Could not parse rename instruction: ${instruction}`);
	const [, from, to] = match;
	let target = await exact(from);
	for (let attempt = 0; !target && attempt < 8; attempt += 1) {
		await act([{ action: "scroll", x: 450, y: 380, scrollY: 500 }]);
		target = await exact(from);
	}
	if (!target) throw new Error(`Could not find ${from}`);
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({ from, to, target: { ref: target.ref, label: target.label, role: target.role } }));
	await act([{ action: "click", ref: target.ref }]);

	const editorMatches = [
		...(await search({ role: "AXTextField" })),
		...(await search({ role: "AXTextArea" })),
	];
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({ editorMatches: editorMatches.map((item) => ({ ref: item.ref, label: item.label, role: item.role, canSetValue: item.node?.canSetValue })) }));
	const editor = editorMatches.find((item) => /new name/i.test(item.label) && item.node?.canSetValue)
		?? editorMatches.find((item) => item.node?.canSetValue && !/address|search bar/i.test(item.label))
		?? editorMatches.find((item) => !/address|search bar/i.test(item.label));
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({ editor: editor && { ref: editor.ref, label: editor.label, role: editor.role } }));
	if (editor) await act([{ action: "setText", ref: editor.ref, text: to }]);
	else await act([{ action: "keypress", keys: ["cmd", "a"] }, { action: "typeText", text: to }]);
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({ typedMatch: await exact(to) }));

	const renameButton = (await exact("Rename")) ?? (await exact("OK"));
	if (!renameButton) throw new Error("Could not find the rename button");
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({ renameButton: { ref: renameButton.ref, label: renameButton.label, role: renameButton.role } }));
	await act([{ action: "click", ref: renameButton.ref }]);
	if (process.env.CUBENCH_PI_DEBUG === "1") console.error(JSON.stringify({ afterRename: await request("GET", "/evaluate") }));
	const confirm = await exact("Confirm");
	if (confirm) await act([{ action: "click", ref: confirm.ref }], { text: to, timeoutMs: 5_000 });
}

async function toggle(instruction) {
	const match = /^Turn on (.*)\.$/.exec(instruction);
	if (!match) throw new Error(`Could not parse toggle instruction: ${instruction}`);
	const setting = await exact(match[1]);
	if (!setting) throw new Error(`Could not find setting ${match[1]}`);
	await act([{ action: "click", ref: setting.ref }]);
}
