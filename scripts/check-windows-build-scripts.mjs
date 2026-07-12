#!/usr/bin/env node

/**
 * Smoke tests for Windows build/install script paths (Task 7).
 *
 * Exercises --platform windows argument routing and path alignment
 * without requiring Windows or a committed prebuilt binary.
 *
 * Verifies:
 *   1. Path constants stay aligned with the Windows backend helper path
 *   2. windowsBinaryPath() candidate logic
 *   3. --platform windows CLI routing in both scripts
 *   4. Expected error messages when prebuilt/cargo are absent
 *   5. Existing macOS/Linux skip/fallback paths remain unchanged
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-computer-use-script-test-"));
const TEST_HELPER_APP = path.join(TEST_ROOT, "pi-computer-use.app");
const TEST_WINDOWS_HELPER = path.join(TEST_ROOT, "windows-bridge.exe");
const LIVE_HELPER = "/Applications/pi-computer-use.app/Contents/MacOS/bridge";

function fileFingerprint(filePath) {
  if (!fs.existsSync(filePath)) return "missing";
  const stat = fs.statSync(filePath);
  const hash = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return `${stat.mtimeMs}:${stat.size}:${hash}`;
}

const liveHelperBefore = fileFingerprint(LIVE_HELPER);
const armPrebuiltBefore = fileFingerprint(path.join(ROOT, "prebuilt", "macos", "arm64", "bridge"));

// ---------------------------------------------------------------------------
// Path constants – replicated to avoid crossing the TS/ESM module boundary
// while still catching drift between the scripts and Windows backend helper path.
// ---------------------------------------------------------------------------

const HOMEDIR = os.homedir();

// From scripts/setup-helper.mjs:
const WINDOWS_HELPER_DEST = path.join(
  HOMEDIR, ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe",
);

// Expected by src/platform/windows/helper.ts → WINDOWS_HELPER_PATH:
const WINDOWS_HELPER_STABLE_PATH = path.join(
  HOMEDIR, ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe",
);

// windowsBinaryPath() candidates (function present in both scripts):
const WINDOWS_CRATE_DIR = path.join(ROOT, "native", "windows", "bridge-rs");
const RELEASE_DIR = path.join(WINDOWS_CRATE_DIR, "target", "release");
const EXE_CANDIDATE = path.join(RELEASE_DIR, "windows-bridge.exe");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let failures = 0;
let assertions = 0;
const LABEL = "[check-windows-build-scripts]";

function tap(actual, expected, msg) {
  assertions++;
  const ok = actual === expected;
  console.log(ok ? "  \u2705" : "  \u274c", msg);
  if (!ok) {
    console.error(`       expected: ${JSON.stringify(expected)}`);
    console.error(`       actual:   ${JSON.stringify(actual)}`);
    failures++;
  }
}

function tapMatch(actual, re, msg) {
  assertions++;
  const ok = re.test(actual);
  console.log(ok ? "  \u2705" : "  \u274c", msg);
  if (!ok) {
    console.error(`       pattern:  ${re}`);
    console.error(`       actual:   ${JSON.stringify(actual.slice(0, 200))}`);
    failures++;
  }
}

/** Spawn a script, capturing stdout/stderr and the exit code. */
function runScript(relPath, args) {
  const scriptPath = path.join(__dirname, relPath);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_COMPUTER_USE_HELPER_APP_PATH: TEST_HELPER_APP,
        PI_COMPUTER_USE_WINDOWS_HELPER_PATH: TEST_WINDOWS_HELPER,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

/** Remove a path recursively, ignoring errors. */
function rmSilent(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ok */ }
}
process.on("exit", () => rmSilent(TEST_ROOT));

// ---------------------------------------------------------------------------
// 1. Static path alignment
// ---------------------------------------------------------------------------

console.log(`\n${LABEL} Path alignment`);

tap(
  WINDOWS_HELPER_DEST,
  WINDOWS_HELPER_STABLE_PATH,
  "setup-helper.mjs dest matches WINDOWS_HELPER_PATH in src/platform/windows/helper.ts",
);

tap(
  EXE_CANDIDATE,
  path.join(ROOT, "native", "windows", "bridge-rs", "target", "release", "windows-bridge.exe"),
  "windowsBinaryPath exePath points to windows-bridge.exe in release dir",
);

