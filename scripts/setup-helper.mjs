#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultHelperAppPath = "/Applications/pi-computer-use.app";
const helperAppPath = process.env.PI_COMPUTER_USE_HELPER_APP_PATH || defaultHelperAppPath;
const helperAppExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
const helperSourceHashPath = path.join(helperAppPath, "Contents", "Resources", "source.sha256");
const helperBundleId = "com.injaneity.pi-computer-use";
const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
const windowsHelperDestPath = process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");
const helperSourcePaths = ["agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"]
	.map((file) => path.join(rootDir, "native", "macos", file));
const packageJsonPath = path.join(rootDir, "package.json");
const releaseRepo = "injaneity/pi-computer-use";
const localCodeSignCommonName = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";
const localSigningLockPath = path.join(os.tmpdir(), `pi-computer-use-local-signing-${typeof process.getuid === "function" ? process.getuid() : "user"}.lock`);

const args = new Set(process.argv.slice(2));
const isPostinstall = args.has("--postinstall");
const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const allowAdhocUpdate = args.has("--allow-adhoc-update") || process.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === "1";

function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
	return undefined;
}
const archTriples = {
	arm64: "arm64-apple-macosx",
	x64: "x86_64-apple-macosx",
};
const deploymentTarget = "14.0";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

function normalizeArch(arch) {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
}

function prebuiltPathForArch(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "bridge");
}

function prebuiltAppPathForArch(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "pi-computer-use.app");
}

const releaseAssetName = "pi-computer-use.app.zip";

async function packageVersion() {
	const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
	if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
		throw new Error(`Could not read package version from ${packageJsonPath}.`);
	}
	return packageJson.version;
}

function githubReleaseUrl(tag, assetName) {
	return `https://github.com/${releaseRepo}/releases/download/${tag}/${assetName}`;
}

async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.F_OK);
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
		await fs.rm(tempPath, { force: true }).catch(() => {});
		if (err.code === "EPERM") {
			throw new Error(`Cannot update helper at ${destinationPath} — the existing helper process is still running. Close the helper process and re-run this script.`);
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

function moduleCachePath(arch) {
	return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}`);
}

async function commandOutput(command, commandArgs) {
	const { stdout } = await execFile(command, commandArgs, { encoding: "utf8" });
	return stdout;
}

async function downloadFile(url, outputPath) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	if (!response.body) {
		throw new Error("empty response body");
	}
	await pipeline(response.body, createWriteStream(outputPath));
}

async function releaseChecksums(tag) {
	const response = await fetch(githubReleaseUrl(tag, "SHA256SUMS"));
	if (!response.ok) return new Map();
	const text = await response.text();
	const checksums = new Map();
	for (const line of text.split("\n")) {
		const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
		if (match) checksums.set(path.basename(match[2]), match[1].toLowerCase());
	}
	return checksums;
}

async function verifySha256(filePath, expected) {
	const file = await fs.readFile(filePath);
	const actual = createHash("sha256").update(file).digest("hex");
	if (actual !== expected.toLowerCase()) {
		throw new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
	}
}

async function findExtractedHelperApp(extractDir) {
	const direct = path.join(extractDir, "pi-computer-use.app");
	if (await exists(direct)) return direct;
	const entries = await fs.readdir(extractDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const entryPath = path.join(extractDir, entry.name);
		if (entry.name === "pi-computer-use.app") return entryPath;
		const nested = await findExtractedHelperApp(entryPath);
		if (nested) return nested;
	}
	return undefined;
}

async function downloadReleaseHelperApp() {
	const version = await packageVersion();
	const tag = `v${version}`;
	const checksums = await releaseChecksums(tag).catch(() => new Map());
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-release-helper-"));
	try {
		const zipPath = path.join(tempDir, releaseAssetName);
		await downloadFile(githubReleaseUrl(tag, releaseAssetName), zipPath);
		const expectedSha = checksums.get(releaseAssetName);
		if (expectedSha) await verifySha256(zipPath, expectedSha);
		const extractDir = path.join(tempDir, "extract");
		await fs.mkdir(extractDir, { recursive: true });
		await run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
		const appPath = await findExtractedHelperApp(extractDir);
		if (!appPath) throw new Error(`missing pi-computer-use.app in ${releaseAssetName}`);
		return { appPath, tempDir, assetName: releaseAssetName, tag };
	} catch (error) {
		await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
		throw new Error(`No signed helper release asset found for ${tag}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function findDeveloperIdIdentity() {
	const output = await commandOutput("security", ["find-identity", "-p", "codesigning", "-v"]).catch(() => "");
	const line = output.split("\n").find((item) => item.includes("Developer ID Application"));
	return line?.trim().split(/\s+/)[1];
}

export function parseCodeSigningIdentities(output, commonName = localCodeSignCommonName) {
	return output.split("\n")
		.map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/i))
		.filter((match) => match?.[2] === commonName)
		.map((match) => match[1].toUpperCase());
}

