#!/usr/bin/env node
import assert from "node:assert/strict";

// Exercise the real wait/act consumers without starting a helper or sending input.
process.env.PI_COMPUTER_USE_HEADLESS = "1";
const { currentPlatformBackend: backend } = await import("../src/platform/index.ts");
const { parseLookResponse } = await import("../src/outline.ts");
const { executeFind, executeObserve, executeSearchUi, executeWaitFor, executeAct, shutdownComputerUseSession } = await import("../src/bridge.ts");
const original = { ...backend };
const root = { kind: "window", rootRef: "fixture-root", windowRef: "fixture-root", windowId: 101, pid: 7, appName: "Fixture", title: "Wait fixture", isFocused: true, isOnscreen: true, framePoints: { x: 0, y: 0, w: 400, h: 200 }, scaleFactor: 1 };
let removed = false;
let look = 0;
let providerError;
const requests = [];
Object.assign(backend, {
	ensureReady: async (_ctx, state) => ({ ...state, lastPermissionCheckAt: Date.now(), helperDiagnostics: { protocolVersion: 4, accessibility: true } }),
	listRoots: async () => [root],
	getFrontmost: async () => ({ ...root, windowTitle: root.title }),
	observe: async () => parseLookResponse({
		lookId: `look-${++look}`, capturedAt: Date.now() / 1000,
		window: { ...root, role: "window" }, timings: {},
		outline: { ref: "window", role: "window", title: "Wait fixture", children: removed ? [] : [
			{ ref: "working", role: "button", title: "Working", canPress: true, actions: ["press"], bounds: { x: 20, y: 20, width: 100, height: 40 } },
		] },
	}),
	actBatch: async () => {
		removed = true;
		const step = { outcome: "worked", rootDelta: [], performed: { grounding: "description", delivery: "ax" } };
		return { ...step, steps: [step] };
	},
	waitFor: async (request) => {
		requests.push(request);
		assert.equal(request.scopeExact, true);
		assert.equal(request.gone, true);
		assert.equal(request.scopeRef, "working");
		if (providerError) throw providerError;
		assert.equal(removed, true);
		// Native exact wait returns this only for confirmed provider removal.
		return { found: true, gone: true, nodeCount: 0 };
	},
	shutdown: async () => {},
});
const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => [] } };
let calls = 0;
const tool = (executor, params) => executor(`wait-expect-${++calls}`, params, undefined, undefined, ctx);
async function observedTarget() {
	removed = false;
	const windows = (await tool(executeFind, {})).details.windows;
	const observation = await tool(executeObserve, { root: windows[0].windowRef, mode: "semantic" });
	const stateId = observation.details.capture.stateId;
	const search = await tool(executeSearchUi, { stateId, text: "Working" });
	return { stateId, ref: search.details.matches[0].ref };
}
try {
	let target = await observedTarget();
	removed = true;
	const wait = await tool(executeWaitFor, { ...target, text: "Working", until: "absent", timeoutMs: 100 });
	assert.equal(wait.details.found, true);
	assert.equal(wait.details.gone, true);

	target = await observedTarget();
	const act = await tool(executeAct, { stateId: target.stateId, actions: [{ action: "press", ref: target.ref }], expect: { ref: target.ref, text: "Working", until: "absent", timeoutMs: 100 } });
	assert.equal(act.details.execution.verification.status, "verified");
	assert.equal(act.details.execution.outcome, "worked");
	assert.equal(requests.length, 2);

	target = await observedTarget();
	providerError = new Error("provider query failed: 0x80004005");
	const unknown = await tool(executeAct, { stateId: target.stateId, actions: [{ action: "press", ref: target.ref }], expect: { ref: target.ref, text: "Working", until: "absent", timeoutMs: 100 } });
	assert.notEqual(unknown.details.execution?.verification?.status, "verified");
	assert.equal(unknown.details.error.message, providerError.message);
	target = await observedTarget();
	removed = true;
	await assert.rejects(tool(executeWaitFor, { ...target, text: "Working", until: "absent", timeoutMs: 100 }), providerError);
	console.log("exact absent wait and act expect consumer checks passed; unknown provider failure preserved");
} finally {
	await shutdownComputerUseSession();
	Object.assign(backend, original);
}
