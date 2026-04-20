import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

struct BridgeFailure: Error {
	let message: String
	let code: String
}

final class AXRefStore {
	private var nextId: UInt64 = 0
	private var windows: [String: AXUIElement] = [:]
	private var elements: [String: AXUIElement] = [:]

	func storeWindow(_ window: AXUIElement) -> String {
		nextId += 1
		let ref = "w\(nextId)"
		windows[ref] = window
		return ref
	}

	func storeElement(_ element: AXUIElement) -> String {
		nextId += 1
		let ref = "e\(nextId)"
		elements[ref] = element
		return ref
	}

	func window(for ref: String) -> AXUIElement? {
		windows[ref]
	}

	func element(for ref: String) -> AXUIElement? {
		elements[ref]
	}
}

private struct CGWindowCandidate {
	let windowId: UInt32
	let title: String
	let bounds: CGRect
	let isOnscreen: Bool
}

private struct MouseMapping {
	let button: CGMouseButton
	let downType: CGEventType
	let upType: CGEventType
	let buttonNumber: Int64
}

final class Bridge {
	private let refStore = AXRefStore()
	private var stdinBuffer = Data()

	private let keyCodeMap: [String: CGKeyCode] = [
		"A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5,
		"Z": 6, "X": 7, "C": 8, "V": 9, "B": 11,
		"Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
		"1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
		"=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
		"]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35,
		"L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42,
		",": 43, "/": 44, "N": 45, "M": 46, ".": 47, "`": 50,
		"ENTER": 36, "RETURN": 36,
		"TAB": 48,
		"SPACE": 49,
		"DELETE": 51,
		"FORWARD_DELETE": 117,
		"ESCAPE": 53,
		"LEFT": 123,
		"RIGHT": 124,
		"DOWN": 125,
		"UP": 126,
		"HOME": 115,
		"END": 119,
		"PAGEUP": 116,
		"PAGEDOWN": 121,
		"F1": 122,
		"F2": 120,
		"F3": 99,
		"F4": 118,
		"F5": 96,
		"F6": 97,
		"F7": 98,
		"F8": 100,
		"F9": 101,
		"F10": 109,
		"F11": 103,
		"F12": 111,
	]

	func run() {
		while true {
			autoreleasepool {
				let data = FileHandle.standardInput.availableData
				if data.isEmpty {
					exit(0)
				}
				stdinBuffer.append(data)
				processBufferedInput()
			}
		}
	}

	private func processBufferedInput() {
		let newline = Data([0x0A])
		while let range = stdinBuffer.range(of: newline) {
			let lineData = stdinBuffer.subdata(in: 0..<range.lowerBound)
			stdinBuffer.removeSubrange(0..<range.upperBound)

			guard !lineData.isEmpty else { continue }
			guard let line = String(data: lineData, encoding: .utf8) else { continue }
			handleLine(line)
		}
	}

	private func handleLine(_ line: String) {
		let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }

		let fallbackId = "invalid"
		do {
			guard let jsonData = trimmed.data(using: .utf8) else {
				throw BridgeFailure(message: "Input was not valid UTF-8", code: "invalid_request")
			}
			guard let object = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
				throw BridgeFailure(message: "Request must be a JSON object", code: "invalid_request")
			}
			let id = (object["id"] as? String) ?? fallbackId

