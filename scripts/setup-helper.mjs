#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyHelperRoot = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use");
const legacyHelperPath = path.join(legacyHelperRoot, "bridge");
const legacyHelperAppPath = path.join(legacyHelperRoot, "PiComputerUseBridge.app");
const legacyUserHelperAppPath = path.join(os.homedir(), "Applications", "PiComputerUseBridge.app");
const legacySystemHelperAppPath = "/Applications/PiComputerUseBridge.app";
const helperAppPath = "/Applications/pi-computer-use.app";
const helperAppExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
const helperBundleId = "com.injaneity.pi-computer-use";
const helperSourcePath = path.join(rootDir, "native", "macos", "bridge.swift");

const args = new Set(process.argv.slice(2));
const isPostinstall = args.has("--postinstall");
const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
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
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

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

async function signHelper(outputPath, identifier = defaultCodeSignIdentifier) {
	if (process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return;
	}

	const identity = process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY ?? "-";
	const commandArgs = ["--force", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
	await run("codesign", commandArgs);
}

async function registerHelperApp() {
	const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (!(await exists(lsregister))) return;
	await run(lsregister, ["-f", helperAppPath]).catch(() => {});
}

async function installHelperApp(sourcePath) {
	await fs.access(path.dirname(helperAppPath), fsConstants.W_OK);
	await fs.mkdir(path.dirname(helperAppExecutablePath), { recursive: true });
	await fs.copyFile(sourcePath, helperAppExecutablePath);
	await fs.chmod(helperAppExecutablePath, 0o755);
	await fs.writeFile(path.join(helperAppPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${helperBundleId}</string>
<key>CFBundleName</key><string>pi-computer-use</string>
<key>CFBundleDisplayName</key><string>pi-computer-use</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.3.3</string>
<key>CFBundleVersion</key><string>0.3.3</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
	await signHelper(helperAppPath, helperBundleId);
	await registerHelperApp();
}

async function removeLegacyHelpers() {
	const removed = [];
	for (const legacyPath of [legacyHelperPath, legacyHelperAppPath, legacyUserHelperAppPath, legacySystemHelperAppPath]) {
		if (!(await exists(legacyPath))) continue;
		await fs.rm(legacyPath, { force: true, recursive: true });
		removed.push(legacyPath);
	}
	return removed;
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

async function setup() {
	if (process.platform !== "darwin") {
		if (isPostinstall) {
			console.warn("[pi-computer-use] skipping helper setup: platform is not macOS.");
			return;
		}
		throw new Error("pi-computer-use helper is only supported on macOS.");
	}

	const arch = normalizeArch(process.arch);
	const variant = selectedHelperVariant();
	const prebuiltPath = prebuiltPathForArch(arch, variant);
	const prebuiltExists = await exists(prebuiltPath);

	if (prebuiltExists) {
		await installHelperApp(prebuiltPath);
		const removedLegacy = await removeLegacyHelpers();
		console.log(`[pi-computer-use] installed ${variant} helper app (${arch}) at ${helperAppPath}`);
		for (const removedPath of removedLegacy) console.log(`[pi-computer-use] removed legacy helper at ${removedPath}`);
		return;
	}

	if (allowBuildFallback) {
		const tempPath = path.join(os.tmpdir(), `pi-computer-use-bridge-${process.pid}-${Date.now()}`);
		try {
			console.log(`[pi-computer-use] ${variant} prebuilt helper missing; attempting source build with xcrun swiftc...`);
			await buildHelper(arch, variant, tempPath);
			await installHelperApp(tempPath);
			const removedLegacy = await removeLegacyHelpers();
			console.log(`[pi-computer-use] built ${variant} helper app at ${helperAppPath}`);
			for (const removedPath of removedLegacy) console.log(`[pi-computer-use] removed legacy helper at ${removedPath}`);
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => {});
		}
		return;
	}

	throw new Error(
		`No ${variant} prebuilt helper found for ${arch} at ${prebuiltPath}. Run 'npm run build:native' to build locally.`,
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
