#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { helperSourcePaths } from "./setup-helper.mjs";

const execFileAsync = promisify(execFile);
const expected = [
	"package/prebuilt/macos/universal/pi-computer-use.app/Contents/MacOS/bridge",
	"package/prebuilt/windows/windows-bridge.exe",
	"package/prebuilt/linux/x64/linux-bridge",
	"package/prebuilt/linux/arm64/linux-bridge",
	// The macOS source-build fallback compiles these when no prebuilt helper is available.
	...helperSourcePaths.map((file) => `package/native/macos/${path.basename(file)}`),
];

const suppliedTarball = process.argv[2];
const tarball = suppliedTarball ?? await createTarball();
try {
	const { stdout } = await execFileAsync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const files = new Set(stdout.split("\n").filter(Boolean));
	const missing = expected.filter((file) => !files.has(file));
	assert.deepEqual(missing, [], `npm package is missing ${missing.join(", ")}`);
} finally {
	if (!suppliedTarball) await rm(tarball, { force: true });
}
console.log("package assets passed");

async function createTarball() {
	const { stdout } = await execFileAsync("npm", ["pack", "--ignore-scripts", "--silent"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
	const filename = stdout.trim().split("\n").reverse().find((line) => line.endsWith(".tgz"));
	assert.ok(filename, "npm pack did not produce a tarball");
	return filename;
}