async function findLocalSigningIdentity() {
	// Self-signed local identities appear as CSSMERR_TP_NOT_TRUSTED and are
	// omitted by `-v`, but remain valid inputs to codesign. Match the identity
	// list directly and return its fingerprint rather than its display name.
	const output = await commandOutput("security", ["find-identity", "-p", "codesigning"]).catch(() => "");
	return parseCodeSigningIdentities(output)[0];
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDirectoryLock(lockPath, callback, { waitMs = 15_000, staleMs = 300_000, retryMs = 50 } = {}) {
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			await fs.mkdir(lockPath);
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const stat = await fs.stat(lockPath).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > staleMs) {
				await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for local signing identity lock at ${lockPath}.`);
			await delay(retryMs);
		}
	}
	try {
		return await callback();
	} finally {
		await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
	}
}

export async function ensureIdentityOnce(findIdentity, createIdentity, withLock) {
	return (await findIdentity()) ?? await withLock(async () => (await findIdentity()) ?? await createIdentity());
}

async function loginKeychainPath() {
	for (const candidate of [
		path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
		path.join(os.homedir(), "Library", "Keychains", "login.keychain"),
	]) {
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

async function ensureLocalSigningIdentity() {
	if (process.platform !== "darwin") return undefined;
	if (!(await commandOutput("which", ["codesign"]).catch(() => ""))) return undefined;
	const existingIdentity = await findLocalSigningIdentity();
	if (existingIdentity) return existingIdentity;
	if (!(await commandOutput("which", ["openssl"]).catch(() => ""))) return undefined;
	const keychain = await loginKeychainPath();
	if (!keychain) return undefined;

	return await ensureIdentityOnce(findLocalSigningIdentity, createLocalSigningIdentity, (callback) => withDirectoryLock(localSigningLockPath, callback));
}

async function createLocalSigningIdentity() {
	const keychain = await loginKeychainPath();
	if (!keychain) return undefined;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-"));
	const password = `pi-computer-use-local-${process.pid}-${Date.now()}`;
	try {
		const configPath = path.join(tempDir, "req.cnf");
		await fs.writeFile(configPath, [
			"[req]",
			"distinguished_name=dn",
			"x509_extensions=ext",
			"prompt=no",
			"[dn]",
			`CN=${localCodeSignCommonName}`,
			"[ext]",
			"basicConstraints=critical,CA:FALSE",
			"keyUsage=critical,digitalSignature",
			"extendedKeyUsage=critical,codeSigning",
			"",
		].join("\n"));
		const keyPath = path.join(tempDir, "key.pem");
		const certPath = path.join(tempDir, "cert.pem");
		const p12Path = path.join(tempDir, "id.p12");
		await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "3650", "-nodes", "-config", configPath]);
		await execFile("openssl", ["pkcs12", "-export", "-legacy", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName])
			.catch(async () => {
				await execFile("openssl", ["pkcs12", "-export", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName]);
			});
		await execFile("security", ["import", p12Path, "-k", keychain, "-P", password, "-A", "-T", "/usr/bin/codesign"]);
		const identity = await findLocalSigningIdentity();
		if (!identity) throw new Error("Imported local signing certificate is not a valid code-signing identity.");
		return identity;
	} catch (error) {
		console.warn(`[pi-computer-use] could not create a valid local signing identity: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	} finally {
		await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
	}
}

async function resolveCodeSignIdentity() {
	if (process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY) return process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY;
	return (await findDeveloperIdIdentity()) ?? (await ensureLocalSigningIdentity()) ?? "-";
}

