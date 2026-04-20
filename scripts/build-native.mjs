#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "native", "macos", "bridge.swift");

function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return undefined;
}

function normalizeArch(arch) {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
}

async function run(command, args) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
		});
	});
}

async function main() {
	if (process.platform !== "darwin") {
		throw new Error("build-native is only supported on macOS.");
	}

	const arch = normalizeArch(getArg("--arch") ?? process.arch);
	const outputArg = getArg("--output");
	const outputPath = outputArg
		? path.resolve(process.cwd(), outputArg)
		: path.join(rootDir, "prebuilt", "macos", arch, "bridge");

	await fs.mkdir(path.dirname(outputPath), { recursive: true });

	const swiftArgs = [
		"swiftc",
		"-O",
		"-framework",
		"ApplicationServices",
		"-framework",
		"AppKit",
		"-framework",
		"ScreenCaptureKit",
		"-framework",
		"Foundation",
		sourcePath,
		"-o",
		outputPath,
	];

	console.log(`Building native helper for ${arch}...`);
	await run("xcrun", swiftArgs);
	await fs.chmod(outputPath, 0o755);
	console.log(`Built helper at ${outputPath}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
