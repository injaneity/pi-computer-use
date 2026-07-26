#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-linux-platform-"));
const fakeHelper = path.join(tempDir, "linux-bridge");
await fs.writeFile(fakeHelper, `#!/usr/bin/env node
const readline = require("node:readline");
const invariants = ["state-scoped-observations","bounded-observation-history","multi-root-forest","progressive-disclosure","atomic-physical-input","concurrent-requests","transactional-batching"];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line); let result;
  if (request.cmd === "diagnostics") result = { protocolVersion: 4, architectureVersion: 1, invariants, pid: process.pid, accessibility: true };
  else if (request.cmd === "listRoots") result = { roots: [{ kind: "window", rootRef: "root:1", pid: 42, appName: "google-chrome-stable", title: "Linux fixture", framePoints: { x: 10, y: 20, w: 800, h: 600 }, isFocused: true }] };
  else if (request.cmd === "atspiReadText") result = { text: "fixture", offset: 0, limit: 7, totalChars: 7, hasMore: false };
  else if (request.cmd === "atspiWaitFor") result = { found: true };
  else if (request.cmd === "act") result = { outcome: "worked", performed: { delivery: "ax" } };
  else if (request.cmd === "actBatch") result = { outcome: "worked", performed: { transaction: true, actionCount: request.args.actions.length } };
  else if (request.cmd === "openBrowserLocation") result = { opened: true };
  else result = { focused: true };
  process.stdout.write(JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result }) + "\\n");
});
`);
await fs.chmod(fakeHelper, 0o755);
process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH = fakeHelper;

try {
	const [{ platformBackendForRuntime }, { LinuxHelperClient, linuxHelper }] = await Promise.all([
		import("../src/platform/index.ts"), import("../src/platform/linux/helper.ts"),
	]);
	linuxHelper.installChecked = true;
	const linux = platformBackendForRuntime("linux");
	assert.equal(linux.name, "linux");
	for (const method of ["ensureReady", "listApps", "listRoots", "getFrontmost", "focusWindow", "observe", "act", "actBatch", "readText", "waitFor", "openBrowserLocation"]) assert.equal(typeof linux[method], "function", method);
	assert.equal(linux.isBrowserApp("firefox-esr"), true);
	assert.equal(linux.isChromeFamilyApp("google-chrome-stable.desktop"), true);
	assert.equal(linux.isBrowserApp("gnome-text-editor"), false);

	const ready = await linux.ensureReady({}, { lastPermissionCheckAt: 0 });
	assert.equal(ready.helperDiagnostics?.protocolVersion, 4);
	assert.equal((await linux.listApps())[0]?.appName, "google-chrome-stable");
	assert.equal((await linux.listRoots({ title: "fixture" }))[0]?.rootRef, "root:1");
	assert.equal((await linux.getFrontmost()).pid, 42);
	assert.equal((await linux.readText({ lookId: "look:1", elementRef: "e:1", offset: 0, limit: 7 })).text, "fixture");
	assert.equal((await linux.waitFor({ gone: false, timeoutMs: 100, text: "fixture" })).found, true);
	assert.equal((await linux.act({ lookId: "look:1", target: { ref: "e:1" }, action: "press", params: {}, policy: "background" })).outcome, "worked");
	assert.equal((await linux.actBatch([])).performed?.transaction, true);
	assert.equal(await linux.openBrowserLocation({ appName: "firefox" }, "https://example.com"), true);
	await linux.shutdown?.();

	const concurrentHelper = path.join(tempDir, "concurrent-linux-bridge");
	const installer = path.join(tempDir, "install-concurrent-helper.cjs");
	const installCount = path.join(tempDir, "install-count.txt");
	const startCount = path.join(tempDir, "start-count.txt");
	await fs.writeFile(concurrentHelper, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(process.env.PI_TEST_LINUX_START_COUNT, "start\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result: request.args }) + "\\n");
});
`);
	await fs.chmod(concurrentHelper, 0o644);
	await fs.writeFile(installer, `
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_TEST_LINUX_INSTALL_COUNT, "install\\n");
setTimeout(() => fs.chmodSync(process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH, 0o755), 100);
`);
	process.env.PI_TEST_LINUX_INSTALL_COUNT = installCount;
	process.env.PI_TEST_LINUX_START_COUNT = startCount;
	const concurrentClient = new LinuxHelperClient({ helperPath: concurrentHelper, setupHelperScript: installer });
	const results = await Promise.all(Array.from({ length: 24 }, (_, index) => concurrentClient.command("echo", { index })));
	assert.deepEqual(results.map((result) => result.index), Array.from({ length: 24 }, (_, index) => index));
	assert.equal((await fs.readFile(installCount, "utf8")).trim().split("\n").length, 1, "concurrent commands share one helper installation");
	assert.equal((await fs.readFile(startCount, "utf8")).trim().split("\n").length, 1, "concurrent commands share one helper process");
	concurrentClient.dispose();
	delete process.env.PI_TEST_LINUX_INSTALL_COUNT;
	delete process.env.PI_TEST_LINUX_START_COUNT;
	console.log("Linux platform checks passed");
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}
