#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "native", "macos", "bridge.swift");
const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
const archTriples = {
	arm64: "arm64-apple-macosx",
	x64: "x86_64-apple-macosx",
};
const helperVariants = {
	legacy: {
		deploymentTarget: "12.0",
		defines: [],
		frameworks: ["ApplicationServices", "AppKit", "Foundation"],
	},
	modern: {
		deploymentTarget: "14.0",
		defines: ["PI_COMPUTER_USE_SCREEN_CAPTURE_KIT"],
		frameworks: ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation"],
	},
};
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use.bridge";

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

function normalizeVariant(variant) {
	if (variant === "legacy" || variant === "modern" || variant === "all") return variant;
	throw new Error(`Unsupported helper variant '${variant}'. Supported: legacy, modern, all.`);
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

function defaultOutputPath(arch, variant) {
	return path.join(rootDir, "prebuilt", "macos", arch, variant, "bridge");
}

function moduleCachePath(arch, variant) {
	return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}-${variant}`);
}

function swiftArgsForArch(arch, variant, outputPath) {
	const config = helperVariants[variant];
	const args = [
		"swiftc",
		"-target",
		`${archTriples[arch]}${config.deploymentTarget}`,
		"-module-cache-path",
		moduleCachePath(arch, variant),
		"-O",
	];
	for (const define of config.defines) args.push("-D", define);
	for (const framework of config.frameworks) args.push("-framework", framework);
	args.push(sourcePath, "-o", outputPath);
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

async function buildForArch(arch, variant, outputPath) {
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	console.log(`Building ${variant} native helper for ${arch}...`);
	await run("xcrun", swiftArgsForArch(arch, variant, outputPath));
	await fs.chmod(outputPath, 0o755);
	await signBinary(outputPath);
	console.log(`Built ${variant} helper at ${outputPath}`);
}

async function buildUniversal(variant, outputPath) {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-build-"));
	const x64Output = path.join(tempDir, `bridge-x64-${variant}`);
	const arm64Output = path.join(tempDir, `bridge-arm64-${variant}`);
	await buildForArch("x64", variant, x64Output);
	await buildForArch("arm64", variant, arm64Output);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await run("lipo", ["-create", "-output", outputPath, x64Output, arm64Output]);
	await fs.chmod(outputPath, 0o755);
	await signBinary(outputPath);
	console.log(`Built universal ${variant} helper at ${outputPath}`);
	await fs.rm(tempDir, { recursive: true, force: true });
}

/**
 * Return the actual cargo binary path, handling platform suffix differences.
 * On Windows, the binary is named "windows-bridge.exe"; on other platforms it's "windows-bridge".
 */
function windowsBinaryPath(crateDir) {
	const releaseDir = path.join(crateDir, "target", "release");
	const exePath = path.join(releaseDir, "windows-bridge.exe");
	const binPath = path.join(releaseDir, "windows-bridge");
	// Return both candidates; callers should check existence (e.g., with exists()).
	// The .exe variant is preferred on Windows; the bare variant is used on non-Windows hosts
	// when cross-compiling the Windows helper binary.
	return { exePath, binPath };
}

async function buildWindowsHelper(prebuiltOutput) {
	const prebuiltDir = prebuiltOutput
		? path.resolve(process.cwd(), prebuiltOutput, "..")
		: path.join(rootDir, "prebuilt", "windows");
	const manifestPath = path.join(windowsCrateDir, "Cargo.toml");

	console.log("Building Windows helper with cargo...");
	await run("cargo", [
		"build",
		"--release",
		"--manifest-path",
		manifestPath,
	]);

	await fs.mkdir(prebuiltDir, { recursive: true });

	const { exePath, binPath } = windowsBinaryPath(windowsCrateDir);
	const cargoOutput = (await exists(exePath))
		? exePath
		: (await exists(binPath))
			? binPath
			: exePath;
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
	const variant = normalizeVariant(getArg("--variant") ?? "modern");
	const outputArg = getArg("--output");

	if (arch === "all" || variant === "all") {
		if (outputArg) {
			throw new Error("--output is not supported with --arch all or --variant all. Use a single arch/variant for one output.");
		}
		const archList = arch === "all" ? ["x64", "arm64"] : [arch];
		const variantList = variant === "all" ? ["legacy", "modern"] : [variant];
		for (const nextVariant of variantList) {
			for (const nextArch of archList) {
				await buildForArch(nextArch, nextVariant, defaultOutputPath(nextArch, nextVariant));
			}
		}
		return;
	}

	const outputPath = outputArg ? path.resolve(process.cwd(), outputArg) : defaultOutputPath(arch, variant);
	if (arch === "universal") {
		await buildUniversal(variant, outputPath);
		return;
	}

	await buildForArch(arch, variant, outputPath);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
