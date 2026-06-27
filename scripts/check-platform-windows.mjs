#!/usr/bin/env node
import assert from "node:assert/strict";
import { platformForRuntime } from "../src/platform/index.ts";

// -- Windows platform -------------------------------------------------------

const win = platformForRuntime("win32");
assert.equal(win.name, "windows");

// SUPPORTED commands
assert.equal(win.supportsCommand("listWindows"), true);
assert.equal(win.supportsCommand("screenshot"), true);

// DEFERRED action commands
assert.equal(win.supportsCommand("mouseClick"), "capability_deferred");
assert.equal(win.supportsCommand("mouseMove"), "capability_deferred");
assert.equal(win.supportsCommand("mouseDrag"), "capability_deferred");
assert.equal(win.supportsCommand("scrollWheel"), "capability_deferred");
assert.equal(win.supportsCommand("keyPress"), "capability_deferred");
assert.equal(win.supportsCommand("typeText"), "capability_deferred");
assert.equal(win.supportsCommand("setValue"), "capability_deferred");
assert.equal(win.supportsCommand("axPressElement"), "capability_deferred");
assert.equal(win.supportsCommand("axScrollElement"), "capability_deferred");
assert.equal(win.supportsCommand("navigateBrowser"), "capability_deferred");
assert.equal(win.supportsCommand("evaluateBrowser"), "capability_deferred");
assert.equal(win.supportsCommand("launchBrowserContext"), "capability_deferred");
assert.equal(win.supportsCommand("computerActions"), "capability_deferred");
assert.equal(win.supportsCommand("axWaitFor"), "capability_deferred");

// DEFERRED read-only commands (not implemented as separate helper commands)
// listApps is supported at the TS level via projection from listWindows.
assert.equal(win.supportsCommand("listApps"), true);
assert.equal(win.supportsCommand("checkPermissions"), "capability_deferred");
assert.equal(win.supportsCommand("getFrontmost"), "capability_deferred");
assert.equal(win.supportsCommand("axListTargets"), "capability_deferred");

// Unknown commands are unsupported
assert.equal(win.supportsCommand("unknownFakeCommand"), "unsupported_command");
assert.equal(win.supportsCommand(""), "unsupported_command");

// -- macOS platform ---------------------------------------------------------

const mac = platformForRuntime("darwin");
assert.equal(mac.name, "macos");
assert.equal(mac.supportsCommand("listWindows"), true);
assert.equal(mac.supportsCommand("screenshot"), true);
assert.equal(mac.supportsCommand("mouseClick"), true);

console.log("platform checks passed");
