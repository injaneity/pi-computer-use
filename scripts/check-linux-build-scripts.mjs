#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptsDir, "..");
const [buildSource, setupSource, packageSource, helperSource] = await Promise.all([
	fs.readFile(path.join(scriptsDir, "build-native.mjs"), "utf8"),
	fs.readFile(path.join(scriptsDir, "setup-helper.mjs"), "utf8"),
	fs.readFile(path.join(rootDir, "package.json"), "utf8"),
	fs.readFile(path.join(rootDir, "src", "platform", "linux", "helper.ts"), "utf8"),
]);
const pkg = JSON.parse(packageSource);
assert.match(buildSource, /explicitPlatform === "linux"/);
assert.match(buildSource, /prebuilt", "linux", arch, "linux-bridge"/);
assert.match(buildSource, /x86_64-unknown-linux-gnu/);
assert.match(buildSource, /aarch64-unknown-linux-gnu/);
assert.match(setupSource, /PI_COMPUTER_USE_LINUX_HELPER_PATH/);
assert.match(setupSource, /prebuilt", "linux", arch, "linux-bridge"/);
assert.match(setupSource, /allowLinuxBuildFallback = args\.has\("--allow-build"\) \|\| process\.env\.PI_COMPUTER_USE_ALLOW_BUILD === "1"/);
assert.match(helperSource, /\.pi", "agent", "helpers", "pi-computer-use", "linux-bridge"/);
assert.ok(pkg.files.includes("native/linux/bridge-rs"));
assert.ok(pkg.files.includes("prebuilt/linux"));
assert.equal(pkg.scripts["build:linux"], "node scripts/build-native.mjs --platform linux");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-linux-scripts-"));
const helperDest = path.join(tempDir, "linux-bridge");
try {
	const result = await new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(scriptsDir, "setup-helper.mjs"), "--platform", "linux"], { env: { ...process.env, PI_COMPUTER_USE_LINUX_HELPER_PATH: helperDest }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
		child.on("close", (code) => resolve({ code, output }));
	});
	assert.equal(result.code, 1);
	assert.match(result.output, /No Linux prebuilt helper found for (x64|arm64)/);
	assert.equal(await fs.stat(helperDest).then(() => true, () => false), false);
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}
console.log("Linux build/setup script checks passed");
