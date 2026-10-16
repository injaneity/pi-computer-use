#!/usr/bin/env node
import assert from "node:assert/strict";

const { testing } = await import("../src/bridge.ts");
const { managedBrowserNeedsHeadless, managedBrowserArgs } = testing;

const originalPlatform = process.platform;
const originalEnv = {
	DISPLAY: process.env.DISPLAY,
	WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
	PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS: process.env.PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS,
};

function setPlatform(value) {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restoreEnv() {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

try {
	restoreEnv();

	setPlatform("linux");
	delete process.env.DISPLAY;
	delete process.env.WAYLAND_DISPLAY;
	assert.equal(managedBrowserNeedsHeadless(), true, "linux without DISPLAY or WAYLAND_DISPLAY must run headless");
	assert.deepEqual(
		managedBrowserArgs({ remoteDebuggingPort: 9222, userDataDir: "/tmp/profile", url: "https://example.com" }),
		["--remote-debugging-port=9222", "--user-data-dir=/tmp/profile", "--no-first-run", "--no-default-browser-check", "--headless=new", "--no-sandbox", "--disable-gpu", "https://example.com"],
		"headless launch must add --headless=new --no-sandbox --disable-gpu",
	);

	process.env.DISPLAY = ":0";
	assert.equal(managedBrowserNeedsHeadless(), false, "linux with DISPLAY set must stay windowed");
	assert.deepEqual(
		managedBrowserArgs({ remoteDebuggingPort: 9222, userDataDir: "/tmp/profile", url: "https://example.com" }),
		["--remote-debugging-port=9222", "--user-data-dir=/tmp/profile", "--no-first-run", "--no-default-browser-check", "https://example.com"],
		"windowed launch must not add headless flags",
	);
	delete process.env.DISPLAY;

	process.env.WAYLAND_DISPLAY = "wayland-0";
	assert.equal(managedBrowserNeedsHeadless(), false, "linux with WAYLAND_DISPLAY set must stay windowed");
	delete process.env.WAYLAND_DISPLAY;

	setPlatform("darwin");
	assert.equal(managedBrowserNeedsHeadless(), false, "macOS always has a desktop session");

	setPlatform("win32");
	assert.equal(managedBrowserNeedsHeadless(), false, "Windows always has a desktop session");

	setPlatform("linux");
	process.env.PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS = "1";
	process.env.DISPLAY = ":0";
	assert.equal(managedBrowserNeedsHeadless(), true, "explicit override forces headless even when a display is present");
	delete process.env.DISPLAY;

	process.env.PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS = "0";
	delete process.env.DISPLAY;
	delete process.env.WAYLAND_DISPLAY;
	assert.equal(managedBrowserNeedsHeadless(), false, "explicit override forces windowed even without a display");

	process.env.PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS = "true";
	assert.equal(managedBrowserNeedsHeadless(), true, "override accepts 'true' as well as '1'");

	process.env.PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS = "false";
	assert.equal(managedBrowserNeedsHeadless(), false, "override accepts 'false' as well as '0'");

	console.log("Managed browser headless detection checks passed");
} finally {
	setPlatform(originalPlatform);
	restoreEnv();
}