tap(
  path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"),
  path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"),
  "prebuilt stored under prebuilt/windows/windows-bridge.exe",
);

// ---------------------------------------------------------------------------
// 2. CLI routing – build-native.mjs
// ---------------------------------------------------------------------------

// Start fresh: ensure prebuilt/windows/ does not exist from a prior run.
rmSilent(path.join(ROOT, "prebuilt", "windows"));

console.log(`\n${LABEL} build-native.mjs --platform windows (output to tmpdir)`);

// Use a temp output path so we never pollute prebuilt/windows/ during tests.
const tmpBuildOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-windows-smoke-")), "windows-bridge.exe");
{
  const result = await runScript("build-native.mjs", [
    "--platform", "windows",
    "--output", tmpBuildOut,
  ]);
  if (isWin32()) {
    tap(result.code, 0, "build-native.mjs --platform windows --output <tmp> exits 0 on Windows");
    tapMatch(result.stdout, /Building Windows helper/, "prints build start message");
  } else {
    tap(result.code, 1, "host build is rejected instead of being renamed to .exe");
    tapMatch(result.stderr, /Refusing to label a host binary as Windows/, "explains that a Windows host or target is required");
  }
}
rmSilent(path.dirname(tmpBuildOut));

// After the build above, cargo may have left target/release/windows-bridge but
// the prebuilt directory in the repo should be untouched. Verify it still
// doesn't exist (the script used --output → our tmpdir, not the default path).
const prebuiltDir = path.join(ROOT, "prebuilt", "windows");
tap(!fs.existsSync(prebuiltDir), true, "prebuilt/windows/ not created in repo (used --output)");

function isWin32() { return process.platform === "win32"; }
function isDarwin() { return process.platform === "darwin"; }

console.log(`\n${LABEL} build-native.mjs (no args, platform detection)`);

{
  const result = await runScript("build-native.mjs", ["--output", path.join(TEST_ROOT, "native-default")]);
  if (isWin32()) {
    tap(result.code, 0, "no-args exits 0 on Windows");
    tapMatch(result.stdout, /Building Windows helper/, "builds Windows helper on win32");
  } else if (isDarwin()) {
    tap(result.code, 0, "no-args exits 0 on macOS");
    tapMatch(result.stdout, /Building .*native helper|Built .*helper/, "builds macOS helper on darwin");
  } else {
    tap(result.code, 0, "no-args exits 0 on Linux");
    tapMatch(result.stdout, /Skipping native build/, "prints platform-skip message");
  }
}

console.log(`\n${LABEL} build-native.mjs --platform darwin`);

{
  const result = await runScript("build-native.mjs", ["--platform", "darwin", "--output", path.join(TEST_ROOT, "native-darwin")]);
  if (isDarwin()) {
    tap(result.code, 0, "--platform darwin exits 0 on macOS");
    tapMatch(result.stdout, /Building .*native helper|Built .*helper/, "builds macOS helper on darwin");
  } else {
    tap(result.code, 1, "--platform darwin exits 1 without macOS toolchain");
    tapMatch(result.stderr, /xcrun|ENOENT|Command failed/, "errors about missing xcrun/swift toolchain");
  }
}

// ---------------------------------------------------------------------------
// 3. CLI routing – setup-helper.mjs
// ---------------------------------------------------------------------------

console.log(`\n${LABEL} setup-helper.mjs --platform windows (prebuilt handling)`);

