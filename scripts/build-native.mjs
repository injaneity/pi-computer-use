#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const macosSourcePaths = [
	"agent_cursor.swift",
	"agent_cursor_motion.swift",
	"bridge.swift",
].map((file) => path.join(rootDir, "native", "macos", file));
const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
const archTriples = {
	arm64: "arm64-apple-macosx",
	x64: "x86_64-apple-macosx",
};
const deploymentTarget = "14.0";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

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
	const args = [
		"swiftc",
		"-target",
		`${archTriples[arch]}${deploymentTarget}`,
		"-module-cache-path",
		moduleCachePath(arch),
		"-O",
	];
	for (const framework of frameworks) args.push("-framework", framework);
	args.push(...macosSourcePaths, "-o", outputPath);
	return args;
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

/**
 * Return the actual cargo binary path, handling platform suffix differences.
 * On Windows, the binary is named "windows-bridge.exe"; on other platforms it's "windows-bridge".
 */
function windowsBinaryPath(crateDir, target) {
	const releaseDir = target
		? path.join(crateDir, "target", target, "release")
		: path.join(crateDir, "target", "release");
	return path.join(releaseDir, "windows-bridge.exe");
}

async function buildWindowsHelper(prebuiltOutput) {
	const target = getArg("--target");
	if (process.platform !== "win32" && !target?.includes("windows")) {
		throw new Error("Refusing to label a host binary as Windows. Build on Windows or pass an explicit Windows --target triple.");
	}
	const prebuiltDir = prebuiltOutput
		? path.resolve(process.cwd(), prebuiltOutput, "..")
		: path.join(rootDir, "prebuilt", "windows");
	const manifestPath = path.join(windowsCrateDir, "Cargo.toml");

	console.log("Building Windows helper with cargo...");
	const cargoArgs = [
		"build",
		"--release",
		"--manifest-path",
		manifestPath,
	];
	if (target) cargoArgs.push("--target", target);
	await run("cargo", cargoArgs);

	await fs.mkdir(prebuiltDir, { recursive: true });

	const cargoOutput = windowsBinaryPath(windowsCrateDir, target);
	const handle = await fs.open(cargoOutput, "r");
	try {
		const signature = Buffer.alloc(2);
		await handle.read(signature, 0, 2, 0);
		if (signature.toString("ascii") !== "MZ") {
			throw new Error(`Cargo output is not a Windows PE executable: ${cargoOutput}`);
		}
	} finally {
		await handle.close();
	}
	const prebuiltDest = path.join(prebuiltDir, "windows-bridge.exe");
	await fs.copyFile(cargoOutput, prebuiltDest);
	await fs.chmod(prebuiltDest, 0o755);
	console.log(`Built Windows helper at ${prebuiltDest}`);
}

async function main() {
	const explicitPlatform = getArg("--platform");

	if (explicitPlatform === "windows") {
		await buildWindowsHelper(getArg("--output"));
		return;
	}

	if (explicitPlatform === "darwin") {
		// Fall through to macOS build logic below.
	} else if (process.platform === "win32") {
		await buildWindowsHelper(getArg("--output"));
		return;
	} else if (process.platform !== "darwin") {
		console.log(
			`Skipping native build: unsupported platform "${process.platform}". ` +
				"Use --platform windows to build the Windows helper, or run on macOS for the macOS helper.",
		);
		return;
	}

	const arch = normalizeArch(getArg("--arch") ?? process.arch);
	const outputArg = getArg("--output");

	if (arch === "all") {
		if (outputArg) {
			throw new Error("--output is not supported with --arch all. Use a single architecture for one output.");
		}
		for (const nextArch of ["x64", "arm64"]) {
			await buildForArch(nextArch, defaultOutputPath(nextArch));
		}
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
