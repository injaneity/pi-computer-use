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
const layoutMatch = source.match(/\/\/ BEGIN KEYBOARD LAYOUT[^\n]*\n([\s\S]*?)\/\/ END KEYBOARD LAYOUT/);
if (!layoutMatch) throw new Error("KEYBOARD LAYOUT region not found in bridge.swift");

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

check(usLayoutKeyStroke(for: ":").map { $0.key == ";" && $0.shift } == true, "colon is shifted semicolon on the US layout")
check(usLayoutKeyStroke(for: "Q").map { $0.key == "q" && $0.shift } == true, "uppercase letter is shifted")
check(usLayoutKeyStroke(for: "æ") == nil && usLayoutKeyStroke(for: "ab") == nil, "no US key for non-ASCII or multi-character text")
check(physicalKeyStrokeTypes(":", isKeyboardLayout: true, layoutProduces: ":"), "matching layout output allows the physical key")
check(!physicalKeyStrokeTypes(":", isKeyboardLayout: true, layoutProduces: "Æ"), "layout that types another character falls back (#98)")
check(!physicalKeyStrokeTypes("'", isKeyboardLayout: true, layoutProduces: nil), "dead key falls back")
check(!physicalKeyStrokeTypes("a", isKeyboardLayout: false, layoutProduces: "a"), "input method falls back even when the layout matches")

if failures > 0 { exit(1) }
print("macos native pure checks passed")
`;
const layoutMain = `
import Foundation
import Carbon.HIToolbox
var failures = 0
var checked = 0
func check(_ ok: Bool, _ name: String) { if !ok { failures += 1; print("FAIL: \\(name)") } }

func installedSource(_ id: String) -> TISInputSource? {
	let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
	guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource] else { return nil }
	return list.first
}
func layoutData(_ id: String) -> Data? {
	guard let source = installedSource(id), let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
	return Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue() as Data
}
// US virtual key codes, as used by Bridge.keyCode.
let semicolon: UInt16 = 41, slash: UInt16 = 44, minus: UInt16 = 27, keyA: UInt16 = 0, digit1: UInt16 = 18

if let us = layoutData("com.apple.keylayout.US") {
	checked += 1
	check(keyboardLayoutCharacter(layoutData: us, keyCode: semicolon, shift: true) == ":", "US shift+semicolon types a colon")
	check(keyboardLayoutCharacter(layoutData: us, keyCode: slash, shift: false) == "/", "US slash types a slash")
	check(keyboardLayoutCharacter(layoutData: us, keyCode: keyA, shift: true) == "A", "US shift+a types A")
}
if let danish = layoutData("com.apple.keylayout.Danish") {
	checked += 1
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: semicolon, shift: true) != ":", "Danish shift+semicolon is not a colon (#98)")
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: slash, shift: false) != "/", "Danish slash key is not a slash (#98)")
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: minus, shift: false) != "-", "Danish minus key is not a minus (#98)")
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: keyA, shift: false) == "a", "Danish letters still type directly")
}
if let french = layoutData("com.apple.keylayout.French") {
	checked += 1
	check(keyboardLayoutCharacter(layoutData: french, keyCode: keyA, shift: false) != "a", "AZERTY a key types q")
	check(keyboardLayoutCharacter(layoutData: french, keyCode: digit1, shift: false) != "1", "AZERTY digits need Shift")
}
if let pinyin = installedSource("com.apple.inputmethod.SCIM.ITABC"), let type = TISGetInputSourceProperty(pinyin, kTISPropertyInputSourceType) {
	checked += 1
	check((Unmanaged<CFString>.fromOpaque(type).takeUnretainedValue() as String) != (kTISTypeKeyboardLayout as String), "Pinyin is an input method, not a keyboard layout")
}
let active = currentKeyboardInputSource()
check(active.layoutData != nil, "active keyboard layout data is readable")

if failures > 0 { exit(1) }
if checked == 0 { print("FAIL: no reference keyboard layouts installed"); exit(1) }
print("macos keyboard layout checks passed (\\(checked) reference sources)")
`;
const dir = mkdtempSync(path.join(tmpdir(), "pcu-pure-"));
try {
	writeFileSync(path.join(dir, "main.swift"), match[1] + main);
	execFileSync("swiftc", ["-O", "-o", path.join(dir, "t"), path.join(dir, "main.swift")], { stdio: "inherit" });
	process.stdout.write(execFileSync(path.join(dir, "t"), { encoding: "utf8" }));
	writeFileSync(path.join(dir, "layout.swift"), layoutMatch[1] + layoutMain);
	execFileSync("swiftc", ["-O", "-o", path.join(dir, "layout"), path.join(dir, "layout.swift")], { stdio: "inherit" });
	process.stdout.write(execFileSync(path.join(dir, "layout"), { encoding: "utf8" }));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