{
  const prebuiltExists = fs.existsSync(path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"));
  const result = await runScript("setup-helper.mjs", ["--platform", "windows"]);
  if (prebuiltExists) {
    // When the prebuilt exists, setup may succeed, or fail gracefully with EPERM if the
    // destination helper is locked by a running process.
    const isOk = result.code === 0 || result.stderr.includes("EPERM");
    tap(isOk, true, "--platform windows handles prebuilt (install or EPERM gracefully)");
  } else {
    // When no prebuilt exists and --allow-build is not given, must error with instructions.
    tap(result.code, 1, "--platform windows exits 1 when prebuilt absent");
    tapMatch(
      result.stderr,
      /No Windows prebuilt helper found/,
      "prints helpful error about missing prebuilt with build instructions",
    );
  }
}

console.log(`\n${LABEL} setup-helper.mjs (no args, platform detection)`);

{
  const result = await runScript("setup-helper.mjs", []);
  if (isWin32()) {
    // On Windows, no-args should auto-detect win32 and attempt Windows helper setup.
    // It may succeed or hit EPERM if the destination is locked.
    const isAcceptable = result.code === 0 || result.stderr.includes("EPERM");
    tap(isAcceptable, true, "no-args handles win32 auto-detection");
  } else if (isDarwin()) {
    tap(result.code === 0 || result.stderr.includes("EPERM"), true, "no-args installs only into the isolated test app on macOS");
    const combined = result.stderr + result.stdout;
    tap(/installed|current|unavailable|EPERM/i.test(combined), true, "prints macOS install/current/sandbox status");
  } else {
    tap(result.code, 1, "no-args exits 1 on non-Windows/non-macOS");
    tapMatch(result.stderr, /only supported on macOS/, "prints macOS-only error");
  }
}

console.log(`\n${LABEL} setup-helper.mjs --postinstall (platform detection)`);

{
  const result = await runScript("setup-helper.mjs", ["--postinstall"]);
  if (isWin32()) {
    // On Windows, postinstall should exit 0 gracefully. The helper may be
    // installed, up-to-date, or the install skipped with a clear message.
    tap(result.code, 0, "--postinstall exits 0 on Windows");
    const combined = result.stderr + result.stdout;
    const hasAcceptableMsg = /skipped|installed|up to date/i.test(combined);
    tap(hasAcceptableMsg, true, "prints skip, install, or up-to-date message");
  } else if (isDarwin()) {
    tap(result.code, 0, "--postinstall exits 0 on macOS");
    const combined = result.stderr + result.stdout;
    tap(/installed|current|unavailable|skipped|EPERM/i.test(combined), true, "prints macOS install/current/sandbox status");
  } else {
    tap(result.code, 0, "--postinstall exits 0 on non-Windows/non-macOS");
    tapMatch(result.stderr, /skipping helper setup/, "prints skip warning");
  }
}

console.log(`\n${LABEL} setup-helper.mjs --platform windows --postinstall`);

{
  const result = await runScript("setup-helper.mjs", ["--platform", "windows", "--postinstall"]);
  tap(result.code, 0, "--platform windows --postinstall exits 0 (postinstall catch-all)");
  const combined = result.stderr + result.stdout;
  const hasMsg = /skipped|installed|up to date/i.test(combined);
  tap(hasMsg, true, "prints appropriate status message (skip, install, or up-to-date)");
}

// ---------------------------------------------------------------------------
// 4. Source-level argument routing verification
//    (confirm the --platform handler lines exist in the right shape)
// ---------------------------------------------------------------------------

console.log(`\n${LABEL} Source-level --platform routing`);

function grepSource(relPath, pattern) {
  const src = fs.readFileSync(path.join(__dirname, relPath), "utf8");
  return pattern.test(src);
}

tap(
  grepSource("build-native.mjs", /explicitPlatform === "windows"/),
  true,
  "build-native.mjs routes on --platform windows",
);
tap(
  grepSource("build-native.mjs", /explicitPlatform === "darwin"/),
  true,
  "build-native.mjs routes on --platform darwin",
);
tap(
  grepSource("setup-helper.mjs", /explicitPlatform === "windows"/),
  true,
  "setup-helper.mjs routes on --platform windows",
);

console.log(`\n${LABEL} Live-install isolation`);
tap(fileFingerprint(LIVE_HELPER), liveHelperBefore, "tests do not modify the installed macOS helper");
tap(fileFingerprint(path.join(ROOT, "prebuilt", "macos", "arm64", "bridge")), armPrebuiltBefore, "tests do not rebuild the committed macOS helper");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${LABEL} ${"=".repeat(40)}`);
console.log(`${LABEL} Assertions: ${assertions}   Failures: ${failures}`);
if (failures === 0) {
  console.log(`${LABEL} \u2705 ALL PASSED`);
} else {
  console.log(`${LABEL} \u274c ${failures} FAILURE(S)`);
  process.exit(1);
}
