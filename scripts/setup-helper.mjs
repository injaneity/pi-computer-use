#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
const helperDestPath = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "bridge");
const windowsHelperDestPath = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");
const helperSourcePath = path.join(rootDir, "native", "macos", "bridge.swift");

const args = new Set(process.argv.slice(2));
const isPostinstall = args.has("--postinstall");
const forceInstall = args.has("--force") || process.env.PI_COMPUTER_USE_FORCE_HELPER_INSTALL === "1";
const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";

function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return undefined;
}
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

function normalizeArch(arch) {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
}

function normalizeVariant(variant) {
	if (variant === "legacy" || variant === "modern") return variant;
	throw new Error(`Unsupported helper variant '${variant}'. Supported: legacy, modern, auto.`);
}

function darwinMajorVersion() {
	const major = Number.parseInt(os.release().split(".")[0] ?? "", 10);
	return Number.isFinite(major) ? major : 0;
}

function selectedHelperVariant() {
	const override = process.env.PI_COMPUTER_USE_HELPER_VARIANT ?? process.env.PI_COMPUTER_USE_CAPTURE_BACKEND ?? "auto";
	if (override !== "auto") return normalizeVariant(override);
	return darwinMajorVersion() >= 23 ? "modern" : "legacy";
}

function prebuiltPathForArch(arch, variant) {
	return path.join(rootDir, "prebuilt", "macos", arch, variant, "bridge");
}

