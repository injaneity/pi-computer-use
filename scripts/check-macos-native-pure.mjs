#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
	console.log("macos native pure checks skipped (not macOS)");
	process.exit(0);
}
const source = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
const match = source.match(/\/\/ BEGIN PURE[^\n]*\n([\s\S]*?)\/\/ END PURE/);
if (!match) throw new Error("PURE region not found in bridge.swift");

const main = `
import Foundation
var failures = 0
func check(_ ok: Bool, _ name: String) { if !ok { failures += 1; print("FAIL: \\(name)") } }

check(!classifyModal(axModal: false, sheetCount: 0, role: "AXWindow", subrole: "AXDialog"), "AXModal=0 + AXDialog is nonmodal (Fusion sidebar)")
check(classifyModal(axModal: true, sheetCount: 0, role: "AXWindow", subrole: "AXStandardWindow"), "AXModal=1 is modal")
check(classifyModal(axModal: true, sheetCount: 0, role: "AXWindow", subrole: "AXDialog"), "AXModal=1 + AXDialog is modal")
check(classifyModal(axModal: false, sheetCount: 1, role: "AXWindow", subrole: "AXStandardWindow"), "sheet child is modal")
check(classifyModal(axModal: nil, sheetCount: 0, role: "AXSheet", subrole: ""), "AXSheet is modal")
check(classifyModal(axModal: nil, sheetCount: 0, role: "AXWindow", subrole: "AXDialog"), "unreported AXModal + AXDialog falls back to modal")
check(!classifyModal(axModal: nil, sheetCount: 0, role: "AXWindow", subrole: "AXStandardWindow"), "plain window nonmodal")
check(!classifyModal(axModal: false, sheetCount: 0, role: "AXWindow", subrole: "AXSystemDialog"), "explicit AXModal=0 wins over any dialog subrole")

check(resolveCaptureTarget(windowId: 12, wantsImage: true) == .capture(windowId: 12), "paired + image captures")
check(resolveCaptureTarget(windowId: 12, wantsImage: false) == .semanticOnly, "paired semantic skips capture")
check(resolveCaptureTarget(windowId: nil, wantsImage: false) == .semanticOnly, "unpaired semantic ok")
check(resolveCaptureTarget(windowId: nil, wantsImage: true) == .notCapturable, "unpaired visual errors")
check(resolveCaptureTarget(windowId: 0, wantsImage: true) == .notCapturable, "window 0 never captured")

if failures > 0 { exit(1) }
print("macos native pure checks passed")
`;
const dir = mkdtempSync(path.join(tmpdir(), "pcu-pure-"));
try {
	writeFileSync(path.join(dir, "main.swift"), match[1] + main);
	execFileSync("swiftc", ["-O", "-o", path.join(dir, "t"), path.join(dir, "main.swift")], { stdio: "inherit" });
	process.stdout.write(execFileSync(path.join(dir, "t"), { encoding: "utf8" }));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
