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

const { stdout } = await execFileAsync("npm", ["pack", "--ignore-scripts", "--loglevel", "silent"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const tarball = stdout.trim().split("\n").reverse().find((line) => line.endsWith(".tgz"));
assert.ok(tarball, "npm pack did not produce a tarball");
try {
	const { stdout: listing } = await execFileAsync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const files = new Set(listing.split("\n").filter(Boolean));
	for (const file of expected) assert.ok(files.has(file), `npm package is missing ${file}`);
} finally {
	await rm(tarball, { force: true });
}
console.log("package assets passed");
