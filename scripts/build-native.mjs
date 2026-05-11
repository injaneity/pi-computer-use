#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "native", "macos", "bridge.swift");
const archTargets = {
	arm64: "arm64-apple-macosx12.0",
	x64: "x86_64-apple-macosx12.0",
};
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use.bridge";

function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return undefined;
}

function hasArg(name) {
	return process.argv.includes(name);
}

function normalizeArch(arch) {
	if (arch === "universal" || arch === "all") return arch;
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64, universal, all.`);
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

function defaultOutputPath(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "bridge");
}

function moduleCachePath(arch) {
	return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}`);
}

function swiftArgsForArch(arch, outputPath) {
	return [
		"swiftc",
		"-target",
		archTargets[arch],
		"-module-cache-path",
		moduleCachePath(arch),
		"-O",
		"-framework",
		"ApplicationServices",
		"-framework",
		"AppKit",
		"-framework",
		"Foundation",
		sourcePath,
		"-o",
		outputPath,
	];
}

async function signBinary(outputPath) {
	if (hasArg("--no-sign") || process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return;
	}

	const identity = getArg("--sign-identity") ?? process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY ?? "-";
	const identifier = getArg("--sign-identifier") ?? process.env.PI_COMPUTER_USE_CODESIGN_IDENTIFIER ?? defaultCodeSignIdentifier;
	const args = ["--force", "-i", identifier];
	if (hasArg("--hardened-runtime")) {
		args.push("--options", "runtime");
	}
	if (hasArg("--timestamp")) {
		args.push("--timestamp");
	} else {
		args.push("--timestamp=none");
	}
	args.push("--sign", identity, outputPath);
	await run("codesign", args);
}

async function buildForArch(arch, outputPath) {
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	console.log(`Building native helper for ${arch}...`);
	await run("xcrun", swiftArgsForArch(arch, outputPath));
	await fs.chmod(outputPath, 0o755);
	await signBinary(outputPath);
	console.log(`Built helper at ${outputPath}`);
}

async function buildUniversal(outputPath) {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-build-"));
	const x64Output = path.join(tempDir, "bridge-x64");
	const arm64Output = path.join(tempDir, "bridge-arm64");
	await buildForArch("x64", x64Output);
	await buildForArch("arm64", arm64Output);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await run("lipo", ["-create", "-output", outputPath, x64Output, arm64Output]);
	await fs.chmod(outputPath, 0o755);
	await signBinary(outputPath);
	console.log(`Built universal helper at ${outputPath}`);
	await fs.rm(tempDir, { recursive: true, force: true });
}

async function main() {
	if (process.platform !== "darwin") {
		throw new Error("build-native is only supported on macOS.");
	}

	const arch = normalizeArch(getArg("--arch") ?? process.arch);
	const outputArg = getArg("--output");

	if (arch === "all") {
		if (outputArg) {
			throw new Error("--output is not supported with --arch all. Use --arch arm64/x64/universal for a single output.");
		}
		await buildForArch("x64", defaultOutputPath("x64"));
		await buildForArch("arm64", defaultOutputPath("arm64"));
		return;
	}

	const outputPath = outputArg ? path.resolve(process.cwd(), outputArg) : defaultOutputPath(arch);
	if (arch === "universal") {
		await buildUniversal(outputPath);
		return;
	}

	await buildForArch(arch, outputPath);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
