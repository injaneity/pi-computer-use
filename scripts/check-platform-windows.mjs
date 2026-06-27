#!/usr/bin/env node
import assert from "node:assert/strict";
import { platformBackendForRuntime } from "../src/platform/index.ts";

const win = platformBackendForRuntime("win32");
assert.equal(win.name, "windows");
assert.equal(typeof win.ensureReady, "function");
assert.equal(typeof win.listApps, "function");
assert.equal(typeof win.listWindows, "function");
assert.equal(typeof win.observe, "function");
assert.equal(typeof win.act, "function");

const mac = platformBackendForRuntime("darwin");
assert.equal(mac.name, "macos");
assert.equal(typeof mac.ensureReady, "function");
assert.equal(typeof mac.listApps, "function");
assert.equal(typeof mac.listWindows, "function");
assert.equal(typeof mac.observe, "function");
assert.equal(typeof mac.act, "function");

console.log("platform checks passed");