async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath) {
	try {
		await fs.access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function hashFile(filePath) {
	const data = await fs.readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

async function copyIfChanged(sourcePath, destinationPath) {
	const destinationExists = await exists(destinationPath);
	if (destinationExists) {
		const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
		if (sourceHash === destinationHash) {
			await fs.chmod(destinationPath, 0o755);
			return { changed: false };
		}
	}

	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
	await fs.copyFile(sourcePath, tempPath);
	await fs.chmod(tempPath, 0o755);
	try {
		await fs.rename(tempPath, destinationPath);
	} catch (err) {
		// Clean up the temp file on failure.
		await fs.rm(tempPath, { force: true }).catch(() => {});
		// If the destination is locked (EPERM on Windows), surface a clear error.
		if (err.code === "EPERM") {
			throw new Error(
				`Cannot update helper at ${destinationPath} — the existing helper process is still running. ` +
					`Close the helper process and re-run this script.`,
			);
		}
		throw err;
	}
	return { changed: true };
}

async function run(command, commandArgs) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${commandArgs.join(" ")}`));
		});
	});
}

function moduleCachePath(arch, variant) {
	return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}-${variant}`);
}

async function signHelper(outputPath) {
	if (process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return;
	}

	const identity = process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY ?? "-";
	const identifier = process.env.PI_COMPUTER_USE_CODESIGN_IDENTIFIER ?? defaultCodeSignIdentifier;
	const commandArgs = ["--force", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
	await run("codesign", commandArgs);
}

async function buildHelper(arch, variant, outputPath) {
	if (!(await exists(helperSourcePath))) {
		throw new Error(`Native helper source not found at ${helperSourcePath}`);
	}

	const config = helperVariants[variant];
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const swiftArgs = [
		"swiftc",
		"-target",
		`${archTriples[arch]}${config.deploymentTarget}`,
		"-module-cache-path",
		moduleCachePath(arch, variant),
		"-O",
	];
	for (const define of config.defines) swiftArgs.push("-D", define);
	for (const framework of config.frameworks) swiftArgs.push("-framework", framework);
	swiftArgs.push(helperSourcePath, "-o", outputPath);

	await run("xcrun", swiftArgs);
	await fs.chmod(outputPath, 0o755);
	await signHelper(outputPath);
}

/**
 * Return the cargo binary path candidates, handling platform suffix differences.
 * On Windows, the binary is named "windows-bridge.exe"; on other platforms it's "windows-bridge".
 */
function windowsBinaryPath() {
	const releaseDir = path.join(windowsCrateDir, "target", "release");
	return {
		exePath: path.join(releaseDir, "windows-bridge.exe"),
		binPath: path.join(releaseDir, "windows-bridge"),
	};
}

async function setupWindowsHelper() {
	const prebuiltPath = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");
	const prebuiltExists = await exists(prebuiltPath);

	if (prebuiltExists) {
		const { changed } = await copyIfChanged(prebuiltPath, windowsHelperDestPath);
		console.log(
			changed
				? `[pi-computer-use] installed Windows helper from prebuilt to ${windowsHelperDestPath}`
				: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`,
		);
		return;
	}

	if (allowBuildFallback) {
		console.log("[pi-computer-use] Windows prebuilt helper missing; attempting source build with cargo...");
		const manifestPath = path.join(windowsCrateDir, "Cargo.toml");
		await run("cargo", ["build", "--release", "--manifest-path", manifestPath]);

		const { exePath, binPath } = windowsBinaryPath();
		const cargoOutput = (await exists(exePath))
			? exePath
			: (await exists(binPath))
				? binPath
				: exePath;

		await fs.mkdir(path.dirname(windowsHelperDestPath), { recursive: true });
		const { changed } = await copyIfChanged(cargoOutput, windowsHelperDestPath);
		console.log(
			changed
				? `[pi-computer-use] built and installed Windows helper at ${windowsHelperDestPath}`
				: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`,
		);
		return;
	}

	throw new Error(
		`No Windows prebuilt helper found at ${prebuiltPath}. ` +
			"Run 'node scripts/build-native.mjs --platform windows' to build, or set PI_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.",
	);
}

async function setup() {
	const explicitPlatform = getArg("--platform");

	if (explicitPlatform === "windows" || (!explicitPlatform && process.platform === "win32")) {
		await setupWindowsHelper();
		return;
	}

	if (process.platform !== "darwin") {
		if (isPostinstall) {
			console.warn("[pi-computer-use] skipping helper setup: platform is not macOS.");
			return;
		}
		throw new Error("pi-computer-use helper is only supported on macOS. Use --platform windows on Windows.");
	}

	const arch = normalizeArch(process.arch);
	const variant = selectedHelperVariant();
	const prebuiltPath = prebuiltPathForArch(arch, variant);
	const prebuiltExists = await exists(prebuiltPath);

	if (!forceInstall && (await isExecutable(helperDestPath))) {
		if (variant === "modern") {
			console.log(`[pi-computer-use] using existing helper at ${helperDestPath}`);
			return;
		}
		if (prebuiltExists) {
			const { changed } = await copyIfChanged(prebuiltPath, helperDestPath);
			console.log(
				changed
					? `[pi-computer-use] installed ${variant} helper from prebuilt (${arch}) to ${helperDestPath}`
					: `[pi-computer-use] ${variant} helper already up to date at ${helperDestPath}`,
			);
			return;
		}
		if (!allowBuildFallback) {
			console.log(`[pi-computer-use] using existing helper at ${helperDestPath}`);
			return;
		}
	}

	if (prebuiltExists) {
		const { changed } = await copyIfChanged(prebuiltPath, helperDestPath);
		console.log(
			changed
				? `[pi-computer-use] installed ${variant} helper from prebuilt (${arch}) to ${helperDestPath}`
				: `[pi-computer-use] ${variant} helper already up to date at ${helperDestPath}`,
		);
		return;
	}

	if (allowBuildFallback) {
		console.log(`[pi-computer-use] ${variant} prebuilt helper missing; attempting source build with xcrun swiftc...`);
		await buildHelper(arch, variant, helperDestPath);
		console.log(`[pi-computer-use] built ${variant} helper at ${helperDestPath}`);
		return;
	}

	throw new Error(
		`No ${variant} prebuilt helper found for ${arch} at ${prebuiltPath}. Run 'node scripts/build-native.mjs --variant ${variant} --output ${helperDestPath}' to build locally.`,
	);
}

setup().catch((error) => {
	if (isPostinstall) {
		console.warn(`[pi-computer-use] postinstall helper setup skipped: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(0);
	}

	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
