#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(root, "docs/content/docs");
const modes = ["tutorials", "how-to-guides", "explanation", "reference"];
const failures = [];

for (const mode of modes) {
	const path = resolve(docsRoot, mode);
	if (!existsSync(path) || !statSync(path).isDirectory()) failures.push(`Missing Diátaxis section: docs/${mode}/`);
}

function filesBelow(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? filesBelow(path) : [path];
	});
}

const markdownFiles = filesBelow(docsRoot).filter((file) => [".md", ".mdx"].includes(extname(file)));

for (const path of markdownFiles) {
	const content = readFileSync(path, "utf8");
	const display = relative(root, path);
	if (display.includes("docs/content/docs/reference/") && !content.slice(0, 700).includes("{/* This file is generated")) {
		failures.push(`${display}: every reader-facing reference page must be generated from source ownership or repository metadata`);
	}

	for (const match of content.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
		const rawTarget = match[1].trim().replace(/^<|>$/g, "");
		if (!rawTarget || /^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
		const target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
		const resolved = target.startsWith("/") ? resolve(docsRoot, `.${target}`) : resolve(dirname(path), target);
		const candidates = [resolved, `${resolved}.md`, `${resolved}.mdx`, resolve(resolved, "index.md"), resolve(resolved, "index.mdx")];
		if (!candidates.some((candidate) => existsSync(candidate))) failures.push(`${display}: broken local link ${rawTarget}`);
	}
}

const macosDocPath = resolve(docsRoot, "reference/platforms/macos/implementation.mdx");
if (existsSync(macosDocPath)) {
	const macosDoc = readFileSync(macosDocPath, "utf8");
	const macosSource = [
		"native/macos/bridge.swift",
		"native/macos/agent_cursor.swift",
		"src/platform/macos/helper.ts",
		"scripts/setup-helper.mjs",
	].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
	const coverage = [
		"AXIsProcessTrustedWithOptions",
		"CGPreflightScreenCaptureAccess",
		"CGRequestScreenCaptureAccess",
		"CGWindowListCopyWindowInfo",
		"SCScreenshotManager.captureImage",
		"VNRecognizeTextRequest",
		"AXUIElementPerformAction",
		"AXUIElementSetAttributeValue",
		"postToPid",
		"cghidEventTap",
		"/usr/sbin/screencapture",
		"AgentCursor",
		"ax_only",
	];
	for (const symbol of coverage) {
		if (!macosSource.includes(symbol)) failures.push(`macOS reference coverage expects source symbol ${symbol}, but the implementation no longer contains it`);
		if (!macosDoc.includes(symbol)) failures.push(`docs/content/docs/reference/platforms/macos/implementation.mdx: missing implementation coverage for ${symbol}`);
	}
	if (!macosDoc.includes("https://developer.apple.com/documentation/")) failures.push("docs/content/docs/reference/platforms/macos/implementation.mdx: platform claims need Apple documentation links");
	if (!macosDoc.includes("https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L")) failures.push("docs/content/docs/reference/platforms/macos/implementation.mdx: implementation claims need source links");
} else {
	failures.push("Missing macOS implementation reference: docs/content/docs/reference/platforms/macos/implementation.mdx");
}

const allDocs = [resolve(root, "README.md"), resolve(root, "CONTRIBUTING.md"), ...markdownFiles]
	.map((file) => readFileSync(file, "utf8"))
	.join("\n");
const staleMacosClaims = [
	[/ScreenCaptureKit probe\s*\(authoritative\)/i, "ScreenCaptureKit readiness query described as an authoritative permission API"],
	[/already listed in (?:both )?(?:settings )?panes/i, "version-dependent System Settings listing guarantee"],
	[/setup-helper\.mjs --force/, "nonexistent setup-helper --force option"],
	[/TCC keys? (?:grant|permission)/i, "undocumented TCC identity guarantee"],
];
for (const [pattern, description] of staleMacosClaims) {
	if (pattern.test(allDocs)) failures.push(`Stale macOS claim: ${description}`);
}

if (failures.length) {
	console.error("Documentation checks failed:\n");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log("Documentation structure and local links passed.");