			do {
				let result = try handleRequest(object)
				send([
					"id": id,
					"ok": true,
					"result": result,
				])
			} catch let failure as BridgeFailure {
				send([
					"id": id,
					"ok": false,
					"error": [
						"message": failure.message,
						"code": failure.code,
					],
				])
			} catch {
				send([
					"id": id,
					"ok": false,
					"error": [
						"message": error.localizedDescription,
						"code": "internal_error",
					],
				])
			}
		} catch let failure as BridgeFailure {
			send([
				"id": fallbackId,
				"ok": false,
				"error": [
					"message": failure.message,
					"code": failure.code,
				],
			])
		} catch {
			send([
				"id": fallbackId,
				"ok": false,
				"error": [
					"message": error.localizedDescription,
					"code": "internal_error",
				],
			])
		}
	}

	private func send(_ payload: [String: Any]) {
		guard JSONSerialization.isValidJSONObject(payload),
			let data = try? JSONSerialization.data(withJSONObject: payload),
			let line = String(data: data, encoding: .utf8)
		else {
			return
		}

		if let out = (line + "\n").data(using: .utf8) {
			FileHandle.standardOutput.write(out)
		}
	}

	private func handleRequest(_ request: [String: Any]) throws -> Any {
		let cmd = try stringArg(request, "cmd")

		switch cmd {
		case "checkPermissions":
			return checkPermissions()
		case "openPermissionPane":
			return try openPermissionPane(request)
		case "listApps":
			return listApps()
		case "listWindows":
			return try listWindows(pid: Int32(try intArg(request, "pid")))
		case "getFrontmost":
			return try getFrontmost()
		case "screenshot":
			return try screenshot(request)
		case "mouseMove":
			return try mouseMove(request)
		case "mouseClick":
			return try mouseClick(request)
		case "axPressAtPoint":
			return try axPressAtPoint(request)
		case "mouseDrag":
			return try mouseDrag(request)
		case "mouseScroll":
			return try mouseScroll(request)
		case "focusedElement":
			return try focusedElement(request)
		case "setValue":
			return try setValue(request)
		case "keypress":
			return try keypress(request)
		case "typeText":
			return try typeText(request)
		case "getClipboard":
			return getClipboard()
		case "setClipboard":
			return try setClipboard(request)
		case "getMousePosition":
			return getMousePosition()
		default:
			throw BridgeFailure(message: "Unknown command '\(cmd)'", code: "unknown_command")
		}
	}

	private func stringArg(_ request: [String: Any], _ key: String) throws -> String {
		if let value = request[key] as? String {
			return value
		}
		throw BridgeFailure(message: "Missing string argument '\(key)'", code: "invalid_args")
	}

	private func intArg(_ request: [String: Any], _ key: String) throws -> Int {
		if let value = request[key] as? Int {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.intValue
		}
		if let value = request[key] as? Double {
			return Int(value)
		}
		throw BridgeFailure(message: "Missing integer argument '\(key)'", code: "invalid_args")
	}

	private func optionalIntArg(_ request: [String: Any], _ key: String) -> Int? {
		if let value = request[key] as? Int {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.intValue
		}
		if let value = request[key] as? Double {
			return Int(value)
		}
		return nil
	}

	private func doubleArg(_ request: [String: Any], _ key: String) throws -> Double {
		if let value = request[key] as? Double {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.doubleValue
		}
		if let value = request[key] as? Int {
			return Double(value)
		}
		throw BridgeFailure(message: "Missing numeric argument '\(key)'", code: "invalid_args")
	}

	private func checkPermissions() -> [String: Any] {
		let accessibility = AXIsProcessTrusted()
		let screenRecording: Bool
		if #available(macOS 10.15, *) {
			screenRecording = CGPreflightScreenCaptureAccess()
		} else {
			screenRecording = true
		}
		return [
			"accessibility": accessibility,
			"screenRecording": screenRecording,
		]
	}

	private func openPermissionPane(_ request: [String: Any]) throws -> [String: Any] {
		let kind = try stringArg(request, "kind")
		let urlString: String
		switch kind {
		case "accessibility":
			urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
		case "screenRecording", "screenrecording":
			urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
		default:
			throw BridgeFailure(message: "Unknown permission pane '\(kind)'", code: "invalid_args")
		}

		guard let url = URL(string: urlString) else {
			throw BridgeFailure(message: "Invalid permission pane URL", code: "internal_error")
		}
		let opened = NSWorkspace.shared.open(url)
		return ["opened": opened]
	}

	private func listApps() -> [[String: Any]] {
		let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
		return apps.map { app in
			var data: [String: Any] = [
				"appName": app.localizedName ?? "Unknown App",
				"pid": Int(app.processIdentifier),
				"isFrontmost": app.processIdentifier == frontmostPid,
			]
			if let bundleId = app.bundleIdentifier {
				data["bundleId"] = bundleId
			}
			return data
		}
	}

	private func getFrontmost() throws -> [String: Any] {
		guard let app = NSWorkspace.shared.frontmostApplication else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		let pid = app.processIdentifier
		let windows = try listWindows(pid: pid)

		var result: [String: Any] = [
			"appName": app.localizedName ?? "Unknown App",
			"pid": Int(pid),
		]
		if let bundleId = app.bundleIdentifier {
			result["bundleId"] = bundleId
		}

		if let chosen = windows.sorted(by: { scoreWindow($0) > scoreWindow($1) }).first {
			result["windowTitle"] = (chosen["title"] as? String) ?? ""
			if let windowId = chosen["windowId"] {
				result["windowId"] = windowId
			}
			if let windowRef = chosen["windowRef"] as? String {
				result["windowRef"] = windowRef
			}
		}
		return result
	}

	private func scoreWindow(_ window: [String: Any]) -> Int {
		var score = 0
		if (window["isFocused"] as? Bool) == true { score += 100 }
		if (window["isMain"] as? Bool) == true { score += 80 }
		if (window["isMinimized"] as? Bool) == false { score += 40 }
		if (window["isOnscreen"] as? Bool) == true { score += 20 }
		if window["windowId"] != nil { score += 10 }
		return score
	}

	private func listWindows(pid: Int32) throws -> [[String: Any]] {
		let appElement = AXUIElementCreateApplication(pid)
		let windows = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		let candidates = cgWindowCandidates(pid: pid)
		var usedIds = Set<UInt32>()

		var output: [[String: Any]] = []
		for window in windows {
			let title = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			let frame = frameForWindow(window)
			let candidate = bestCandidate(frame: frame, title: title, candidates: candidates, usedIds: usedIds)
			if let candidate {
				usedIds.insert(candidate.windowId)
			}

			let windowRef = refStore.storeWindow(window)
			let isMinimized = boolAttribute(window, attribute: kAXMinimizedAttribute as CFString) ?? false
			let isMain = boolAttribute(window, attribute: kAXMainAttribute as CFString) ?? false
			let isFocused = boolAttribute(window, attribute: kAXFocusedAttribute as CFString) ?? false
			let scale = displayScaleFactor(for: frame)

			var item: [String: Any] = [
				"windowRef": windowRef,
				"title": title,
				"framePoints": [
					"x": frame.origin.x,
					"y": frame.origin.y,
					"w": frame.size.width,
					"h": frame.size.height,
				],
				"scaleFactor": scale,
				"isMinimized": isMinimized,
				"isOnscreen": candidate?.isOnscreen ?? !isMinimized,
				"isMain": isMain,
				"isFocused": isFocused,
			]
			if let candidate {
				item["windowId"] = Int(candidate.windowId)
			}
			output.append(item)
		}
		return output
	}

	private func screenshot(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = UInt32(try intArg(request, "windowId"))
		return try captureWindow(windowId: windowId)
	}

	private func mouseMove(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = UInt32(try intArg(request, "windowId"))
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		guard let targetPid = optionalIntArg(request, "pid").map({ Int32($0) }) else {
			throw BridgeFailure(message: "mouseMove requires pid in non-intrusive mode", code: "pid_required")
		}
		let captureWidth = max(1.0, (try? doubleArg(request, "captureWidth")) ?? 1.0)
		let captureHeight = max(1.0, (try? doubleArg(request, "captureHeight")) ?? 1.0)

		let point = try mapWindowPoint(windowId: windowId, x: x, y: y, captureWidth: captureWidth, captureHeight: captureHeight)
		try postMouseMove(to: point, pid: targetPid)
		return ["moved": true]
	}

	private func mouseClick(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = UInt32(try intArg(request, "windowId"))
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		guard let targetPid = optionalIntArg(request, "pid").map({ Int32($0) }) else {
			throw BridgeFailure(message: "mouseClick requires pid in non-intrusive mode", code: "pid_required")
		}
		let clicks = max(1, (try? intArg(request, "clicks")) ?? 1)
		let buttonName = (try? stringArg(request, "button")) ?? "left"
		let captureWidth = max(1.0, (try? doubleArg(request, "captureWidth")) ?? 1.0)
		let captureHeight = max(1.0, (try? doubleArg(request, "captureHeight")) ?? 1.0)

		let point = try mapWindowPoint(windowId: windowId, x: x, y: y, captureWidth: captureWidth, captureHeight: captureHeight)
		try postMouseClick(at: point, buttonName: buttonName, clickCount: clicks, pid: targetPid)
		return ["clicked": true]
	}

	private func axPressAtPoint(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = UInt32(try intArg(request, "windowId"))
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		guard let targetPid = optionalIntArg(request, "pid").map({ Int32($0) }) else {
			throw BridgeFailure(message: "axPressAtPoint requires pid in non-intrusive mode", code: "pid_required")
		}
		let captureWidth = max(1.0, (try? doubleArg(request, "captureWidth")) ?? 1.0)
		let captureHeight = max(1.0, (try? doubleArg(request, "captureHeight")) ?? 1.0)

		let point = try mapWindowPoint(windowId: windowId, x: x, y: y, captureWidth: captureWidth, captureHeight: captureHeight)
		let systemWide = AXUIElementCreateSystemWide()
		var hitElement: AXUIElement?
		let status = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hitElement)
		guard status == .success, let hitElement else {
			return ["pressed": false, "reason": "hit_test_failed"]
		}

		return pressElementOrAncestor(startingAt: hitElement, targetPid: targetPid)
	}

	private func pressElementOrAncestor(startingAt element: AXUIElement, targetPid: Int32) -> [String: Any] {
		var current: AXUIElement? = element
		var depth = 0

		while let candidate = current, depth < 10 {
			if let pid = pidForElement(candidate), pid != targetPid {
				return ["pressed": false, "reason": "pid_mismatch", "ownerPid": Int(pid)]
			}

			if supportsPressAction(candidate) {
				let actionStatus = AXUIElementPerformAction(candidate, kAXPressAction as CFString)
				if actionStatus == .success {
					return ["pressed": true]
				}
			}

			current = parentElement(candidate)
			depth += 1
		}

		return ["pressed": false, "reason": "no_press_action"]
	}

	private func pidForElement(_ element: AXUIElement) -> Int32? {
		var pid: pid_t = 0
		let status = AXUIElementGetPid(element, &pid)
		guard status == .success else { return nil }
		return Int32(pid)
	}

	private func parentElement(_ element: AXUIElement) -> AXUIElement? {
		guard let value = copyAttribute(element, attribute: kAXParentAttribute as CFString) else {
			return nil
		}
		return asAXElement(value)
	}

	private func supportsPressAction(_ element: AXUIElement) -> Bool {
		var actionsValue: CFArray?
		let status = AXUIElementCopyActionNames(element, &actionsValue)
		guard status == .success else { return false }
		guard let actionsArray = actionsValue as? [AnyObject] else { return false }
		let actionNames = actionsArray.compactMap { $0 as? String }
		return actionNames.contains(kAXPressAction as String)
	}

	private func mouseDrag(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = UInt32(try intArg(request, "windowId"))
		guard let targetPid = optionalIntArg(request, "pid").map({ Int32($0) }) else {
			throw BridgeFailure(message: "mouseDrag requires pid in non-intrusive mode", code: "pid_required")
		}
		guard let path = request["path"] as? [[String: Any]], path.count >= 2 else {
			throw BridgeFailure(message: "mouseDrag requires path with at least two points", code: "invalid_args")
		}
		let captureWidth = max(1.0, (try? doubleArg(request, "captureWidth")) ?? 1.0)
		let captureHeight = max(1.0, (try? doubleArg(request, "captureHeight")) ?? 1.0)

		let points = try path.map { point -> CGPoint in
			guard let x = number(point["x"]), let y = number(point["y"]) else {
				throw BridgeFailure(message: "mouseDrag path points must include x and y", code: "invalid_args")
			}
			return try mapWindowPoint(windowId: windowId, x: x, y: y, captureWidth: captureWidth, captureHeight: captureHeight)
		}

		try postMouseDrag(points: points, pid: targetPid)
		return ["dragged": true]
	}

	private func mouseScroll(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = UInt32(try intArg(request, "windowId"))
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		guard let targetPid = optionalIntArg(request, "pid").map({ Int32($0) }) else {
			throw BridgeFailure(message: "mouseScroll requires pid in non-intrusive mode", code: "pid_required")
		}
		let scrollX = Int32(try doubleArg(request, "scrollX"))
		let scrollY = Int32(try doubleArg(request, "scrollY"))
		let captureWidth = max(1.0, (try? doubleArg(request, "captureWidth")) ?? 1.0)
		let captureHeight = max(1.0, (try? doubleArg(request, "captureHeight")) ?? 1.0)

		let point = try mapWindowPoint(windowId: windowId, x: x, y: y, captureWidth: captureWidth, captureHeight: captureHeight)
		try postMouseMove(to: point, pid: targetPid)
		try postMouseScroll(scrollX: scrollX, scrollY: scrollY, pid: targetPid)
		return ["scrolled": true]
	}

	private func focusedElement(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let app = AXUIElementCreateApplication(pid)
		guard let focusedValue = copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString),
			let element = asAXElement(focusedValue)
		else {
			return ["exists": false]
		}

		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"

		var settable = DarwinBoolean(false)
		let settableStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
		let canSetValue = settableStatus == .success && settable.boolValue

		let textRoles: Set<String> = [
			"AXTextField",
			"AXTextArea",
			"AXTextView",
			"AXSearchField",
			"AXComboBox",
			"AXEditableText",
			"AXSecureTextField",
		]

		let isTextInput = textRoles.contains(role) || canSetValue
		let elementRef = refStore.storeElement(element)

		return [
			"exists": true,
			"elementRef": elementRef,
			"role": role,
			"subrole": subrole,
			"isTextInput": isTextInput,
			"isSecure": secure,
			"canSetValue": canSetValue,
		]
	}

	private func setValue(_ request: [String: Any]) throws -> [String: Any] {
		let elementRef = try stringArg(request, "elementRef")
		let value = try stringArg(request, "value")
		guard let element = refStore.element(for: elementRef) else {
			throw BridgeFailure(message: "Element reference is no longer valid", code: "element_ref_invalid")
		}

		let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
		if status != .success {
			throw BridgeFailure(message: "Failed to set value (AX error \(status.rawValue))", code: "set_value_failed")
		}
		return ["set": true]
	}

	private func keypress(_ request: [String: Any]) throws -> [String: Any] {
		guard let keys = request["keys"] as? [String], !keys.isEmpty else {
			throw BridgeFailure(message: "keypress requires non-empty keys array", code: "invalid_args")
		}
		guard let targetPid = optionalIntArg(request, "pid").map({ Int32($0) }) else {
			throw BridgeFailure(message: "keypress requires pid in non-intrusive mode", code: "pid_required")
		}

		var flags: CGEventFlags = []
		var primary: String?

		for token in keys.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }) {
			switch token {
			case "CMD", "COMMAND", "META":
				flags.insert(.maskCommand)
			case "CTRL", "CONTROL":
				flags.insert(.maskControl)
			case "ALT", "OPTION", "OPT":
				flags.insert(.maskAlternate)
			case "SHIFT":
				flags.insert(.maskShift)
			case "FN":
				flags.insert(.maskSecondaryFn)
			default:
				primary = token
			}
		}

		guard let primary else {
			throw BridgeFailure(message: "keypress requires a non-modifier key", code: "invalid_args")
		}

		if let keyCode = keyCodeMap[primary] {
			try postKeyEvent(keyCode: keyCode, flags: flags, pid: targetPid)
		} else if primary.count == 1 {
			try postUnicodeText(primary, flags: flags, pid: targetPid)
		} else {
			throw BridgeFailure(message: "Unsupported key '\(primary)'", code: "invalid_args")
		}

		return ["pressed": true]
	}

	private func typeText(_ request: [String: Any]) throws -> [String: Any] {
		let text = try stringArg(request, "text")
		guard let targetPid = optionalIntArg(request, "pid").map({ Int32($0) }) else {
			throw BridgeFailure(message: "typeText requires pid in non-intrusive mode", code: "pid_required")
		}
		try postUnicodeText(text, flags: [], pid: targetPid)
		return ["typed": true]
	}

	private func getClipboard() -> [String: Any] {
		let value = NSPasteboard.general.string(forType: .string) ?? ""
		return ["value": value]
	}

	private func setClipboard(_ request: [String: Any]) throws -> [String: Any] {
		let value = try stringArg(request, "value")
		let pasteboard = NSPasteboard.general
		pasteboard.clearContents()
		let written = pasteboard.setString(value, forType: .string)
		return ["set": written]
	}

	private func getMousePosition() -> [String: Any] {
		let position = NSEvent.mouseLocation
		return ["x": position.x, "y": position.y]
	}

	private func copyAttribute(_ element: AXUIElement, attribute: CFString) -> AnyObject? {
		var value: AnyObject?
		let status = AXUIElementCopyAttributeValue(element, attribute, &value)
		guard status == .success else { return nil }
		return value
	}

	private func boolAttribute(_ element: AXUIElement, attribute: CFString) -> Bool? {
		guard let value = copyAttribute(element, attribute: attribute) else { return nil }
		if let boolValue = value as? Bool {
			return boolValue
		}
		if let number = value as? NSNumber {
			return number.boolValue
		}
		return nil
	}

	private func stringAttribute(_ element: AXUIElement, attribute: CFString) -> String? {
		copyAttribute(element, attribute: attribute) as? String
	}

	private func axElementArray(_ element: AXUIElement, attribute: CFString) -> [AXUIElement] {
		guard let value = copyAttribute(element, attribute: attribute) else { return [] }
		if let array = value as? [AXUIElement] {
			return array
		}
		if let anyArray = value as? [AnyObject] {
			return anyArray.compactMap(asAXElement)
		}
		return []
	}

	private func asAXElement(_ value: AnyObject) -> AXUIElement? {
		let cfValue = value as CFTypeRef
		guard CFGetTypeID(cfValue) == AXUIElementGetTypeID() else { return nil }
		return unsafeBitCast(cfValue, to: AXUIElement.self)
	}

	private func pointAttribute(_ element: AXUIElement, attribute: CFString) -> CGPoint? {
		guard let value = copyAttribute(element, attribute: attribute) else { return nil }
		let cfValue = value as CFTypeRef
		guard CFGetTypeID(cfValue) == AXValueGetTypeID() else { return nil }
		let axValue = unsafeBitCast(cfValue, to: AXValue.self)
		guard AXValueGetType(axValue) == .cgPoint else { return nil }
		var point = CGPoint.zero
		guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
		return point
	}

	private func sizeAttribute(_ element: AXUIElement, attribute: CFString) -> CGSize? {
		guard let value = copyAttribute(element, attribute: attribute) else { return nil }
		let cfValue = value as CFTypeRef
		guard CFGetTypeID(cfValue) == AXValueGetTypeID() else { return nil }
		let axValue = unsafeBitCast(cfValue, to: AXValue.self)
		guard AXValueGetType(axValue) == .cgSize else { return nil }
		var size = CGSize.zero
		guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
		return size
	}

	private func frameForWindow(_ window: AXUIElement) -> CGRect {
		let origin = pointAttribute(window, attribute: kAXPositionAttribute as CFString) ?? .zero
		let size = sizeAttribute(window, attribute: kAXSizeAttribute as CFString) ?? .zero
		return CGRect(origin: origin, size: size)
	}

	private func cgWindowCandidates(pid: Int32) -> [CGWindowCandidate] {
		guard let entries = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
			return []
		}

		var candidates: [CGWindowCandidate] = []
		for entry in entries {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
				ownerPid == pid
			else {
				continue
			}
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != 0 { continue }

			guard let windowNumber = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else {
				continue
			}
			guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
			else {
				continue
			}

			let title = (entry[kCGWindowName as String] as? String) ?? ""
			let isOnscreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true
			candidates.append(
				CGWindowCandidate(
					windowId: windowNumber,
					title: title,
					bounds: bounds,
					isOnscreen: isOnscreen
				)
			)
		}
		return candidates
	}

	private func bestCandidate(
		frame: CGRect,
		title: String,
		candidates: [CGWindowCandidate],
		usedIds: Set<UInt32>
	) -> CGWindowCandidate? {
		var best: (candidate: CGWindowCandidate, score: Double)?
		let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

		for candidate in candidates where !usedIds.contains(candidate.windowId) {
			var score = 0.0
			let candidateTitle = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
			if !normalizedTitle.isEmpty {
				if candidateTitle == normalizedTitle {
					score += 100
				} else if candidateTitle.contains(normalizedTitle) {
					score += 50
				}
			}

			let dx = abs(candidate.bounds.origin.x - frame.origin.x)
			let dy = abs(candidate.bounds.origin.y - frame.origin.y)
			let dw = abs(candidate.bounds.size.width - frame.size.width)
			let dh = abs(candidate.bounds.size.height - frame.size.height)
			score -= Double(dx + dy + dw + dh) / 20.0

			if let currentBest = best {
				if score > currentBest.score {
					best = (candidate, score)
				}
			} else {
				best = (candidate, score)
			}
		}

		return best?.candidate
	}

	private func displayScaleFactor(for frame: CGRect) -> Double {
		var displayCount: UInt32 = 0
		guard CGGetOnlineDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
			return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
		}

		var displays = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
		guard CGGetOnlineDisplayList(displayCount, &displays, &displayCount) == .success else {
			return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
		}

		var chosenDisplay: CGDirectDisplayID?
		var chosenArea: CGFloat = -1
		for display in displays {
			let bounds = CGDisplayBounds(display)
			let overlap = bounds.intersection(frame)
			let area = overlap.isNull ? 0 : overlap.width * overlap.height
			if area > chosenArea {
				chosenArea = area
				chosenDisplay = display
			}
		}

		guard let display = chosenDisplay, let mode = CGDisplayCopyDisplayMode(display) else {
			return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
		}

		let width = Double(mode.width)
		guard width > 0 else { return 1.0 }
		let scale = Double(mode.pixelWidth) / width
		return scale > 0 ? scale : 1.0
	}

	private func captureWindow(windowId: UInt32) throws -> [String: Any] {
		guard #available(macOS 14.0, *) else {
			throw BridgeFailure(message: "Window capture requires macOS 14+", code: "unsupported_os")
		}

		let semaphore = DispatchSemaphore(value: 0)
		var capturedImage: CGImage?
		var capturedError: Error?

		let task = Task {
			defer { semaphore.signal() }
			do {
				if Task.isCancelled {
					return
				}
				let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
				guard let window = shareable.windows.first(where: { $0.windowID == windowId }) else {
					throw BridgeFailure(message: "Window \(windowId) is not available for capture", code: "window_not_found")
				}

				let filter = SCContentFilter(desktopIndependentWindow: window)
				let config = SCStreamConfiguration()
				config.showsCursor = false
				if #available(macOS 14.0, *) {
					config.ignoreShadowsSingleWindow = true
				}

				let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
				capturedImage = image
			} catch {
				capturedError = error
			}
		}

		if semaphore.wait(timeout: .now() + .seconds(12)) == .timedOut {
			task.cancel()
			throw BridgeFailure(message: "Screenshot timed out while capturing window \(windowId)", code: "screenshot_timeout")
		}

		if let error = capturedError {
			if let failure = error as? BridgeFailure {
				throw failure
			}
			throw BridgeFailure(message: "Screenshot failed: \(error.localizedDescription)", code: "screenshot_failed")
		}

		guard let image = capturedImage else {
			throw BridgeFailure(message: "Screenshot failed", code: "screenshot_failed")
		}

		guard let pngData = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
			throw BridgeFailure(message: "Failed to encode screenshot as PNG", code: "encoding_failed")
		}

		let bounds = currentWindowBounds(windowId: windowId)
		let scale = bounds.map { displayScaleFactor(for: $0) } ?? 1.0

		return [
			"pngBase64": pngData.base64EncodedString(),
			"width": image.width,
			"height": image.height,
			"scaleFactor": scale,
		]
	}

	private func currentWindowBounds(windowId: UInt32) -> CGRect? {
		if #available(macOS 14.0, *), let scBounds = currentWindowBoundsViaScreenCaptureKit(windowId: windowId) {
			return scBounds
		}

		guard let descriptions = CGWindowListCreateDescriptionFromArray([NSNumber(value: windowId)] as CFArray) as? [[String: Any]],
			let first = descriptions.first,
			let boundsDict = first[kCGWindowBounds as String] as? [String: Any],
			let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
		else {
			return nil
		}
		return bounds
	}

	@available(macOS 14.0, *)
	private func currentWindowBoundsViaScreenCaptureKit(windowId: UInt32) -> CGRect? {
		let semaphore = DispatchSemaphore(value: 0)
		var output: CGRect?

		let task = Task {
			defer { semaphore.signal() }
			do {
				if Task.isCancelled {
					return
				}
				let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
				if let window = shareable.windows.first(where: { $0.windowID == windowId }) {
					output = window.frame
				}
			} catch {
				output = nil
			}
		}

		if semaphore.wait(timeout: .now() + .seconds(2)) == .timedOut {
			task.cancel()
			return nil
		}
		return output
	}

	private func mapWindowPoint(
		windowId: UInt32,
		x: Double,
		y: Double,
		captureWidth: Double,
		captureHeight: Double
	) throws -> CGPoint {
		guard let bounds = currentWindowBounds(windowId: windowId) else {
			throw BridgeFailure(message: "Target window is no longer available", code: "window_not_found")
		}

		let relX = min(max(x / captureWidth, 0), 1)
		let relY = min(max(y / captureHeight, 0), 1)
		let screenX = bounds.origin.x + bounds.size.width * relX
		let screenY = bounds.origin.y + bounds.size.height * relY
		return CGPoint(x: screenX, y: screenY)
	}

	private func mouseMapping(for buttonName: String) throws -> MouseMapping {
		switch buttonName.lowercased() {
		case "left":
			return MouseMapping(button: .left, downType: .leftMouseDown, upType: .leftMouseUp, buttonNumber: 0)
		case "right":
			return MouseMapping(button: .right, downType: .rightMouseDown, upType: .rightMouseUp, buttonNumber: 1)
		case "wheel", "middle":
			return MouseMapping(button: .center, downType: .otherMouseDown, upType: .otherMouseUp, buttonNumber: 2)
		case "back":
			return MouseMapping(button: .center, downType: .otherMouseDown, upType: .otherMouseUp, buttonNumber: 3)
		case "forward":
			return MouseMapping(button: .center, downType: .otherMouseDown, upType: .otherMouseUp, buttonNumber: 4)
		default:
			throw BridgeFailure(message: "Unsupported mouse button '\(buttonName)'", code: "invalid_args")
		}
	}

	private func postEvent(_ event: CGEvent, pid: Int32) {
		event.postToPid(pid)
	}

	private func postMouseMove(to point: CGPoint, pid: Int32) throws {
		guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
			throw BridgeFailure(message: "Failed to create mouse move event", code: "input_failed")
		}
		postEvent(move, pid: pid)
	}

	private func postMouseClick(at point: CGPoint, buttonName: String, clickCount: Int, pid: Int32) throws {
		let mapping = try mouseMapping(for: buttonName)
		try postMouseMove(to: point, pid: pid)

		for _ in 0..<max(1, clickCount) {
			guard let down = CGEvent(
				mouseEventSource: nil,
				mouseType: mapping.downType,
				mouseCursorPosition: point,
				mouseButton: mapping.button
			), let up = CGEvent(
				mouseEventSource: nil,
				mouseType: mapping.upType,
				mouseCursorPosition: point,
				mouseButton: mapping.button
			) else {
				throw BridgeFailure(message: "Failed to create mouse click event", code: "input_failed")
			}

			down.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
			up.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
			down.setIntegerValueField(.mouseEventButtonNumber, value: mapping.buttonNumber)
			up.setIntegerValueField(.mouseEventButtonNumber, value: mapping.buttonNumber)

			postEvent(down, pid: pid)
			usleep(12_000)
			postEvent(up, pid: pid)
			usleep(45_000)
		}
	}

	private func postMouseDrag(points: [CGPoint], pid: Int32) throws {
		guard let first = points.first, let last = points.last else {
			throw BridgeFailure(message: "Drag path is empty", code: "invalid_args")
		}

		guard let down = CGEvent(
			mouseEventSource: nil,
			mouseType: .leftMouseDown,
			mouseCursorPosition: first,
			mouseButton: .left
		) else {
			throw BridgeFailure(message: "Failed to start drag", code: "input_failed")
		}
		postEvent(down, pid: pid)
		usleep(12_000)

		for point in points.dropFirst() {
			guard let drag = CGEvent(
				mouseEventSource: nil,
				mouseType: .leftMouseDragged,
				mouseCursorPosition: point,
				mouseButton: .left
			) else {
				throw BridgeFailure(message: "Failed during drag", code: "input_failed")
			}
			postEvent(drag, pid: pid)
			usleep(8_000)
		}

		guard let up = CGEvent(
			mouseEventSource: nil,
			mouseType: .leftMouseUp,
			mouseCursorPosition: last,
			mouseButton: .left
		) else {
			throw BridgeFailure(message: "Failed to finish drag", code: "input_failed")
		}
		postEvent(up, pid: pid)
	}

	private func postMouseScroll(scrollX: Int32, scrollY: Int32, pid: Int32) throws {
		if let event = CGEvent(
			scrollWheelEvent2Source: nil,
			units: .pixel,
			wheelCount: 2,
			wheel1: scrollY,
			wheel2: scrollX,
			wheel3: 0
		) {
			postEvent(event, pid: pid)
			return
		}

		if let fallback = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: scrollY, wheel2: 0, wheel3: 0) {
			postEvent(fallback, pid: pid)
			return
		}

		throw BridgeFailure(message: "Failed to create scroll event", code: "input_failed")
	}

	private func postKeyEvent(keyCode: CGKeyCode, flags: CGEventFlags, pid: Int32) throws {
		guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
			let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
		else {
			throw BridgeFailure(message: "Failed to create key event", code: "input_failed")
		}

		down.flags = flags
		up.flags = flags
		postEvent(down, pid: pid)
		usleep(10_000)
		postEvent(up, pid: pid)
	}

	private func postUnicodeText(_ text: String, flags: CGEventFlags, pid: Int32) throws {
		for scalar in text.unicodeScalars {
			let char = String(scalar)
			guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
				let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
			else {
				throw BridgeFailure(message: "Failed to create unicode key event", code: "input_failed")
			}

			down.flags = flags
			up.flags = flags
			setUnicodeString(event: down, text: char)
			setUnicodeString(event: up, text: char)
			postEvent(down, pid: pid)
			usleep(8_000)
			postEvent(up, pid: pid)
		}
	}

	private func setUnicodeString(event: CGEvent, text: String) {
		var utf16 = Array(text.utf16)
		utf16.withUnsafeMutableBufferPointer { buffer in
			guard let base = buffer.baseAddress else { return }
			event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
		}
	}

	private func number(_ value: Any?) -> Double? {
		if let number = value as? NSNumber {
			return number.doubleValue
		}
		if let value = value as? Double {
			return value
		}
		if let value = value as? Int {
			return Double(value)
		}
		return nil
	}
}

let bridge = Bridge()
bridge.run()
