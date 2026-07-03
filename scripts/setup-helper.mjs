#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperAppPath = "/Applications/pi-computer-use.app";
const helperAppExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
const helperSourceHashPath = path.join(helperAppPath, "Contents", "Resources", "source.sha256");
const helperBundleId = "com.injaneity.pi-computer-use";
const helperSourcePath = path.join(rootDir, "native", "macos", "bridge.swift");

const args = new Set(process.argv.slice(2));
const isPostinstall = args.has("--postinstall");
const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const allowAdhocUpdate = args.has("--allow-adhoc-update") || process.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === "1";
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

function prebuiltAppPathForArch(arch, variant) {
	return path.join(rootDir, "prebuilt", "macos", arch, variant, "pi-computer-use.app");
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

async function commandOutput(command, commandArgs) {
	const { stdout } = await execFile(command, commandArgs, { encoding: "utf8" });
	return stdout;
}

async function findDeveloperIdIdentity() {
	const output = await commandOutput("security", ["find-identity", "-p", "codesigning", "-v"]).catch(() => "");
	const line = output.split("\n").find((item) => item.includes("Developer ID Application"));
	return line?.trim().split(/\s+/)[1];
}

async function resolveCodeSignIdentity() {
	if (process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY) return process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY;
	return (await findDeveloperIdIdentity()) ?? "-";
}

async function signHelper(outputPath, identifier = defaultCodeSignIdentifier) {
	if (process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return;
	}

	const identity = await resolveCodeSignIdentity();
	const commandArgs = ["--force", "--deep", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
	await run("codesign", commandArgs);
	if (identity === "-") {
		console.warn("[pi-computer-use] warning: signed helper ad-hoc; dev permission grants may need review after native helper changes. Release installs should use a pre-signed helper app.");
	}
}

async function helperHasAdhocSignature() {
	const output = await execFile("codesign", ["-dv", "--verbose=4", helperAppPath], { encoding: "utf8" }).then(
		(result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		(error) => `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
	);
	return /Signature=adhoc/i.test(output);
}

async function registerHelperApp() {
	const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (!(await exists(lsregister))) return;
	await run(lsregister, ["-f", helperAppPath]).catch(() => {});
}

async function installPrebuiltHelperApp(sourceAppPath) {
	await fs.access(path.dirname(helperAppPath), fsConstants.W_OK);
	const sourceExecutablePath = path.join(sourceAppPath, "Contents", "MacOS", "bridge");
	const sourceInfoPath = path.join(sourceAppPath, "Contents", "Info.plist");
	const existingExecutable = await fs.readFile(helperAppExecutablePath).catch(() => undefined);
	const sourceExecutable = await fs.readFile(sourceExecutablePath);
	const existingInfo = await fs.readFile(path.join(helperAppPath, "Contents", "Info.plist"), "utf8").catch(() => undefined);
	const sourceInfo = await fs.readFile(sourceInfoPath, "utf8");
	if (existingExecutable?.equals(sourceExecutable) && existingInfo === sourceInfo) {
		await registerHelperApp();
		return false;
	}
	// The sealed bundle must arrive intact — a broken signature would burn
	// the user's TCC grants on an identity that can never validate.
	await run("codesign", ["--verify", "--strict", sourceAppPath]);
	await fs.rm(helperAppPath, { force: true, recursive: true });
	// ditto preserves the bundle byte-for-byte (signature + stapled
	// notarization ticket). The sealed app is NEVER re-signed here: its
	// Developer ID designated requirement (identifier + team) is exactly
	// what lets TCC grant rows survive future updates.
	await run("/usr/bin/ditto", [sourceAppPath, helperAppPath]);
	await registerHelperApp();
	return true;
}

async function installHelperApp(sourcePath) {
	await fs.access(path.dirname(helperAppPath), fsConstants.W_OK);
	const infoPlistPath = path.join(helperAppPath, "Contents", "Info.plist");
	const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
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
</dict></plist>\n`;

	const sourceExecutable = await fs.readFile(sourcePath);
	const sourceHash = createHash("sha256").update(sourceExecutable).digest("hex");
	const existingSourceHash = await fs.readFile(helperSourceHashPath, "utf8").catch(() => undefined);
	const existingInfoPlist = await fs.readFile(infoPlistPath, "utf8").catch(() => undefined);
	if (existingSourceHash?.trim() === sourceHash && existingInfoPlist === infoPlist) {
		// If a real signing identity is available, upgrade older ad-hoc installs
		// in place so TCC grants survive future native rebuilds.
		const signingIdentity = process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
		if (signingIdentity !== "-" && await helperHasAdhocSignature()) {
			await signHelper(helperAppPath, helperBundleId);
			await registerHelperApp();
			return true;
		}
		await registerHelperApp();
		return false;
	}

	const signingIdentity = process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
	if (signingIdentity === "-" && existingSourceHash !== undefined && !allowAdhocUpdate) {
		throw new Error("Refusing to replace an installed helper with an ad-hoc signed rebuild because macOS may reset Accessibility/Screen Recording grants. Use a pre-signed helper app, install a Developer ID identity, or set PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 for local development.");
	}

	await fs.mkdir(path.dirname(helperAppExecutablePath), { recursive: true });
	await fs.mkdir(path.dirname(helperSourceHashPath), { recursive: true });
	await fs.copyFile(sourcePath, helperAppExecutablePath);
	await fs.chmod(helperAppExecutablePath, 0o755);
	await fs.writeFile(infoPlistPath, infoPlist);
	await fs.writeFile(helperSourceHashPath, `${sourceHash}\n`);
	await signHelper(helperAppPath, helperBundleId);
	await registerHelperApp();
	return true;
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
	// Prefer the release-signed universal bundle (one artifact for both
	// arches, produced by .github/workflows/release-helper.yml) over
	// per-arch bundles, over loose binaries (dev fallback).
	const universalAppPath = prebuiltAppPathForArch("universal", variant);
	const prebuiltAppPath = (await exists(universalAppPath))
		? universalAppPath
		: prebuiltAppPathForArch(arch, variant);
	const prebuiltPath = prebuiltPathForArch(arch, variant);
	const prebuiltAppExists = await exists(prebuiltAppPath);
	const prebuiltExists = await exists(prebuiltPath);

	if (prebuiltAppExists) {
		const installed = await installPrebuiltHelperApp(prebuiltAppPath);
		console.log(
			installed
				? `[pi-computer-use] installed pre-signed ${variant} helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] pre-signed helper app (${variant}, ${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	if (prebuiltExists) {
		const installed = await installHelperApp(prebuiltPath);
		console.log(
			installed
				? `[pi-computer-use] installed ${variant} helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] helper app (${variant}, ${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	if (allowBuildFallback) {
		const tempPath = path.join(os.tmpdir(), `pi-computer-use-bridge-${process.pid}-${Date.now()}`);
		try {
			console.log(`[pi-computer-use] ${variant} prebuilt helper missing; attempting source build with xcrun swiftc...`);
			await buildHelper(arch, variant, tempPath);
			const installed = await installHelperApp(tempPath);
			console.log(
				installed
					? `[pi-computer-use] built ${variant} helper app at ${helperAppPath}`
					: `[pi-computer-use] built ${variant} helper app; installed app already current at ${helperAppPath}`,
			);
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
