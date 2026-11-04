#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const expected = [
	"package/prebuilt/macos/universal/pi-computer-use.app/Contents/MacOS/bridge",
	"package/prebuilt/windows/windows-bridge.exe",
	"package/prebuilt/linux/x64/linux-bridge",
	"package/prebuilt/linux/arm64/linux-bridge",
];

const suppliedTarball = process.argv[2];
const tarball = suppliedTarball ?? await createTarball();
try {
	const { stdout } = await execFileAsync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const files = new Set(stdout.split("\n").filter(Boolean));
	for (const file of expected) assert.ok(files.has(file), `npm package is missing ${file}`);
} finally {
	if (!suppliedTarball) await rm(tarball, { force: true });
}
console.log("package assets passed");

async function createTarball() {
	// npm is a .cmd shim on Windows; reuse the running npm CLI through node when available.
	const npmCli = process.env.npm_execpath;
	const [command, prefix] = npmCli ? [process.execPath, [npmCli]] : ["npm", []];
	const { stdout } = await execFileAsync(command, [...prefix, "pack", "--ignore-scripts", "--silent"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
	const filename = stdout.trim().split("\n").reverse().find((line) => line.endsWith(".tgz"));
	assert.ok(filename, "npm pack did not produce a tarball");
	return filename;
}
