#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const expected = [
	"prebuilt/macos/universal/pi-computer-use.app/Contents/MacOS/bridge",
	"prebuilt/windows/windows-bridge.exe",
	"prebuilt/linux/x64/linux-bridge",
	"prebuilt/linux/arm64/linux-bridge",
];

const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const result = JSON.parse(stdout);
const files = new Set(result[0]?.files?.map((file) => file.path) ?? []);

for (const file of expected) assert.ok(files.has(file), `npm package is missing ${file}`);
console.log("package assets passed");