async function signHelper(outputPath, identifier = defaultCodeSignIdentifier) {
	if (process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return "unsigned";
	}

	const identity = await resolveCodeSignIdentity();
	const commandArgs = ["--force", "--deep", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
	await run("codesign", commandArgs);
	if (identity === "-") {
		console.warn("[pi-computer-use] warning: signed helper ad-hoc; macOS may require permission review after native helper changes. Release installs should use a Developer ID-signed helper app.");
	} else if (identity === await findLocalSigningIdentity()) {
		console.log(`[pi-computer-use] signed ${outputPath} with local identity '${localCodeSignCommonName}'. macOS may still require permission review after local rebuilds.`);
	}
	return identity;
}

async function helperHasAdhocSignature() {
	const output = await execFile("codesign", ["-dv", "--verbose=4", helperAppPath], { encoding: "utf8" }).then(
		(result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		(error) => `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
	);
	return /Signature=adhoc/i.test(output);
}

async function registerHelperApp() {
	if (helperAppPath !== defaultHelperAppPath) return;
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
	// what gives release builds their best chance of retaining TCC grants.
	await run("/usr/bin/ditto", [sourceAppPath, helperAppPath]);
	await registerHelperApp();
	return true;
}

async function installHelperApp(sourcePath) {
	await fs.access(path.dirname(helperAppPath), fsConstants.W_OK);
	const version = await packageVersion();
	const infoPlistPath = path.join(helperAppPath, "Contents", "Info.plist");
	const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${helperBundleId}</string>
<key>CFBundleName</key><string>pi-computer-use</string>
<key>CFBundleDisplayName</key><string>pi-computer-use</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`;

	const sourceExecutable = await fs.readFile(sourcePath);
	const sourceHash = createHash("sha256").update(sourceExecutable).digest("hex");
	const existingSourceHash = await fs.readFile(helperSourceHashPath, "utf8").catch(() => undefined);
	const existingInfoPlist = await fs.readFile(infoPlistPath, "utf8").catch(() => undefined);
	if (existingSourceHash?.trim() === sourceHash && existingInfoPlist === infoPlist) {
		// If a real signing identity is available, upgrade older ad-hoc installs
		// in place so local builds have a consistent identity. macOS may still
		// require permission review after native code changes.
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

async function buildHelper(arch, outputPath) {
	for (const sourcePath of helperSourcePaths) {
		if (!(await exists(sourcePath))) throw new Error(`Native helper source not found at ${sourcePath}`);
	}

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const swiftArgs = [
		"swiftc",
		"-target",
		`${archTriples[arch]}${deploymentTarget}`,
		"-module-cache-path",
		moduleCachePath(arch),
		"-O",
	];
	for (const framework of frameworks) swiftArgs.push("-framework", framework);
	swiftArgs.push(...helperSourcePaths, "-o", outputPath);

	await run("xcrun", swiftArgs);
	await fs.chmod(outputPath, 0o755);
	await signHelper(outputPath);
}

function windowsBinaryPath() {
	const releaseDir = path.join(windowsCrateDir, "target", "release");
	return {
		exePath: path.join(releaseDir, "windows-bridge.exe"),
		binPath: path.join(releaseDir, "windows-bridge"),
	};
}

async function setupWindowsHelper() {
	const prebuiltPath = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");
	if (await exists(prebuiltPath)) {
		const { changed } = await copyIfChanged(prebuiltPath, windowsHelperDestPath);
		console.log(changed
			? `[pi-computer-use] installed Windows helper from prebuilt to ${windowsHelperDestPath}`
			: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
		return;
	}

	if (allowBuildFallback) {
		console.log("[pi-computer-use] Windows prebuilt helper missing; attempting source build with cargo...");
		await run("cargo", ["build", "--release", "--manifest-path", path.join(windowsCrateDir, "Cargo.toml")]);
		const { exePath, binPath } = windowsBinaryPath();
		const cargoOutput = (await exists(exePath)) ? exePath : (await exists(binPath)) ? binPath : exePath;
		const { changed } = await copyIfChanged(cargoOutput, windowsHelperDestPath);
		console.log(changed
			? `[pi-computer-use] built and installed Windows helper at ${windowsHelperDestPath}`
			: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
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
	// Prefer the release-signed universal bundle (one artifact for both
	// arches, produced by .github/workflows/release.yml) over
	// per-arch bundles, over loose binaries (dev fallback).
	const universalAppPath = prebuiltAppPathForArch("universal");
	const prebuiltAppPath = (await exists(universalAppPath))
		? universalAppPath
		: prebuiltAppPathForArch(arch);
	const prebuiltPath = prebuiltPathForArch(arch);
	const prebuiltAppExists = await exists(prebuiltAppPath);
	const prebuiltExists = await exists(prebuiltPath);

	if (prebuiltAppExists) {
		const installed = await installPrebuiltHelperApp(prebuiltAppPath);
		console.log(
			installed
				? `[pi-computer-use] installed pre-signed helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] pre-signed helper app (${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	if (prebuiltExists) {
		const installed = await installHelperApp(prebuiltPath);
		console.log(
			installed
				? `[pi-computer-use] installed helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] helper app (${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	try {
		const releaseHelper = await downloadReleaseHelperApp();
		try {
			const installed = await installPrebuiltHelperApp(releaseHelper.appPath);
			console.log(
				installed
					? `[pi-computer-use] installed signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) at ${helperAppPath}`
					: `[pi-computer-use] signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) already current at ${helperAppPath}`,
			);
		} finally {
			await fs.rm(releaseHelper.tempDir, { force: true, recursive: true }).catch(() => {});
		}
		return;
	} catch (error) {
		console.warn(`[pi-computer-use] signed helper release download unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (allowBuildFallback) {
		const tempPath = path.join(os.tmpdir(), `pi-computer-use-bridge-${process.pid}-${Date.now()}`);
		try {
			console.log("[pi-computer-use] prebuilt helper missing; attempting source build with xcrun swiftc...");
			await buildHelper(arch, tempPath);
			const installed = await installHelperApp(tempPath);
			console.log(
				installed
					? `[pi-computer-use] built helper app at ${helperAppPath}`
					: `[pi-computer-use] built helper app; installed app already current at ${helperAppPath}`,
			);
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => {});
		}
		return;
	}

	throw new Error(
		`No prebuilt helper found for ${arch} at ${prebuiltPath}. Run 'npm run build:native' to build locally.`,
	);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) setup().catch((error) => {
	if (isPostinstall) {
		console.warn(`[pi-computer-use] postinstall helper setup skipped: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(0);
	}

	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
