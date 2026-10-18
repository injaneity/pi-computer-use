#!/usr/bin/env node
import assert from "node:assert/strict";

const { macosHelper } = await import("../src/platform/macos/helper.ts");
const { macosBackend, normalizeTarget } = await import("../src/platform/macos/backend.ts");
const { nativeWindowRequest } = await import("../src/bridge.ts");

const calls = [];
macosHelper.command = async (name, args) => {
	calls.push({ name, args });
	if (name === "look") throw new Error("stop after capture of payload");
	return { focused: true, found: true };
};

async function lastLookArgs(target) {
	calls.length = 0;
	await macosBackend.observe({ target, readText: "auto", includeImage: false }).catch(() => undefined);
	return calls.find((call) => call.name === "look")?.args;
}

const unpaired = nativeWindowRequest({ pid: 7, windowId: 0, nativeWindowRef: "ax:dlg" });
assert.deepEqual(unpaired, { pid: 7, rootRef: "ax:dlg", windowRef: "ax:dlg" });
let args = await lastLookArgs(unpaired);
assert.equal(args.windowRef, "ax:dlg");
assert.equal("windowId" in args, false, "windowId 0 must not be sent");

args = await lastLookArgs(nativeWindowRequest({ pid: 7, windowId: 42, nativeWindowRef: "ax:main" }));
assert.equal(args.windowId, 42);
assert.equal(args.windowRef, "ax:main");

args = await lastLookArgs({ pid: 7, rootRef: "ax:legacy" });
assert.equal(args.windowRef, "ax:legacy");

const idOnly = nativeWindowRequest({ pid: 7, windowId: 9, nativeWindowRef: undefined });
assert.deepEqual(idOnly, { pid: 7, windowId: 9 });

assert.deepEqual(normalizeTarget({ pid: 1, windowId: -3 }), { pid: 1 });
assert.deepEqual(normalizeTarget({ pid: 1, windowId: Number.NaN }), { pid: 1 });

calls.length = 0;
await macosBackend.waitFor({ ...unpaired, gone: false, timeoutMs: 100, text: "x" });
await macosBackend.focusWindow(unpaired);
for (const name of ["axWaitFor", "focusWindow"]) {
	const sent = calls.find((call) => call.name === name).args;
	assert.equal(sent.windowRef, "ax:dlg", `${name} windowRef`);
	assert.equal("windowId" in sent, false, `${name} windowId`);
	assert.equal("rootRef" in sent, false, `${name} rootRef`);
}

console.log("macos observe target checks passed");
