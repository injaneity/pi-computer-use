import Foundation
import AppKit
import ApplicationServices
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

struct BridgeFailure: Error {
	let message: String
	let code: String
}

final class AXRefStore {
	struct Snapshot {
		let role: String
		let identifier: String
		let label: String
		let rect: CGRect
	}

	private var nextId: UInt64 = 0
	private var windows: [String: AXUIElement] = [:]
	private var elements: [String: AXUIElement] = [:]
	private var snapshots: [String: Snapshot] = [:]
	private let lock = NSLock()

	func storeWindow(_ window: AXUIElement) -> String {
		lock.lock()
		defer { lock.unlock() }
		for (ref, existing) in windows {
			if CFEqual(existing, window) {
				return ref
			}
		}
		nextId += 1
		let ref = "w\(nextId)"
		windows[ref] = window
		return ref
	}

	func storeElement(_ element: AXUIElement, snapshot: Snapshot? = nil) -> String {
		lock.lock()
		defer { lock.unlock() }
		nextId += 1
		let ref = "e\(nextId)"
		elements[ref] = element
		snapshots[ref] = snapshot
		return ref
	}

	func window(for ref: String) -> AXUIElement? {
		lock.lock()
		defer { lock.unlock() }
		return windows[ref]
	}

	func element(for ref: String) -> AXUIElement? {
		lock.lock()
		defer { lock.unlock() }
		return elements[ref]
	}

	func snapshot(for ref: String) -> Snapshot? {
		lock.lock()
		defer { lock.unlock() }
		return snapshots[ref]
	}
}

private struct CGWindowCandidate {
	let windowId: UInt32
	let title: String
	let bounds: CGRect
	let isOnscreen: Bool
	let layer: Int
	let zOrder: Int
}

private struct CGWindowOwnerSummary {
	let pid: Int32
	let name: String
}

private struct AXDescendant {
	let element: AXUIElement
	let depth: Int
	let insideWebArea: Bool
	let axVisible: Bool
}

private struct WindowPairing {
	let candidate: CGWindowCandidate?
	let score: Double
	let confidence: String
}

private struct CapturedWindowImage {
	let image: CGImage
	let windowId: UInt32
	let frame: CGRect
}

private struct LookRecord {
	let lookId: String
	let windowId: UInt32
	let windowFrame: CGRect
	let imageWidth: Int
	let imageHeight: Int
	let hasImage: Bool
}

private struct RootAXEvent {
	let sequence: UInt64
	let timestamp: TimeInterval
	let notification: String
	let element: AXUIElement?
}

private final class RootAXObserverState {
	let pid: Int32
	let observer: AXObserver
	let change = NSCondition()
	var changeGeneration: UInt64 = 0
	var events: [RootAXEvent] = []
	var nextSequence: UInt64 = 1
	var lastUsed: TimeInterval = Date().timeIntervalSince1970

	init(pid: Int32, observer: AXObserver) {
		self.pid = pid
		self.observer = observer
	}
}

private struct OCRBox {
	let string: String
	let confidence: Double
	let rect: CGRect
}

final class LookNode {
	let element: AXUIElement?
	let ref: String
	let role: String
	let subrole: String
	let identifier: String
	let title: String
	let description: String
	let value: String
	let actions: [String]
	let canPress: Bool
	let canFocus: Bool
	let canSetValue: Bool
	let canScroll: Bool
	let canIncrement: Bool
	let canDecrement: Bool
	let isTextInput: Bool
	let rect: CGRect
	let focused: Bool
	var offscreen: Bool
	var pictureOnly: Bool
	var truncated: Bool
	var scrollExtent: [String: Int]?
	var text: [[String: Any]]
	var children: [LookNode]

	init(element: AXUIElement?, ref: String, role: String, subrole: String, identifier: String, title: String, description: String, value: String, actions: [String], canPress: Bool, canFocus: Bool, canSetValue: Bool, canScroll: Bool, canIncrement: Bool, canDecrement: Bool, isTextInput: Bool, rect: CGRect, focused: Bool = false, offscreen: Bool = false, pictureOnly: Bool = false) {
		self.element = element
		self.ref = ref
		self.role = role
		self.subrole = subrole
		self.identifier = identifier
		self.title = title
		self.description = description
		self.value = value
		self.actions = actions
		self.canPress = canPress
		self.canFocus = canFocus
		self.canSetValue = canSetValue
		self.canScroll = canScroll
		self.canIncrement = canIncrement
		self.canDecrement = canDecrement
		self.isTextInput = isTextInput
		self.rect = rect
		self.focused = focused
		self.offscreen = offscreen
		self.pictureOnly = pictureOnly
		self.truncated = false
		self.text = []
		self.children = []
	}

	func payload() -> [String: Any] {
		var output: [String: Any] = [
			"ref": ref,
			"role": role,
			"subrole": subrole,
			"identifier": identifier,
			"title": title,
			"description": description,
			"value": value,
			"actions": actions,
			"canPress": canPress,
			"canFocus": canFocus,
			"canSetValue": canSetValue,
			"canScroll": canScroll,
			"canIncrement": canIncrement,
			"canDecrement": canDecrement,
			"isTextInput": isTextInput,
			"rect": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height],
			"children": children.map { $0.payload() },
		]
		if focused { output["focused"] = true }
		if offscreen { output["offscreen"] = true }
		if pictureOnly { output["pictureOnly"] = true }
		if truncated { output["truncated"] = true }
		if let scrollExtent { output["scrollExtent"] = scrollExtent }
		if !text.isEmpty { output["text"] = text }
		return output
	}

}

final class Box<T> {
	var value: T
	init(_ value: T) {
		self.value = value
	}
}

final class InputSuppressionGuard {
	static let maxSuppressionSeconds: TimeInterval = 30

	private let lock = NSLock()
	private var eventTap: CFMachPort?
	private var eventTapSource: CFRunLoopSource?
	private var tapRunLoop: CFRunLoop?
	private var tapThread: Thread?

	func begin() throws {
		lock.lock()
		if eventTap != nil {
			lock.unlock()
			return
		}
		lock.unlock()

		let eventTypes: [CGEventType] = [
			.keyDown,
			.keyUp,
			.flagsChanged,
			.leftMouseDown,
			.leftMouseUp,
			.rightMouseDown,
			.rightMouseUp,
			.otherMouseDown,
			.otherMouseUp,
			.mouseMoved,
			.leftMouseDragged,
			.rightMouseDragged,
			.otherMouseDragged,
			.scrollWheel,
			.tabletPointer,
			.tabletProximity,
		]
		let mask = eventTypes.reduce(CGEventMask(0)) { partial, type in
			partial | (CGEventMask(1) << CGEventMask(type.rawValue))
		}

		let callback: CGEventTapCallBack = { _proxy, type, event, userInfo in
			guard let userInfo else { return Unmanaged.passUnretained(event) }
			let inputGuard = Unmanaged<InputSuppressionGuard>.fromOpaque(userInfo).takeUnretainedValue()
			if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
				inputGuard.reenableTap()
				return Unmanaged.passUnretained(event)
			}
			return nil
		}

		guard let tap = CGEvent.tapCreate(
			tap: .cgSessionEventTap,
			place: .headInsertEventTap,
			options: .defaultTap,
			eventsOfInterest: mask,
			callback: callback,
			// passUnretained is only safe because Bridge owns this guard for the
			// whole process lifetime; do not give it a shorter-lived owner.
			userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		) else {
			throw BridgeFailure(message: "Failed to create input suppression event tap", code: "input_suppression_unavailable")
		}

		lock.lock()
		eventTap = tap
		lock.unlock()
		let thread = Thread { [weak self] in
			guard let self else { return }
			let runLoop = CFRunLoopGetCurrent()
			self.lock.lock()
			self.tapRunLoop = runLoop
			self.eventTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
			if let source = self.eventTapSource {
				CFRunLoopAddSource(runLoop, source, .commonModes)
			}
			// Watchdog: if end() never arrives (e.g. the parent process hangs
			// mid-action), release the tap so the user is not locked out of
			// keyboard and mouse input indefinitely.
			let watchdog = CFRunLoopTimerCreateWithHandler(
				kCFAllocatorDefault,
				CFAbsoluteTimeGetCurrent() + InputSuppressionGuard.maxSuppressionSeconds,
				0,
				0,
				0
			) { [weak self] _ in
				self?.end()
			}
			if let watchdog {
				CFRunLoopAddTimer(runLoop, watchdog, .commonModes)
			}
			CGEvent.tapEnable(tap: tap, enable: true)
			self.lock.unlock()
			CFRunLoopRun()
		}
		thread.name = "pi-computer-use-input-suppression"
		lock.lock()
		tapThread = thread
		lock.unlock()
		thread.start()

		let deadline = Date().addingTimeInterval(1.0)
		while tapRunLoop == nil && Date() < deadline {
			Thread.sleep(forTimeInterval: 0.01)
		}
		if tapRunLoop == nil {
			end()
			throw BridgeFailure(message: "Timed out starting input suppression", code: "input_suppression_timeout")
		}
	}

	func end() {
		lock.lock()
		let tap = eventTap
		let source = eventTapSource
		let runLoop = tapRunLoop
		eventTap = nil
		eventTapSource = nil
		tapRunLoop = nil
		tapThread = nil
		lock.unlock()

		if let tap {
			CGEvent.tapEnable(tap: tap, enable: false)
		}
		if let source, let runLoop {
			CFRunLoopRemoveSource(runLoop, source, .commonModes)
			CFRunLoopStop(runLoop)
		}
	}

	func reenableTap() {
		lock.lock()
		let tap = eventTap
		lock.unlock()
		if let tap {
			CGEvent.tapEnable(tap: tap, enable: true)
		}
	}

}

final class Bridge {
	private let protocolVersion = 6
	private let refStore = AXRefStore()
	private let inputSuppressionGuard = InputSuppressionGuard()
	private let physicalInputLock = NSRecursiveLock()
	private let supportsAgentCursor = CommandLine.arguments.contains("serve")
	private let browserBundleIds: Set<String> = [
		"com.apple.Safari", "com.google.Chrome", "org.chromium.Chromium", "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "net.imput.helium", "org.mozilla.firefox",
	]
	private var enhancedAccessibilityPids = Set<Int32>()
	private let enhancedAccessibilityLock = NSLock()
	private var stdinBuffer = Data()
	private var output = FileHandle.standardOutput
	private var nextLookId: UInt64 = 0
	private var lookRecords: [String: LookRecord] = [:]
	private var lookRecordOrder: [String] = []
	private let lookRecordLock = NSLock()
	private let rootObserverLock = NSLock()
	private var rootObservers: [Int32: RootAXObserverState] = [:]
	private let maxRootObservers = 4
	private let permissionCacheLock = NSLock()
	private var grantedPermissionStatus: [String: Any]?

	func run() {
		if CommandLine.arguments.contains("serve") {
			let socketPath = argumentValue("--socket") ?? defaultSocketPath()
			Thread.detachNewThread { [self] in runServer(socketPath: socketPath) }
			NSApp.run()
			return
		}
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

	private func argumentValue(_ name: String) -> String? {
		guard let index = CommandLine.arguments.firstIndex(of: name), CommandLine.arguments.indices.contains(index + 1) else { return nil }
		return CommandLine.arguments[index + 1]
	}

	private func defaultSocketPath() -> String {
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		return "\(home)/Library/Caches/pi-computer-use/bridge.sock"
	}

	private func runServer(socketPath: String) {
		try? FileManager.default.createDirectory(atPath: (socketPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
		// LaunchServices may race multiple `open -n` requests while the first
		// daemon is still binding. Keep process ownership separate from socket
		// cleanup so a late launcher can never unlink the live daemon's socket.
		let lockPath = "\(socketPath).lock"
		let lockFile = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
		if lockFile < 0 || flock(lockFile, LOCK_EX | LOCK_NB) != 0 {
			if lockFile >= 0 { close(lockFile) }
			exit(0)
		}
		unlink(socketPath)
		let server = socket(AF_UNIX, SOCK_STREAM, 0)
		if server < 0 { close(lockFile); exit(1) }
		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let sunPathCapacity = MemoryLayout.size(ofValue: address.sun_path)
		let bytes = Array(socketPath.utf8.prefix(sunPathCapacity - 1))
		withUnsafeMutablePointer(to: &address.sun_path) { pointer in
			pointer.withMemoryRebound(to: CChar.self, capacity: sunPathCapacity) { dest in
				for (index, byte) in bytes.enumerated() { dest[index] = CChar(bitPattern: byte) }
			}
		}
		let bindStatus = withUnsafePointer(to: &address) { pointer in
			pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
		}
		if bindStatus != 0 || listen(server, 8) != 0 { close(server); close(lockFile); exit(1) }
		while true {
			let client = accept(server, nil, nil)
			if client < 0 { continue }
			Thread.detachNewThread { [weak self] in self?.processClient(client) }
		}
	}

	private func processClient(_ client: Int32) {
		let clientOutput = FileHandle(fileDescriptor: client, closeOnDealloc: true)
		var buffer = Data()
		let newline = Data([0x0A])
		while true {
			let data = clientOutput.availableData
			if data.isEmpty { break }
			buffer.append(data)
			while let range = buffer.range(of: newline) {
				let lineData = buffer.subdata(in: 0..<range.lowerBound)
				buffer.removeSubrange(0..<range.upperBound)
				if let line = String(data: lineData, encoding: .utf8), !line.isEmpty { handleLine(line, to: clientOutput) }
			}
		}
		clientOutput.closeFile()
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

	private func handleLine(_ line: String, to responseOutput: FileHandle? = nil) {
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
				], to: responseOutput)
			} catch let failure as BridgeFailure {
				send([
					"id": id,
					"ok": false,
					"error": [
						"message": failure.message,
						"code": failure.code,
					],
				], to: responseOutput)
			} catch {
				send([
					"id": id,
					"ok": false,
					"error": [
						"message": error.localizedDescription,
						"code": "internal_error",
					],
				], to: responseOutput)
			}
		} catch let failure as BridgeFailure {
			send([
				"id": fallbackId,
				"ok": false,
				"error": [
					"message": failure.message,
					"code": failure.code,
				],
			], to: responseOutput)
		} catch {
			send([
				"id": fallbackId,
				"ok": false,
				"error": [
					"message": error.localizedDescription,
					"code": "internal_error",
				],
			], to: responseOutput)
		}
	}

	private func send(_ payload: [String: Any], to responseOutput: FileHandle? = nil) {
		guard JSONSerialization.isValidJSONObject(payload),
			let data = try? JSONSerialization.data(withJSONObject: payload),
			let line = String(data: data, encoding: .utf8)
		else {
			return
		}

		if let out = (line + "\n").data(using: .utf8) {
			(responseOutput ?? output).write(out)
		}
	}

	private func handleRequest(_ request: [String: Any]) throws -> Any {
		let cmd = try stringArg(request, "cmd")

		switch cmd {
		case "diagnostics":
			return diagnostics()
		case "checkPermissions":
			return checkPermissions()
		case "registerPermissions":
			return try registerPermissions()
		case "openPermissionPane":
			return try openPermissionPane(request)
		case "shutdown":
			// Reply first, then exit: the caller relaunches the helper to get a
			// process with a fresh TCC client (grant answers are cached per
			// process, so a helper that saw "denied" keeps answering "denied"
			// after the user grants — only a new process re-queries tccd).
			// Background queue: the serve loop occupies the main thread, so a
			// main-queue timer would never fire.
			DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { exit(0) }
			return ["shuttingDown": true]
		case "listApps":
			return listApps()
		case "listWindows":
			return try listWindows(pid: Int32(try intArg(request, "pid")))
		case "listRoots":
			return try listRoots(pid: optionalIntArg(request, "pid").map { Int32($0) }, title: optionalStringArg(request, "title"))
		case "getFrontmost":
			return try getFrontmost()
		case "getUserContext":
			return try getUserContext()
		case "beginInputSuppression":
			return try beginInputSuppression()
		case "endInputSuppression":
			return endInputSuppression()
		case "restoreUserFocus":
			return try restoreUserFocus(request)
		case "focusWindow":
			return try focusWindow(request)
		case "setWindowFrame":
			return try setWindowFrame(request)
		case "look":
			return try look(request)
		case "act":
			return try act(request)
		case "actBatch":
			return try actBatch(request)
		case "hitTest":
			return try hitTest(request)
		case "axWaitFor":
			return try axWaitFor(request)
		case "focusedElement":
			return try focusedElement(request)
		case "axReadText":
			return try axReadText(request)
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

	private func optionalStringArg(_ request: [String: Any], _ key: String) -> String? {
		if let value = request[key] as? String {
			return value
		}
		return nil
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

	private func boolArg(_ request: [String: Any], _ key: String) -> Bool? {
		if let value = request[key] as? Bool { return value }
		if let value = request[key] as? NSNumber { return value.boolValue }
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

	private func processPath(pid: pid_t) -> String? {
		var buffer = [CChar](repeating: 0, count: 4096)
		let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
		return length > 0 ? String(cString: buffer) : nil
	}

	private func processName(pid: pid_t) -> String? {
		processPath(pid: pid).map { URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent }
	}

	private func diagnostics() -> [String: Any] {
		// Cheap booleans only — diagnostics doubles as the daemon liveness
		// probe (1s client timeout), so it must not run the ScreenCaptureKit
		// capturable check (up to 3s when ungranted). Permission truth comes
		// from checkPermissions.
		let permissions: [String: Any] = [
			"accessibility": AXIsProcessTrusted(),
			"screenRecording": {
				if #available(macOS 10.15, *) { return CGPreflightScreenCaptureAccess() }
				return true
			}(),
		]
		#if arch(arm64)
		let arch = "arm64"
		#elseif arch(x86_64)
		let arch = "x86_64"
		#else
		let arch = "unknown"
		#endif
		let parentPid = Int32(getppid())
		let parentApp = NSRunningApplication(processIdentifier: parentPid)
		let parentPath = processPath(pid: parentPid)
		var output: [String: Any] = [
			"protocolVersion": protocolVersion,
			"architectureVersion": 1,
			"invariants": ["state-scoped-observations", "bounded-observation-history", "multi-root-forest", "progressive-disclosure", "atomic-physical-input", "concurrent-requests", "transactional-batching"],
			"pid": Int32(getpid()),
			"parentPid": parentPid,
			"executablePath": CommandLine.arguments.first ?? "",
			"macOS": ProcessInfo.processInfo.operatingSystemVersionString,
			"arch": arch,
			"accessibility": permissions["accessibility"] ?? false,
			"screenRecording": permissions["screenRecording"] ?? false,
		]
		if let parentPath {
			output["parentPath"] = parentPath
		}
		if let parentAppName = parentApp?.localizedName ?? parentPath.map({ URL(fileURLWithPath: $0).lastPathComponent }) {
			output["parentAppName"] = parentAppName
		}
		if let parentBundleId = parentApp?.bundleIdentifier {
			output["parentBundleId"] = parentBundleId
		}
		return output
	}

	/// Live Screen Recording probe. `CGPreflightScreenCaptureAccess()`
	/// answers from a per-process cache that goes stale after `tccutil
	/// reset` or a Settings toggle; a ScreenCaptureKit content fetch only
	/// succeeds when THIS process can genuinely capture right now. When the
	/// two disagree, the preflight boolean is the one lying.
	private func screenRecordingCapturable() -> Bool {
		if #available(macOS 14.0, *) {
			let semaphore = DispatchSemaphore(value: 0)
			let capturable = Box<Bool>(false)
			Task {
				defer { semaphore.signal() }
				if let shareable = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) {
					capturable.value = !shareable.displays.isEmpty
				}
			}
			if semaphore.wait(timeout: .now() + .seconds(3)) == .timedOut {
				return false
			}
			return capturable.value
		}
		if #available(macOS 10.15, *) {
			return CGPreflightScreenCaptureAccess()
		}
		return true
	}

	/// Which TCC identity the permission booleans reflect. macOS attributes
	/// grants to the *responsible process* (the LaunchServices launching
	/// app), so:
	///   - "helper-app": running from the installed bundle, launched via
	///     LaunchServices — grants belong to the canonical helper identity.
	///   - "caller": anything else (dev binary under a terminal, etc.) —
	///     the booleans reflect whatever app spawned us, NOT the canonical
	///     helper. The extension surfaces this instead of guessing.
	private func permissionSource() -> [String: Any] {
		let parentPid = Int32(getppid())
		let executable = CommandLine.arguments.first ?? ""
		var source: [String: Any] = [
			"pid": Int(getpid()),
			"parentPid": Int(parentPid),
			"executablePath": executable,
			"macOS": ProcessInfo.processInfo.operatingSystemVersionString,
		]
		if let parentPath = processPath(pid: parentPid) {
			source["parentPath"] = parentPath
		}
		if let parentBundleId = NSRunningApplication(processIdentifier: parentPid)?.bundleIdentifier {
			source["parentBundleId"] = parentBundleId
		}
		let attribution: String
		if executable.contains("/pi-computer-use.app/Contents/MacOS/"), parentPid == 1 {
			// Non-spoofable signals only: installed-bundle executable path +
			// launchd parent (`open` handed us to LaunchServices). A dev
			// binary or a directly-spawned copy fails closed to "caller".
			attribution = "helper-app"
		} else {
			attribution = "caller"
		}
		source["attribution"] = attribution
		return source
	}

	private func checkPermissions() -> [String: Any] {
		permissionCacheLock.lock()
		if let cached = grantedPermissionStatus {
			permissionCacheLock.unlock()
			return cached
		}
		permissionCacheLock.unlock()
		let accessibility = AXIsProcessTrusted()
		let screenRecordingPreflight: Bool
		if #available(macOS 10.15, *) {
			screenRecordingPreflight = CGPreflightScreenCaptureAccess()
		} else {
			screenRecordingPreflight = true
		}
		let capturable = screenRecordingCapturable()
		let result: [String: Any] = [
			"accessibility": accessibility,
			// The live probe is authoritative; the preflight boolean is kept
			// for diagnostics (a true/false split identifies a stale cache or
			// a grant belonging to a different responsible process).
			"screenRecording": capturable,
			"screenRecordingPreflight": screenRecordingPreflight,
			"screenRecordingCapturable": capturable,
			"source": permissionSource(),
		]
		// A successful TCC grant is process-stable in practice. Cache only the
		// positive result so missing grants are always rechecked after the user
		// enables them, while fresh agent processes avoid repeating a multi-second
		// ScreenCaptureKit probe against the same long-lived helper daemon.
		if accessibility && capturable {
			permissionCacheLock.lock()
			grantedPermissionStatus = result
			permissionCacheLock.unlock()
		}
		return result
	}

	/// Register this process's identity with TCC for both grants so the app
	/// appears in the Settings panes BEFORE the user is sent there. The AX
	/// request registers (and prompts for) Accessibility; on recent macOS an
	/// app only appears under Screen Recording after a real ScreenCaptureKit
	/// attempt, which the capturable probe performs.
	private func registerPermissions() throws -> [String: Any] {
		let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
		let accessibility = AXIsProcessTrustedWithOptions(options)
		if #available(macOS 10.15, *) {
			_ = CGRequestScreenCaptureAccess()
		}
		let capturable = screenRecordingCapturable()
		return [
			"accessibility": accessibility,
			"screenRecording": capturable,
			"screenRecordingCapturable": capturable,
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

	private func pidIsAlive(_ pid: pid_t) -> Bool {
		pid > 0 && kill(pid, 0) == 0
	}

	private func listApps() -> [[String: Any]] {
		let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let apps = NSWorkspace.shared.runningApplications.filter { app in
			// Computer-use targets are windows, not Dock-visible applications. Some
			// benchmark/test apps and utility-style apps expose perfectly valid AX
			// windows while using an accessory/prohibited activation policy, so do not
			// gate discovery on `.regular` here. `listWindows` and the higher-level
			// window collector filter to actual controllable windows.
			app.processIdentifier != getpid() && pidIsAlive(app.processIdentifier)
		}
		var seen = Set<Int32>()
		var output = apps.map { app in
			seen.insert(app.processIdentifier)
			var data: [String: Any] = [
				"appName": app.localizedName ?? processName(pid: app.processIdentifier) ?? "Unknown App",
				"pid": Int(app.processIdentifier),
				"isFrontmost": app.processIdentifier == frontmostPid,
			]
			if let bundleId = app.bundleIdentifier {
				data["bundleId"] = bundleId
			}
			return data
		}

		// NSWorkspace can miss apps launched from ad-hoc bundles or test harnesses
		// even when their windows are visible and AX-controllable. Add CGWindow
		// owners as acquisition candidates so callers can still resolve by pid/title
		// and then build the normal AX scene through listWindows(pid:).
		for owner in cgWindowOwners() where owner.pid != getpid() && !seen.contains(owner.pid) && pidIsAlive(owner.pid) {
			seen.insert(owner.pid)
			output.append([
				"appName": owner.name,
				"pid": Int(owner.pid),
				"isFrontmost": owner.pid == frontmostPid,
			])
		}
		return output
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

	private func getUserContext() throws -> [String: Any] {
		guard let app = NSWorkspace.shared.frontmostApplication else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		let pid = app.processIdentifier
		ensureEnhancedAccessibility(pid: pid)
		let appElement = AXUIElementCreateApplication(pid)
		let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement)
		let focusedElement = copyAttribute(appElement, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
		var result: [String: Any] = [
			"appName": app.localizedName ?? "Unknown App",
			"pid": Int(pid),
		]
		if let bundleId = app.bundleIdentifier {
			result["bundleId"] = bundleId
		}
		if let window = focusedWindow {
			result["window"] = [
				"title": stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? "",
				"role": stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? "",
				"subrole": stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? "",
			]
		}
		if let element = focusedElement {
			let focusedRole = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let focusedSubrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
			result["focusedElement"] = [
				"role": focusedRole,
				"subrole": focusedSubrole,
				"title": stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? "",
				"description": stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? "",
				"value": displayValue(element, role: focusedRole, subrole: focusedSubrole),
			]
		}
		return result
	}

	private func beginInputSuppression() throws -> [String: Any] {
		try inputSuppressionGuard.begin()
		return ["active": true]
	}

	private func endInputSuppression() -> [String: Any] {
		inputSuppressionGuard.end()
		return ["active": false]
	}

	private func restoreUserFocus(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let targetTitle = optionalStringArg(request, "windowTitle")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		guard let app = NSRunningApplication(processIdentifier: pid) else {
			throw BridgeFailure(message: "App with pid \(pid) is no longer running", code: "app_not_found")
		}

		let appRestored = app.activate()
		var restoredWindowTitle = ""
		var windowRestored = false

		if !targetTitle.isEmpty {
			let appElement = AXUIElementCreateApplication(pid)
			let windows = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
			let normalizedTarget = targetTitle.lowercased()
			if let match = windows.first(where: {
				(stringAttribute($0, attribute: kAXTitleAttribute as CFString) ?? "")
					.trimmingCharacters(in: .whitespacesAndNewlines)
					.lowercased() == normalizedTarget
			}) {
				restoredWindowTitle = stringAttribute(match, attribute: kAXTitleAttribute as CFString) ?? ""
				let setMainStatus = AXUIElementSetAttributeValue(match, kAXMainAttribute as CFString, kCFBooleanTrue)
				let setFocusedStatus = AXUIElementSetAttributeValue(match, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				let raiseStatus = AXUIElementPerformAction(match, kAXRaiseAction as CFString)
				windowRestored = setMainStatus == .success || setFocusedStatus == .success || raiseStatus == .success
			}
		}

		return [
			"restored": appRestored || windowRestored,
			"appRestored": appRestored,
			"windowRestored": windowRestored,
			"appName": app.localizedName ?? "Unknown App",
			"windowTitle": restoredWindowTitle,
		]
	}

	private func setWindowFrame(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["ok": false, "reason": "window_not_found"]
		}
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		let width = max(100.0, try doubleArg(request, "width"))
		let height = max(80.0, try doubleArg(request, "height"))
		var origin = CGPoint(x: x, y: y)
		var size = CGSize(width: width, height: height)
		guard let originValue = AXValueCreate(.cgPoint, &origin), let sizeValue = AXValueCreate(.cgSize, &size) else {
			throw BridgeFailure(message: "Failed to create AX frame values", code: "frame_value_failed")
		}
		let positionStatus = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, originValue)
		let sizeStatus = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
		let frame = frameForWindow(window)
		return [
			"ok": positionStatus == .success || sizeStatus == .success,
			"positionStatus": Int(positionStatus.rawValue),
			"sizeStatus": Int(sizeStatus.rawValue),
			"framePoints": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height],
		]
	}

	private func focusWindow(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["focused": false, "reason": "window_not_found"]
		}

		let appElement = AXUIElementCreateApplication(pid)
		if let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement),
			sameElement(focusedWindow, window)
		{
			return ["focused": true, "alreadyFocused": true]
		}

		let setMainStatus = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		let setFocusedStatus = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
		let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		let focused = setMainStatus == .success || setFocusedStatus == .success || raiseStatus == .success
		var result: [String: Any] = [
			"focused": focused,
			"setMain": setMainStatus == .success,
			"setFocused": setFocusedStatus == .success,
			"raised": raiseStatus == .success,
		]
		if !focused {
			result["reason"] = "focus_failed"
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

	private func rootKind(role: String, subrole: String) -> String {
		if role == "AXSheet" { return "sheet" }
		if subrole.localizedCaseInsensitiveContains("popover") { return "popover" }
		if subrole.localizedCaseInsensitiveContains("dialog") || role == "AXDialog" { return "dialog" }
		return "window"
	}

	private func isDialogLikeRoot(role: String, subrole: String) -> Bool {
		let text = "\(role) \(subrole)"
		return text.range(of: "dialog", options: [.caseInsensitive]) != nil
			|| text.range(of: "modal", options: [.caseInsensitive]) != nil
			|| text.range(of: "sheet", options: [.caseInsensitive]) != nil
	}

	private func rootMetadata(pairing: WindowPairing, sheetCount: Int) -> [String: Any] {
		["pairing": ["confidence": pairing.confidence, "score": pairing.score], "sheetCount": sheetCount]
	}

	private func listRoots(pid: Int32?, title: String? = nil) throws -> [String: Any] {
		let requestedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
		let apps: [[String: Any]]
		if let pid {
			apps = [["pid": Int(pid)]]
		} else if !requestedTitle.isEmpty,
			let entries = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] {
			let matchingPids = Set(entries.compactMap { entry -> Int32? in
				let candidate = ((entry[kCGWindowName as String] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
				guard candidate == requestedTitle || candidate.contains(requestedTitle) else { return nil }
				return (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
			})
			apps = listApps().filter { app in
				guard let rawPid = app["pid"] as? Int else { return false }
				return matchingPids.contains(Int32(rawPid))
			}
		} else {
			apps = listApps()
		}
		var roots: [[String: Any]] = []
		for app in apps {
			guard let rawPid = app["pid"] as? Int else { continue }
			let appPid = Int32(rawPid)
			let appName = app["appName"] as? String ?? processName(pid: appPid) ?? "Unknown App"
			let bundleId = app["bundleId"] as? String
			for var root in (try? listWindows(pid: appPid)) ?? [] {
				root["pid"] = rawPid
				root["appName"] = appName
				if let bundleId { root["bundleId"] = bundleId }
				roots.append(root)
			}
			let menuElements = openMenuElements(pid: appPid)
			for (index, candidate) in cgPopupMenuCandidates(pid: appPid).enumerated() {
				let menuElement = index < menuElements.count ? menuElements[index] : nil
				let menuRef = menuElement.map { refStore.storeWindow($0) } ?? "cgmenu:\(candidate.windowId)"
				var menu: [String: Any] = [
					"kind": "menu",
					"rootRef": menuRef,
					"windowRef": menuRef,
					"windowId": Int(candidate.windowId),
					"zOrder": candidate.zOrder,
					"title": menuElement.flatMap { stringAttribute($0, attribute: kAXTitleAttribute as CFString) } ?? candidate.title,
					"role": "AXMenu",
					"subrole": "",
					"isModal": false,
					"framePoints": ["x": candidate.bounds.origin.x, "y": candidate.bounds.origin.y, "w": candidate.bounds.width, "h": candidate.bounds.height],
					"scaleFactor": displayScaleFactor(for: candidate.bounds),
					"isMinimized": false,
					"isOnscreen": candidate.isOnscreen,
					"isMain": false,
					"isFocused": true,
					"metadata": ["pairing": ["confidence": menuElement == nil ? "low" : "high", "score": menuElement == nil ? 0 : 100], "sheetCount": 0],
					"pid": rawPid,
					"appName": appName,
				]
				if let bundleId { menu["bundleId"] = bundleId }
				roots.append(menu)
			}
		}
		roots.sort { (($0["zOrder"] as? Int) ?? Int.max) < (($1["zOrder"] as? Int) ?? Int.max) }
		return ["roots": roots]
	}

	private func listWindows(pid: Int32) throws -> [[String: Any]] {
		ensureEnhancedAccessibility(pid: pid)
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 1.0)
		let windows = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		let candidates = cgWindowCandidates(pid: pid)
		let pairings = windowPairings(windows: windows, candidates: candidates)

		var output: [[String: Any]] = []
		for (zIndex, window) in windows.enumerated() {
			let axTitle = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			let axRole = stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? ""
			let axSubrole = stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? ""
			let axFrame = frameForWindow(window)
			let pairing = pairings[ObjectIdentifier(window)] ?? WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
			let candidate = pairing.candidate

			let effectiveFrame = axFrame.width > 1 && axFrame.height > 1 ? axFrame : (candidate?.bounds ?? axFrame)
			if effectiveFrame.width < 100 || effectiveFrame.height < 80 { continue }
			let hasUsableAXFrame = axFrame.width > 1 && axFrame.height > 1
			let title = hasUsableAXFrame && !axTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? axTitle : (candidate?.title.isEmpty == false ? candidate!.title : axTitle)
			let windowRef = refStore.storeWindow(window)
			let isMinimized = boolAttribute(window, attribute: kAXMinimizedAttribute as CFString) ?? false
			let isMain = boolAttribute(window, attribute: kAXMainAttribute as CFString) ?? false
			let isFocused = boolAttribute(window, attribute: kAXFocusedAttribute as CFString) ?? false
			let sheetCount = sheetElements(of: window).count
			let isModal = (boolAttribute(window, attribute: "AXModal" as CFString) ?? false) || sheetCount > 0 || isDialogLikeRoot(role: axRole, subrole: axSubrole)
			let scale = displayScaleFactor(for: effectiveFrame)

			var item: [String: Any] = [
				"kind": rootKind(role: axRole, subrole: axSubrole),
				"rootRef": windowRef,
				"windowRef": windowRef,
				"zOrder": candidate?.zOrder ?? zIndex,
				"title": title,
				"role": axRole,
				"subrole": axSubrole,
				"isModal": isModal,
				"framePoints": [
					"x": effectiveFrame.origin.x,
					"y": effectiveFrame.origin.y,
					"w": effectiveFrame.size.width,
					"h": effectiveFrame.size.height,
				],
				"scaleFactor": scale,
				"isMinimized": isMinimized,
				"isOnscreen": candidate?.isOnscreen ?? !isMinimized,
				"isMain": isMain,
				"isFocused": isFocused,
				"metadata": rootMetadata(pairing: pairing, sheetCount: sheetCount),
			]
			if let candidate {
				item["windowId"] = Int(candidate.windowId)
			}
			output.append(item)

			for sheet in sheetElements(of: window) {
				let sheetRef = refStore.storeWindow(sheet)
				let sheetFrame = frameForWindow(sheet)
				let sheetCandidate = bestCandidate(for: sheet, candidates: candidates)
				var sheetItem: [String: Any] = [
					"kind": "sheet",
					"rootRef": sheetRef,
					"windowRef": sheetRef,
					"zOrder": sheetCandidate?.zOrder ?? candidate?.zOrder ?? zIndex,
					"title": stringAttribute(sheet, attribute: kAXTitleAttribute as CFString) ?? title,
					"role": stringAttribute(sheet, attribute: kAXRoleAttribute as CFString) ?? "AXSheet",
					"subrole": stringAttribute(sheet, attribute: kAXSubroleAttribute as CFString) ?? "",
					"isModal": true,
					"framePoints": ["x": sheetFrame.origin.x, "y": sheetFrame.origin.y, "w": sheetFrame.width, "h": sheetFrame.height],
					"scaleFactor": displayScaleFactor(for: sheetFrame),
					"isMinimized": false,
					"isOnscreen": sheetCandidate?.isOnscreen ?? candidate?.isOnscreen ?? !isMinimized,
					"isMain": false,
					"isFocused": isFocused,
					"metadata": ["pairing": ["confidence": sheetCandidate == nil ? pairing.confidence : "high", "score": sheetCandidate == nil ? pairing.score : 100], "sheetCount": 0],
				]
				if let sheetCandidate { sheetItem["windowId"] = Int(sheetCandidate.windowId) }
				output.append(sheetItem)
			}
		}
		return output
	}

	private func look(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		let maxDimension = optionalIntArg(request, "maxDimension").map { max(1, $0) }
		let readText = optionalStringArg(request, "readText") ?? "auto"
		let baseLookId = optionalStringArg(request, "baseLookId")
		let includeImage = boolArg(request, "includeImage") ?? true
		guard readText == "auto" || readText == "always" || readText == "never" else {
			throw BridgeFailure(message: "readText must be auto, always, or never", code: "invalid_args")
		}

		let requestedRoot = windowRef.flatMap { refStore.window(for: $0) }
		let requestedRole = requestedRoot.flatMap { stringAttribute($0, attribute: kAXRoleAttribute as CFString) } ?? ""
		let isMenuRoot = requestedRole == "AXMenu" || (windowRef?.hasPrefix("cgmenu:") == true)
		let captureStart = Date()
		let shouldCapture = !isMenuRoot && (includeImage || readText == "always")
		let capture = try shouldCapture ? windowId.map { try captureWindow(windowId: $0) } : nil
		let captureMs = capture.map { _ in elapsedMs(captureStart) } ?? 0

		let pid: Int32
		if let windowId, let ownerPid = pidForWindowId(windowId) {
			pid = ownerPid
		} else if let windowRef, let element = refStore.element(for: windowRef), let owner = pidForElement(element) {
			pid = owner
		} else {
			throw BridgeFailure(message: "Root is not owned by a running app", code: "root_not_found")
		}
		ensureEnhancedAccessibility(pid: pid)
		if let windowRef, windowRef.hasPrefix("cgmenu:"), refStore.window(for: windowRef) == nil {
			let frame = windowId.flatMap { windowInfo(windowId: $0)?.bounds } ?? CGRect(x: 0, y: 0, width: 1, height: 1)
			let lookId = freshLookId()
			storeLookRecord(LookRecord(lookId: lookId, windowId: windowId ?? 0, windowFrame: frame, imageWidth: max(1, Int(frame.width)), imageHeight: max(1, Int(frame.height)), hasImage: false))
			let outline = LookNode(element: nil, ref: windowRef, role: "AXMenu", subrole: "", identifier: "", title: "Menu", description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: CGRect(x: 0, y: 0, width: max(1, frame.width), height: max(1, frame.height)), pictureOnly: true)
			return [
				"lookId": lookId,
				"capturedAt": captureStart.timeIntervalSince1970,
				"window": ["windowId": Int(windowId ?? 0), "rootRef": windowRef, "kind": "menu", "framePoints": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height], "scaleFactor": displayScaleFactor(for: frame), "isModal": false, "metadata": ["pairing": ["confidence": "low", "score": 0], "sheetCount": 0], "role": "AXMenu", "subrole": ""],
				"outline": outline.payload(),
				"timings": ["captureMs": 0, "describeMs": 0, "readTextMs": 0],
			]
		}
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			throw BridgeFailure(message: "Root is not available through Accessibility", code: "root_not_found")
		}
		let rootElement: AXUIElement
		if let scopeRef = optionalStringArg(request, "scopeRef") {
			guard let scoped = refStore.element(for: scopeRef), isElement(scoped, descendantOf: window) else {
				throw BridgeFailure(message: "Scope ref is stale or outside the target root", code: "element_ref_invalid")
			}
			rootElement = scoped
		} else {
			rootElement = window
		}

		let rootFrame = frameForWindow(window)
		let imageWidth: Int
		let imageHeight: Int
		let imagePayload: [String: Any]?
		let transform: (CGRect) -> CGRect
		if let capture {
			let outputImage = downscaledImage(capture.image, maxDimension: maxDimension) ?? capture.image
			imageWidth = outputImage.width
			imageHeight = outputImage.height
			transform = rectTransform(windowFrame: capture.frame, imageWidth: outputImage.width, imageHeight: outputImage.height)
			if includeImage {
				guard let jpeg = jpegData(image: outputImage, quality: 0.8) else {
					throw BridgeFailure(message: "Failed to encode look image as JPEG", code: "encoding_failed")
				}
				imagePayload = ["jpegBase64": jpeg.base64EncodedString(), "width": outputImage.width, "height": outputImage.height]
			} else {
				imagePayload = nil
			}
		} else {
			imageWidth = max(1, Int(rootFrame.width))
			imageHeight = max(1, Int(rootFrame.height))
			imagePayload = nil
			transform = rectTransform(windowFrame: rootFrame, imageWidth: imageWidth, imageHeight: imageHeight)
		}
		let describeStart = Date()
		let outline = buildLookOutline(root: rootElement, transform: transform)
		let describeMs = elapsedMs(describeStart)

		var readTextMs = 0
		var readTextExecuted = false
		if let capture, readText == "always" {
			readTextExecuted = true
			let textStart = Date()
			let boxes = try recognizeText(in: capture.image, outputWidth: imageWidth, outputHeight: imageHeight)
			attachOCR(boxes, to: outline)
			readTextMs = elapsedMs(textStart)
		}

		let lookId = freshLookId()
		let baseRecord = baseLookId.flatMap { lookRecord(for: $0) }
		storeLookRecord(LookRecord(
			lookId: lookId,
			windowId: windowId ?? baseRecord?.windowId ?? 0,
			windowFrame: baseRecord?.windowFrame ?? capture?.frame ?? rootFrame,
			imageWidth: baseRecord?.imageWidth ?? imageWidth,
			imageHeight: baseRecord?.imageHeight ?? imageHeight,
			hasImage: baseRecord?.hasImage ?? (capture != nil)
		))
		let scale = (capture?.frame.width ?? rootFrame.width) > 0 ? Double(imageWidth) / (capture?.frame.width ?? rootFrame.width) : displayScaleFactor(for: rootFrame)
		let pairing = pairingForWindow(window, pid: pid)
		let role = stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? ""
		let sheetCount = sheetElements(of: window).count
		var response: [String: Any] = [
			"lookId": lookId,
			"capturedAt": captureStart.timeIntervalSince1970,
			"window": [
				"windowId": Int(windowId ?? 0),
				"rootRef": windowRef ?? refStore.storeWindow(window),
				"kind": rootKind(role: role, subrole: subrole),
				"framePoints": ["x": (capture?.frame ?? rootFrame).origin.x, "y": (capture?.frame ?? rootFrame).origin.y, "w": (capture?.frame ?? rootFrame).width, "h": (capture?.frame ?? rootFrame).height],
				"scaleFactor": scale,
				"isModal": (boolAttribute(window, attribute: "AXModal" as CFString) ?? false) || sheetCount > 0 || isDialogLikeRoot(role: role, subrole: subrole),
				"metadata": rootMetadata(pairing: pairing, sheetCount: sheetCount),
				"role": role,
				"subrole": subrole,
			],
			"outline": outline.payload(),
			"timings": ["captureMs": captureMs, "describeMs": describeMs, "readTextMs": readTextMs],
			"readText": ["requested": readText, "executed": readTextExecuted],
		]
		if let imagePayload { response["image"] = imagePayload }
		return response
	}

	private func elapsedMs(_ start: Date) -> Int {
		max(0, Int(Date().timeIntervalSince(start) * 1000.0))
	}

	private func storeLookRecord(_ record: LookRecord) {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		lookRecords[record.lookId] = record
		lookRecordOrder.append(record.lookId)
		while lookRecordOrder.count > 8 {
			let oldest = lookRecordOrder.removeFirst()
			lookRecords.removeValue(forKey: oldest)
		}
	}

	private func freshLookId() -> String {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		nextLookId += 1
		return "look_\(nextLookId)"
	}

	private func lookRecord(for lookId: String) -> LookRecord? {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		return lookRecords[lookId]
	}

	private func rectTransform(windowFrame: CGRect, imageWidth: Int, imageHeight: Int) -> (CGRect) -> CGRect {
		let sx = windowFrame.width > 0 ? Double(imageWidth) / windowFrame.width : 1.0
		let sy = windowFrame.height > 0 ? Double(imageHeight) / windowFrame.height : 1.0
		return { frame in
			let x = (frame.origin.x - windowFrame.origin.x) * sx
			let y = (frame.origin.y - windowFrame.origin.y) * sy
			let w = frame.width * sx
			let h = frame.height * sy
			return self.clampRect(CGRect(x: x, y: y, width: w, height: h), width: imageWidth, height: imageHeight)
		}
	}

	private func clampRect(_ rect: CGRect, width: Int, height: Int) -> CGRect {
		let maxX = Double(width)
		let maxY = Double(height)
		let x1 = min(max(rect.minX, 0), maxX)
		let y1 = min(max(rect.minY, 0), maxY)
		let x2 = min(max(rect.maxX, 0), maxX)
		let y2 = min(max(rect.maxY, 0), maxY)
		return CGRect(x: x1, y: y1, width: max(0, x2 - x1), height: max(0, y2 - y1))
	}

	private func buildLookOutline(root: AXUIElement, transform: @escaping (CGRect) -> CGRect) -> LookNode {
		let rootNode = lookNode(element: root, transform: transform, offscreen: false)
		let nodeLimit = 2000
		// Apps with slow AX servers (e.g. Outlook) can take >30s to describe; the
		// client aborts at 33s, so stop walking well before that and return a
		// truncated outline instead.
		let deadline = Date().addingTimeInterval(20.0)
		var walked = 1
		var seen = Set<ObjectIdentifier>([ObjectIdentifier(root)])
		var queue: [(AXUIElement, LookNode)] = [(root, rootNode)]
		var index = 0
		while index < queue.count {
			let (element, node) = queue[index]
			index += 1
			let children = axElementArray(element, attribute: kAXChildrenAttribute as CFString)
			if children.isEmpty { continue }
			if walked >= nodeLimit || Date() >= deadline {
				node.truncated = true
				continue
			}
			let visibleByKind = visibleChildrenByKind(element)
			for child in children {
				if walked >= nodeLimit || Date() >= deadline {
					node.truncated = true
					break
				}
				let identity = ObjectIdentifier(child)
				if seen.contains(identity) { continue }
				seen.insert(identity)
				let role = stringAttribute(child, attribute: kAXRoleAttribute as CFString) ?? ""
				let offscreen = childOffscreen(child, role: role, visibleByKind: visibleByKind)
				let childNode = lookNode(element: child, transform: transform, offscreen: offscreen)
				node.children.append(childNode)
				queue.append((child, childNode))
				walked += 1
			}
		}
		return rootNode
	}

	private func lookNode(element: AXUIElement, transform: (CGRect) -> CGRect, offscreen: Bool) -> LookNode {
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let actions = actionNames(element)
		var valueSettable = DarwinBoolean(false)
		let valueStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
		var focusedSettable = DarwinBoolean(false)
		let focusedStatus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusedSettable)
		let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let description = stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? ""
		let value = displayValue(element, role: role, subrole: subrole)
		let screenRect = frameForElement(element) ?? .zero
		let node = LookNode(
			element: element,
			ref: refStore.storeElement(element, snapshot: AXRefStore.Snapshot(
				role: role,
				identifier: stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? "",
				label: normalizedLabel([title, description, value].joined(separator: " ")),
				rect: screenRect
			)),
			role: role,
			subrole: subrole,
			identifier: stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? "",
			title: title,
			description: description,
			value: value,
			actions: actions,
			canPress: actions.contains(kAXPressAction as String),
			canFocus: focusedStatus == .success && focusedSettable.boolValue,
			canSetValue: valueStatus == .success && valueSettable.boolValue,
			canScroll: supportsAnyScrollAction(element),
			canIncrement: actions.contains(kAXIncrementAction as String),
			canDecrement: actions.contains(kAXDecrementAction as String),
			isTextInput: textRoles.contains(role),
			rect: transform(screenRect),
			focused: boolAttribute(element, attribute: kAXFocusedAttribute as CFString) == true,
			offscreen: offscreen
		)
		if node.canScroll {
			let rows = axElementArray(element, attribute: kAXRowsAttribute as CFString)
			let visibleRows = axElementArrayIfPresent(element, attribute: kAXVisibleRowsAttribute as CFString)
			if !rows.isEmpty, let visibleRows {
				node.scrollExtent = ["seen": visibleRows.count, "total": rows.count]
			}
		}
		return node
	}

	private func visibleChildrenByKind(_ element: AXUIElement) -> [String: [AXUIElement]?] {
		[
			"AXRow": axElementArrayIfPresent(element, attribute: kAXVisibleRowsAttribute as CFString),
			"AXColumn": axElementArrayIfPresent(element, attribute: kAXVisibleColumnsAttribute as CFString),
			"AXCell": axElementArrayIfPresent(element, attribute: kAXVisibleCellsAttribute as CFString),
			"*": axElementArrayIfPresent(element, attribute: kAXVisibleChildrenAttribute as CFString),
		]
	}

	private func childOffscreen(_ child: AXUIElement, role: String, visibleByKind: [String: [AXUIElement]?]) -> Bool {
		let key = role == "AXRow" || role == "AXColumn" || role == "AXCell" ? role : "*"
		guard let visible = visibleByKind[key] ?? nil else { return false }
		return !visible.contains { sameElement($0, child) }
	}

	private func recognizeText(in image: CGImage, outputWidth: Int, outputHeight: Int) throws -> [OCRBox] {
		let semaphore = DispatchSemaphore(value: 0)
		let recognized = Box<[OCRBox]>([])
		let recognizedError = Box<Error?>(nil)
		let request = VNRecognizeTextRequest { request, error in
			defer { semaphore.signal() }
			if let error {
				recognizedError.value = error
				return
			}
			let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
			recognized.value = observations.compactMap { observation in
				guard let candidate = observation.topCandidates(1).first else { return nil }
				let box = observation.boundingBox
				let x = box.origin.x * Double(outputWidth)
				let y = (1.0 - box.origin.y - box.height) * Double(outputHeight)
				let w = box.width * Double(outputWidth)
				let h = box.height * Double(outputHeight)
				return OCRBox(string: candidate.string, confidence: Double(candidate.confidence), rect: CGRect(x: x, y: y, width: w, height: h))
			}
		}
		request.recognitionLevel = .accurate
		request.usesLanguageCorrection = false
		try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
		if semaphore.wait(timeout: .now() + .seconds(8)) == .timedOut {
			throw BridgeFailure(message: "Text recognition timed out", code: "text_recognition_timeout")
		}
		if let error = recognizedError.value {
			throw BridgeFailure(message: "Text recognition failed: \(error.localizedDescription)", code: "text_recognition_failed")
		}
		return recognized.value
	}

	private func attachOCR(_ boxes: [OCRBox], to root: LookNode) {
		var pictureOnlyIndex = 0
		for box in boxes {
			if ocrBoxDuplicatesAXLabel(box, in: root) { continue }
			let center = CGPoint(x: box.rect.midX, y: box.rect.midY)
			if let node = deepestNode(containing: center, in: root) {
				node.text.append(["string": box.string, "confidence": box.confidence, "rect": ["x": box.rect.origin.x, "y": box.rect.origin.y, "w": box.rect.width, "h": box.rect.height]])
			} else {
				pictureOnlyIndex += 1
				let parent = deepestContainer(containing: center, in: root) ?? root
				parent.children.append(LookNode(element: nil, ref: "pic_\(pictureOnlyIndex)", role: "AXImage", subrole: "", identifier: "", title: box.string, description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: box.rect, pictureOnly: true))
			}
		}
	}

	private func ocrBoxDuplicatesAXLabel(_ box: OCRBox, in root: LookNode) -> Bool {
		let boxLabel = normalizedLabel(box.string)
		if boxLabel.isEmpty { return true }
		var queue = [root]
		var index = 0
		while index < queue.count {
			let node = queue[index]
			index += 1
			if !node.pictureOnly, node.rect.intersects(box.rect) {
				let fields = [node.title, node.value, node.description]
				if fields.contains(where: { normalizedLabel($0) == boxLabel }) { return true }
			}
			queue.append(contentsOf: node.children)
		}
		return false
	}

	private func deepestNode(containing point: CGPoint, in root: LookNode) -> LookNode? {
		guard root.rect.contains(point), !root.pictureOnly else { return nil }
		for child in root.children.reversed() {
			if let match = deepestNode(containing: point, in: child) { return match }
		}
		return root
	}

	private func deepestContainer(containing point: CGPoint, in root: LookNode) -> LookNode? {
		guard root.rect.contains(point) else { return nil }
		for child in root.children.reversed() {
			if let match = deepestContainer(containing: point, in: child) { return match }
		}
		return root
	}

	private func lookPoint(record: LookRecord, x: Double, y: Double) -> CGPoint {
		let relX = min(max(x / max(1.0, Double(record.imageWidth)), 0), 1)
		let relY = min(max(y / max(1.0, Double(record.imageHeight)), 0), 1)
		return CGPoint(x: record.windowFrame.origin.x + record.windowFrame.width * relX, y: record.windowFrame.origin.y + record.windowFrame.height * relY)
	}

	private func payloadNode(element: AXUIElement) -> [String: Any] {
		let node = lookNode(element: element, transform: { $0 }, offscreen: false)
		var payload = node.payload()
		payload["children"] = []
		return payload
	}

	private func normalizedLabel(_ value: String) -> String {
		value.lowercased().components(separatedBy: CharacterSet.whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
	}

	private func ensureRootObserver(pid: Int32) -> Bool {
		rootObserverLock.lock()
		if let existing = rootObservers[pid] {
			existing.lastUsed = Date().timeIntervalSince1970
			rootObserverLock.unlock()
			return true
		}
		rootObserverLock.unlock()

		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		var observer: AXObserver?
		let createStatus = AXObserverCreate(pid, { observer, element, notification, refcon in
			guard let refcon else { return }
			let bridge = Unmanaged<Bridge>.fromOpaque(refcon).takeUnretainedValue()
			bridge.recordRootAXEvent(observer: observer, notification: notification as String, element: element)
		}, &observer)
		guard createStatus == .success, let observer else { return false }

		let state = RootAXObserverState(pid: pid, observer: observer)
		let context = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		let notifications: [CFString] = [
			"AXWindowCreated" as CFString,
			"AXSheetCreated" as CFString,
			"AXMenuOpened" as CFString,
			"AXMenuClosed" as CFString,
			"AXUIElementDestroyed" as CFString,
			"AXFocusedWindowChanged" as CFString,
			kAXValueChangedNotification as CFString,
			kAXTitleChangedNotification as CFString,
			kAXSelectedChildrenChangedNotification as CFString,
			kAXLayoutChangedNotification as CFString,
		]
		var registered = false
		let observedElements = [appElement] + axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		for observed in observedElements {
			for notification in notifications {
				let status = AXObserverAddNotification(observer, observed, notification, context)
				if status == .success || status == .notificationAlreadyRegistered { registered = true }
			}
		}
		guard registered else { return false }

		rootObserverLock.lock()
		if rootObservers.count >= maxRootObservers,
			let evict = rootObservers.values.min(by: { $0.lastUsed < $1.lastUsed })?.pid
		{
			rootObservers.removeValue(forKey: evict)
		}
		rootObservers[pid] = state
		rootObserverLock.unlock()

		let source = AXObserverGetRunLoopSource(observer)
		Thread.detachNewThread {
			// Keep each AXObserver on its own run loop so its callbacks never compete
			// with AppKit rendering on the helper's main thread.
			CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
			CFRunLoopRun()
		}
		return true
	}

	private func recordRootAXEvent(observer: AXObserver, notification: String, element: AXUIElement) {
		rootObserverLock.lock()
		let state = rootObservers.values.first { CFEqual($0.observer, observer) }
		if let state {
			state.events.append(RootAXEvent(sequence: state.nextSequence, timestamp: Date().timeIntervalSince1970, notification: notification, element: element))
			state.nextSequence += 1
			if state.events.count > 64 { state.events.removeFirst(state.events.count - 64) }
		}
		rootObserverLock.unlock()
		if let state {
			state.change.lock()
			state.changeGeneration += 1
			state.change.broadcast()
			state.change.unlock()
		}
	}

	private func rootChangeGeneration(pid: Int32) -> UInt64 {
		rootObserverLock.lock()
		let state = rootObservers[pid]
		rootObserverLock.unlock()
		guard let state else { return 0 }
		state.change.lock()
		defer { state.change.unlock() }
		return state.changeGeneration
	}

	private func waitForRootChange(pid: Int32, since generation: UInt64, until deadline: Date) {
		rootObserverLock.lock()
		let state = rootObservers[pid]
		rootObserverLock.unlock()
		guard let state else {
			Thread.sleep(forTimeInterval: min(0.2, max(0, deadline.timeIntervalSinceNow)))
			return
		}
		state.change.lock()
		if state.changeGeneration == generation {
			_ = state.change.wait(until: min(deadline, Date().addingTimeInterval(0.2)))
		}
		state.change.unlock()
	}

	private func rootEventCursor(pid: Int32) -> UInt64 {
		rootObserverLock.lock()
		defer { rootObserverLock.unlock() }
		return rootObservers[pid]?.nextSequence ?? 1
	}

	private func rootEvents(pid: Int32, since cursor: UInt64) -> [RootAXEvent] {
		rootObserverLock.lock()
		defer { rootObserverLock.unlock() }
		guard let events = rootObservers[pid]?.events else { return [] }
		return events.filter { $0.sequence >= cursor }
	}

	// Onscreen CGWindowList id set for one pid: ~1-2ms per call, so it can be
	// polled tightly where a full AX enumeration cannot.
	private func cgRootSignature(pid: Int32) -> Set<UInt32> {
		guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
		var ids = Set<UInt32>()
		for entry in entries {
			guard let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, owner == pid else { continue }
			guard let windowId = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
			ids.insert(windowId)
		}
		return ids
	}

	private func refindElement(ref: String, pid: Int32, windowId: UInt32) -> AXUIElement? {
		guard let snapshot = refStore.snapshot(for: ref),
			let window = windowElement(pid: pid, windowId: windowId)
		else { return nil }
		let targetCenter = CGPoint(x: snapshot.rect.midX, y: snapshot.rect.midY)
		let candidates = collectDescendants(startingAt: window, maxDepth: 8).filter { candidate in
			let role = stringAttribute(candidate, attribute: kAXRoleAttribute as CFString) ?? ""
			guard role == snapshot.role else { return false }
			let identifier = stringAttribute(candidate, attribute: "AXIdentifier" as CFString) ?? ""
			if !snapshot.identifier.isEmpty { return identifier == snapshot.identifier }
			let subrole = stringAttribute(candidate, attribute: kAXSubroleAttribute as CFString) ?? ""
			let title = stringAttribute(candidate, attribute: kAXTitleAttribute as CFString) ?? ""
			let description = stringAttribute(candidate, attribute: kAXDescriptionAttribute as CFString) ?? ""
			let value = displayValue(candidate, role: role, subrole: subrole)
			return normalizedLabel([title, description, value].joined(separator: " ")) == snapshot.label
		}
		return candidates.min { left, right in
			let leftFrame = frameForElement(left) ?? .zero
			let rightFrame = frameForElement(right) ?? .zero
			let leftDistance = hypot(leftFrame.midX - targetCenter.x, leftFrame.midY - targetCenter.y)
			let rightDistance = hypot(rightFrame.midX - targetCenter.x, rightFrame.midY - targetCenter.y)
			return leftDistance < rightDistance
		}
	}

	private func hitTest(_ request: [String: Any]) throws -> [String: Any] {
		let lookId = try stringArg(request, "lookId")
		guard let record = lookRecord(for: lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look")
		}
		let point = lookPoint(record: record, x: try doubleArg(request, "x"), y: try doubleArg(request, "y"))
		guard let element = hitTestElement(at: point) else {
			throw BridgeFailure(message: "No element at point", code: "hit_test_failed")
		}
		return payloadNode(element: element)
	}

	private func act(_ request: [String: Any]) throws -> [String: Any] {
		let lookId = try stringArg(request, "lookId")
		guard let record = lookRecord(for: lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look")
		}
		let pid = Int32(try intArg(request, "pid"))
		let action = try stringArg(request, "action")
		let target = request["target"] as? [String: Any] ?? [:]
		let params = request["params"] as? [String: Any] ?? [:]
		let policy = optionalStringArg(request, "policy") ?? "default"
		let deferRootDelta = boolArg(request, "deferRootDelta") ?? false
		let delivery = policy == "background" ? "pid" : ((params["delivery"] as? String) == "pid" ? "pid" : "hid")
		var holdsPhysicalInput = false
		func acquirePhysicalInputIfNeeded() {
			if delivery == "hid" && !holdsPhysicalInput {
				physicalInputLock.lock()
				holdsPhysicalInput = true
			}
		}
		defer { if holdsPhysicalInput { physicalInputLock.unlock() } }
		var performed: [String: Any] = ["delivery": delivery]
		var element: AXUIElement?
		var rawPoint: CGPoint?
		var preflightCapsUnknown = false
		let eventsLive = !deferRootDelta && ensureRootObserver(pid: pid)
		let eventCursor = eventsLive ? rootEventCursor(pid: pid) : 0
		let beforeRootSnapshot = deferRootDelta ? [:] : rootMetadataSnapshot(pid: pid)
		let beforeCgSignature = deferRootDelta ? [] : cgRootSignature(pid: pid)
		let beforeFrontmostPid = deferRootDelta ? nil : NSWorkspace.shared.frontmostApplication?.processIdentifier
		let beforeSheetCount = windowElement(pid: pid, windowId: record.windowId).map { sheetElements(of: $0).count } ?? 0
		let beforeFocusedWindow = focusedWindowSummary(pid: pid)
		let beforeValue: String?
		let beforeSelected: String?
		func finish(_ response: [String: Any]) -> [String: Any] {
			if deferRootDelta { return response }
			return attachRootDelta(to: response, before: beforeRootSnapshot, beforeFrontmostPid: beforeFrontmostPid, pid: pid, eventsLive: eventsLive, eventCursor: eventCursor, beforeCgSignature: beforeCgSignature)
		}

		if let ref = target["ref"] as? String {
			var refound = false
			let cached = refStore.element(for: ref)
			let cachedIsLive = cached.map {
				stringAttribute($0, attribute: kAXRoleAttribute as CFString) != nil && frameForElement($0) != nil
			} ?? false
			let resolved: AXUIElement?
			if cachedIsLive {
				resolved = cached
			} else {
				refound = true
				resolved = refindElement(ref: ref, pid: pid, windowId: record.windowId)
			}
			guard let stored = resolved else {
				throw BridgeFailure(message: "Element reference is stale", code: "stale_ref")
			}
			if refound { performed["refound"] = true }
			element = stored
			beforeValue = stringAttribute(stored, attribute: kAXValueAttribute as CFString)
			beforeSelected = stringAttribute(stored, attribute: kAXSelectedTextAttribute as CFString)
		} else if let xNumber = target["x"] as? NSNumber, let yNumber = target["y"] as? NSNumber {
			guard record.hasImage else {
				throw BridgeFailure(message: "Coordinate targeting is unavailable for this outline-only root", code: "coordinate_unavailable_for_root")
			}
			rawPoint = lookPoint(record: record, x: xNumber.doubleValue, y: yNumber.doubleValue)
			beforeValue = nil
			beforeSelected = nil
		} else {
			throw BridgeFailure(message: "act target must include ref or x/y", code: "invalid_args")
		}

		func coordinatePoint() throws -> CGPoint {
			if let element, let frame = frameForElement(element) {
				return CGPoint(x: frame.midX, y: frame.midY)
			}
			if let rawPoint { return rawPoint }
			throw BridgeFailure(message: "No coordinate grounding is available", code: "coordinate_unavailable")
		}

		func animateCursor(at point: CGPoint) {
			guard supportsAgentCursor,
				(request["cursorOverlay"] as? Bool ?? true),
				policy != "ax_only",
				["press", "click", "moveMouse", "scroll", "drag"].contains(action)
			else { return }
			Task { @MainActor in AgentCursor.shared.animate(to: point, above: record.windowId) }
		}

		func focusTargetForPhysicalInput() {
			guard delivery == "hid" else { return }
			if let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
				performed["activated"] = app.activate()
			}
			if let window = windowElement(pid: pid, windowId: record.windowId) {
				_ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
				_ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				performed["raised"] = AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
			}
			usleep(20_000)
		}

		func preflight(_ point: CGPoint) throws {
			guard let element else { preflightCapsUnknown = true; return }
			for attempt in 0..<4 {
				guard let hit = hitTestElement(at: point) else { preflightCapsUnknown = true; return }
				if sameElement(hit, element) || isElement(hit, descendantOf: element) || isElement(element, descendantOf: hit) { return }
				let role = stringAttribute(hit, attribute: kAXRoleAttribute as CFString) ?? ""
				if role == "AXWindow" || role == "AXApplication" { preflightCapsUnknown = true; return }
				if delivery == "hid" && attempt < 3 {
					focusTargetForPhysicalInput()
					usleep(20_000)
					continue
				}
				throw BridgeFailure(message: "Target is occluded by \(payloadNode(element: hit))", code: "occluded_target")
			}
		}

		func executeCoordinates(_ point: CGPoint) throws {
			guard element != nil || record.hasImage else {
				throw BridgeFailure(message: "Coordinate grounding is unavailable for this outline-only root", code: "coordinate_unavailable_for_root")
			}
			performed["grounding"] = "coordinates"
			if delivery == "pid" { performed["verification"] = "caller_required" }
			acquirePhysicalInputIfNeeded()
			focusTargetForPhysicalInput()
			if delivery == "hid" { try preflight(point) }
			switch action {
			case "press", "click":
				animateCursor(at: point)
				try postMouseClick(at: point, pid: pid, button: mouseButton(params["button"] as? String ?? "left"), clickCount: max(1, min(3, (params["clickCount"] as? NSNumber)?.intValue ?? 1)), delivery: delivery)
			case "moveMouse":
				animateCursor(at: point)
				try postMouseMove(to: point, pid: pid, delivery: delivery)
			case "scroll":
				animateCursor(at: point)
				try postScrollWheel(at: point, deltaX: (params["scrollX"] as? NSNumber)?.intValue ?? 0, deltaY: (params["scrollY"] as? NSNumber)?.intValue ?? 0, pid: pid, delivery: delivery)
			case "drag":
				guard let rawPath = params["path"] as? [[String: Any]], rawPath.count >= 2 else {
					throw BridgeFailure(message: "drag requires path", code: "invalid_args")
				}
				let points = try rawPath.map { raw -> CGPoint in
					guard let x = (raw["x"] as? NSNumber)?.doubleValue, let y = (raw["y"] as? NSNumber)?.doubleValue else {
						throw BridgeFailure(message: "drag path entries require x and y", code: "invalid_args")
					}
					return lookPoint(record: record, x: x, y: y)
				}
				animateCursor(at: point)
				try postMouseDrag(points: points, pid: pid, delivery: delivery)
			default:
				throw BridgeFailure(message: "Action \(action) cannot use coordinate grounding", code: "invalid_args")
			}
		}

		func refreshElement() -> AXUIElement? {
			guard let ref = target["ref"] as? String,
				let refreshed = refindElement(ref: ref, pid: pid, windowId: record.windowId)
			else { return nil }
			element = refreshed
			performed["refound"] = true
			return refreshed
		}

		if let element, action == "press" || action == "click" {
			let elementRole = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]
			let requiresPointerFocus = hasAncestorRole(element, role: "AXWebArea") || textRoles.contains(elementRole)
			if requiresPointerFocus && policy != "ax_only" {
				if policy == "foreground" {
					try executeCoordinates(coordinatePoint())
				} else {
					throw BridgeFailure(message: "Web content requires pointer input", code: "foreground_required")
				}
			} else if supportsAction(element, action: kAXPressAction as CFString) {
				let cursorPoint = try? coordinatePoint()
				var status = AXUIElementPerformAction(element, kAXPressAction as CFString)
				if status != .success, let refreshed = refreshElement(), supportsAction(refreshed, action: kAXPressAction as CFString) {
					status = AXUIElementPerformAction(refreshed, kAXPressAction as CFString)
				}
				if status == .success {
					performed["grounding"] = "description"
					performed["delivery"] = "ax"
					if let cursorPoint { animateCursor(at: cursorPoint) }
				} else {
					try executeCoordinates(coordinatePoint())
				}
			} else {
				try executeCoordinates(coordinatePoint())
			}
		} else if let element, action == "setText" {
			let text = params["text"] as? String ?? ""
			if hasAncestorRole(element, role: "AXWebArea") {
				acquirePhysicalInputIfNeeded()
				focusTargetForPhysicalInput()
				_ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				let currentValue = stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? ""
				var range = CFRange(location: 0, length: (currentValue as NSString).length)
				let selected = AXValueCreate(.cfRange, &range).map {
					AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, $0) == .success
				} ?? false
				if !selected {
					try postKeyPress(keys: ["cmd", "a"], pid: pid, delivery: delivery)
					usleep(20_000)
				}
				try postAtomicUnicodeText(text, pid: pid, delivery: delivery)
				usleep(40_000)
				let verificationElement = refreshElement() ?? element
				let value = stringAttribute(verificationElement, attribute: kAXValueAttribute as CFString) ?? ""
				performed["grounding"] = "keyboard-events"
				performed["delivery"] = delivery
				performed["selectionGrounding"] = selected ? "ax" : "keyboard"
				return finish(["outcome": value == text ? "worked" : "didnt", "performed": performed, "evidence": ["value": value]])
			}
			var targetElement = element
			var status = AXUIElementSetAttributeValue(targetElement, kAXValueAttribute as CFString, text as CFTypeRef)
			if status != .success, let refreshed = refreshElement() {
				targetElement = refreshed
				status = AXUIElementSetAttributeValue(targetElement, kAXValueAttribute as CFString, text as CFTypeRef)
			}
			if status == .success {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				let value = stringAttribute(targetElement, attribute: kAXValueAttribute as CFString) ?? ""
				if value != text && policy != "foreground" {
					throw BridgeFailure(message: "The background accessibility value write was accepted but did not take effect", code: "foreground_required")
				}
				return finish(["outcome": value == text ? "worked" : "didnt", "performed": performed, "evidence": ["value": value]])
			}
			try executeCoordinates(coordinatePoint())
		} else if action == "typeText" {
			let preserveFocus = params["preserveFocus"] as? Bool ?? false
			if let element {
				let focused = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				if focused == .success { performed["focused"] = true }
			}
			acquirePhysicalInputIfNeeded()
			if delivery == "hid" && !preserveFocus { focusTargetForPhysicalInput() }
			let text = params["text"] as? String ?? ""
			try postUnicodeText(text, pid: pid, delivery: delivery)
			performed["grounding"] = "coordinates"
			if let element, !text.isEmpty {
				usleep(30_000)
				let afterValue = stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? ""
				let changed = afterValue != (beforeValue ?? "")
				return finish(["outcome": changed ? "worked" : "didnt", "performed": performed, "evidence": ["value": afterValue, "valueChanged": changed]])
			}
		} else if action == "keypress" {
			let preserveFocus = params["preserveFocus"] as? Bool ?? false
			guard let keys = params["keys"] as? [String], !keys.isEmpty else {
				throw BridgeFailure(message: "keypress requires keys", code: "invalid_args")
			}
			if let element {
				let focused = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				if focused == .success { performed["focused"] = true }
				let normalizedKeys = keys.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
				if normalizedKeys.count == 2,
					normalizedKeys.last == "a",
					["cmd", "command", "meta"].contains(normalizedKeys.first ?? ""),
					let value = stringAttribute(element, attribute: kAXValueAttribute as CFString)
				{
					var range = CFRange(location: 0, length: (value as NSString).length)
					if let selection = AXValueCreate(.cfRange, &range),
						AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selection) == .success
					{
						performed["selectionGrounding"] = "ax"
					}
				}
			}
			acquirePhysicalInputIfNeeded()
			if delivery == "hid" && !preserveFocus { focusTargetForPhysicalInput() }
			try postKeyPress(keys: keys, pid: pid, delivery: delivery)
			performed["grounding"] = "coordinates"
		} else if let element, action == "scroll" {
			let cursorPoint = try? coordinatePoint()
			let before = scrollPositionSignature(element)
			let result = performScrollActionOrAncestor(startingAt: element, targetPid: pid, scrollX: (params["scrollX"] as? NSNumber)?.intValue ?? 0, scrollY: (params["scrollY"] as? NSNumber)?.intValue ?? 0, steps: 1)
			if (result["scrolled"] as? Bool) == true {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				if let cursorPoint { animateCursor(at: cursorPoint) }
				let after = scrollPositionSignature(element)
				return finish(["outcome": before != after ? "worked" : "unknown", "performed": performed])
			}
			try executeCoordinates(coordinatePoint())
		} else {
			try executeCoordinates(coordinatePoint())
		}

		let afterSheetCount = windowElement(pid: pid, windowId: record.windowId).map { sheetElements(of: $0).count } ?? beforeSheetCount
		let windowChanged = beforeFocusedWindow != focusedWindowSummary(pid: pid) || beforeSheetCount != afterSheetCount
		var outcome = preflightCapsUnknown ? "unknown" : "unknown"
		var evidence: [String: Any] = [:]
		if let element, action == "press" || action == "click" {
			let afterValue = stringAttribute(element, attribute: kAXValueAttribute as CFString)
			let afterSelected = stringAttribute(element, attribute: kAXSelectedTextAttribute as CFString)
			if beforeValue != afterValue || beforeSelected != afterSelected || windowChanged {
				outcome = "worked"
			}
		} else if windowChanged {
			outcome = "worked"
		}
		if windowChanged { evidence["windowChanged"] = true }
		var response: [String: Any] = ["outcome": outcome, "performed": performed]
		if !evidence.isEmpty { response["evidence"] = evidence }
		return finish(response)
	}

	private func actBatch(_ request: [String: Any]) throws -> [String: Any] {
		guard let actions = request["actions"] as? [[String: Any]], !actions.isEmpty, actions.count <= 20 else {
			throw BridgeFailure(message: "actBatch requires 1...20 actions", code: "invalid_args")
		}
		let pid = Int32(try intArg(actions[0], "pid"))
		let lookId = try stringArg(actions[0], "lookId")
		guard actions.allSatisfy({ ($0["pid"] as? NSNumber)?.int32Value == pid }) else {
			throw BridgeFailure(message: "actBatch actions must target one pid", code: "invalid_args")
		}
		guard actions.allSatisfy({ ($0["lookId"] as? String) == lookId }) else {
			throw BridgeFailure(message: "actBatch actions must belong to one look", code: "invalid_args")
		}
		let eventsLive = ensureRootObserver(pid: pid)
		let eventCursor = eventsLive ? rootEventCursor(pid: pid) : 0
		let beforeRootSnapshot = rootMetadataSnapshot(pid: pid)
		let beforeCgSignature = cgRootSignature(pid: pid)
		let beforeFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let mayUsePhysicalInput = actions.contains { action in
			(optionalStringArg(action, "policy") ?? "default") != "ax_only"
		}
		if mayUsePhysicalInput { physicalInputLock.lock() }
		defer { if mayUsePhysicalInput { physicalInputLock.unlock() } }

		var steps: [[String: Any]] = []
		var stoppedAt: Int?
		for (index, action) in actions.enumerated() {
			var deferred = action
			deferred["deferRootDelta"] = true
			do {
				let step = try act(deferred)
				steps.append(step)
				if (step["outcome"] as? String) == "didnt" { stoppedAt = index; break }
			} catch let failure as BridgeFailure {
				steps.append(["outcome": "didnt", "error": ["code": failure.code, "message": failure.message]])
				stoppedAt = index
				break
			}
		}
		let outcomes = steps.compactMap { $0["outcome"] as? String }
		let outcome = outcomes.contains("didnt") ? "didnt" : (outcomes.contains("unknown") ? "unknown" : "worked")
		var response: [String: Any] = ["outcome": outcome, "performed": ["transaction": true, "actionCount": steps.count], "steps": steps]
		if let stoppedAt { response["stoppedAt"] = stoppedAt }
		return attachRootDelta(to: response, before: beforeRootSnapshot, beforeFrontmostPid: beforeFrontmostPid, pid: pid, eventsLive: eventsLive, eventCursor: eventCursor, beforeCgSignature: beforeCgSignature)
	}

	private func rootIdentity(_ root: [String: Any]) -> String {
		if let windowId = root["windowId"] as? Int, windowId > 0 { return "window:\(windowId)" }
		// AXUIElement CFEqual/CFHash are not stable after re-enumeration for all
		// transient roots; use the metadata tuple that comes from the cheap pass.
		let kind = root["kind"] as? String ?? "window"
		let title = root["title"] as? String ?? ""
		let role = root["role"] as? String ?? ""
		let frame = root["framePoints"] as? [String: Any] ?? [:]
		let x = Int((frame["x"] as? NSNumber)?.doubleValue ?? 0)
		let y = Int((frame["y"] as? NSNumber)?.doubleValue ?? 0)
		let w = Int((frame["w"] as? NSNumber)?.doubleValue ?? 0)
		let h = Int((frame["h"] as? NSNumber)?.doubleValue ?? 0)
		return "meta:\(kind):\(role):\(title):\(x),\(y),\(w),\(h)"
	}

	private func rootMetadataSnapshot(pid: Int32) -> [String: [String: Any]] {
		let roots = ((try? listRoots(pid: pid)["roots"] as? [[String: Any]]) ?? [])
		return Dictionary(uniqueKeysWithValues: roots.map { (rootIdentity($0), $0) })
	}

	private func rootDelta(before: [String: [String: Any]], beforeFrontmostPid: pid_t?, pid: Int32) -> [[String: Any]] {
		let after = rootMetadataSnapshot(pid: pid)
		var delta: [[String: Any]] = []
		for (key, root) in after where before[key] == nil {
			delta.append(rootDeltaItem(change: "appeared", root: root, pid: pid))
		}
		for (key, root) in before where after[key] == nil {
			delta.append(rootDeltaItem(change: "closed", root: root, pid: pid))
		}
		for (key, root) in after {
			if (root["isFocused"] as? Bool) == true && (before[key]?["isFocused"] as? Bool) != true {
				delta.append(rootDeltaItem(change: "focused", root: root, pid: pid))
			}
		}
		if let beforeFrontmostPid, beforeFrontmostPid != NSWorkspace.shared.frontmostApplication?.processIdentifier {
			if let frontmost = NSWorkspace.shared.frontmostApplication {
				delta.append(["change": "focused", "kind": "app", "title": frontmost.localizedName ?? processName(pid: frontmost.processIdentifier) ?? "Unknown App", "pid": Int(frontmost.processIdentifier)])
			}
		}
		return delta
	}

	private func rootDeltaItem(change: String, root: [String: Any], pid: Int32) -> [String: Any] {
		var item: [String: Any] = ["change": change, "kind": root["kind"] as? String ?? "window", "title": root["title"] as? String ?? "", "pid": root["pid"] as? Int ?? Int(pid)]
		if let isModal = root["isModal"] as? Bool { item["isModal"] = isModal }
		if let metadata = root["metadata"] as? [String: Any] { item["metadata"] = metadata }
		if let ref = root["rootRef"] as? String ?? root["windowRef"] as? String { item["ref"] = ref }
		return item
	}

	// The AX snapshot diff is authoritative: macOS emits no AXObserver
	// notification at all when a sheet appears (verified on macOS 26), so
	// events can only accelerate the decision, never make it. A cheap
	// CGWindowList id-set poll detects real-window appearance/closure early;
	// the AX diff runs once at the first signal or at timeout.
	private func attachRootDelta(to response: [String: Any], before: [String: [String: Any]], beforeFrontmostPid: pid_t?, pid: Int32, eventsLive: Bool, eventCursor: UInt64, beforeCgSignature: Set<UInt32>) -> [String: Any] {
		var output = response
		var performed = output["performed"] as? [String: Any] ?? [:]

		// AXUIElementDestroyed is deliberately not a signal: it fires for every
		// rebuilt list row; a genuinely closed root also leaves the CG set.
		let signalNotifications: Set<String> = ["AXWindowCreated", "AXSheetCreated", "AXMenuOpened", "AXMenuClosed", "AXFocusedWindowChanged"]
		var source = "snapshot"
		let deadline = Date().addingTimeInterval(0.40)
		while Date() < deadline {
			if cgRootSignature(pid: pid) != beforeCgSignature { source = "cg-poll"; break }
			if let beforeFrontmostPid, NSWorkspace.shared.frontmostApplication?.processIdentifier != beforeFrontmostPid { source = "cg-poll"; break }
			if eventsLive && rootEvents(pid: pid, since: eventCursor).contains(where: { signalNotifications.contains($0.notification) }) { source = "events"; break }
			usleep(30_000)
		}

		var delta = rootDelta(before: before, beforeFrontmostPid: beforeFrontmostPid, pid: pid)
		if delta.isEmpty && source != "snapshot" {
			// A signal fired but the AX tree can lag the CG window; give it a
			// bounded moment to catch up.
			for _ in 0..<3 where delta.isEmpty {
				usleep(80_000)
				delta = rootDelta(before: before, beforeFrontmostPid: beforeFrontmostPid, pid: pid)
			}
		}
		performed["deltaSource"] = source
		output["performed"] = performed
		if !delta.isEmpty { output["rootDelta"] = delta }
		return output
	}

	private func focusedWindowSummary(pid: Int32) -> String {
		let app = AXUIElementCreateApplication(pid)
		guard let element = copyAttribute(app, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement) else { return "none" }
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		return "\(role):\(title)"
	}

	private func scrollPositionSignature(_ element: AXUIElement) -> String {
		let names: [CFString] = ["AXVerticalScrollBar" as CFString, "AXHorizontalScrollBar" as CFString, kAXValueAttribute as CFString]
		return names.map { String(describing: copyAttribute(element, attribute: $0) ?? "" as CFTypeRef) }.joined(separator: "|")
	}

	private func axWaitFor(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		ensureEnhancedAccessibility(pid: pid)
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		let role = optionalStringArg(request, "role")?.trimmingCharacters(in: .whitespacesAndNewlines)
		let text = optionalStringArg(request, "text")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let expectedValue = optionalStringArg(request, "value")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let waitForGone = boolArg(request, "gone") ?? false
		let timeoutMs = max(100, min(60_000, optionalIntArg(request, "timeoutMs") ?? 10_000))
		let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
		guard role?.isEmpty == false || text?.isEmpty == false || expectedValue?.isEmpty == false else {
			throw BridgeFailure(message: "axWaitFor requires role, text, or value", code: "invalid_args")
		}
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["found": false, "reason": "window_not_found"]
		}
		_ = ensureRootObserver(pid: pid)

		func matches(_ element: AXUIElement) -> Bool {
			let candidateRole = self.stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			if let role, !role.isEmpty, candidateRole != role { return false }
			if let text, !text.isEmpty {
				let subrole = self.stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
				let haystack = [
					self.stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? "",
					self.stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? "",
					self.displayValue(element, role: candidateRole, subrole: subrole),
				].joined(separator: "\n").lowercased()
				if !haystack.contains(text) { return false }
			}
			if let expectedValue, !expectedValue.isEmpty {
				let subrole = self.stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
				if self.displayValue(element, role: candidateRole, subrole: subrole).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != expectedValue { return false }
			}
			return true
		}

		var lastCount = 0
		repeat {
			let changeGeneration = rootChangeGeneration(pid: pid)
			let descendants = collectDescendantsWithContext(startingAt: window, maxDepth: 12, maxNodes: 2000)
			lastCount = descendants.count
			if let match = descendants.first(where: { matches($0.element) }) {
				if waitForGone {
					waitForRootChange(pid: pid, since: changeGeneration, until: deadline)
					continue
				}
				let candidateRole = self.stringAttribute(match.element, attribute: kAXRoleAttribute as CFString) ?? ""
				let isBrowser = isBrowser(pid: pid)
				let containsWebArea = descendants.contains { self.stringAttribute($0.element, attribute: kAXRoleAttribute as CFString) == "AXWebArea" }
				return [
					"found": true,
					"target": self.elementPayload(
						element: match.element,
						key: "target",
						source: self.axSource(role: candidateRole, insideWebArea: match.insideWebArea, isBrowser: isBrowser, containsWebArea: containsWebArea)
					),
					"nodeCount": lastCount,
				]
			}
			if waitForGone {
				return ["found": true, "gone": true, "nodeCount": lastCount]
			}
			waitForRootChange(pid: pid, since: changeGeneration, until: deadline)
		} while Date() < deadline

		return ["found": false, "timedOut": true, "nodeCount": lastCount]
	}

	private func hitTestElement(at point: CGPoint) -> AXUIElement? {
		let systemWide = AXUIElementCreateSystemWide()
		var hitElement: AXUIElement?
		let status = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hitElement)
		guard status == .success, let hitElement else { return nil }
		return hitElement
	}

	private let axScrollDownAction = "AXScrollDown" as CFString
	private let axScrollUpAction = "AXScrollUp" as CFString
	private let axScrollLeftAction = "AXScrollLeft" as CFString
	private let axScrollRightAction = "AXScrollRight" as CFString

	private func scrollActionNames(scrollX: Int, scrollY: Int) -> [CFString] {
		var actions: [CFString] = []
		if scrollY > 0 { actions.append(axScrollDownAction) }
		if scrollY < 0 { actions.append(axScrollUpAction) }
		if scrollX > 0 { actions.append(axScrollRightAction) }
		if scrollX < 0 { actions.append(axScrollLeftAction) }
		return actions
	}

	private func supportsAnyScrollAction(_ element: AXUIElement) -> Bool {
		let actions = Set(actionNames(element))
		return actions.contains(axScrollDownAction as String) || actions.contains(axScrollUpAction as String) || actions.contains(axScrollLeftAction as String) || actions.contains(axScrollRightAction as String)
	}

	private func performScrollActionOrAncestor(startingAt element: AXUIElement, targetPid: Int32, scrollX: Int, scrollY: Int, steps: Int) -> [String: Any] {
		let actions = scrollActionNames(scrollX: scrollX, scrollY: scrollY)
		guard !actions.isEmpty else { return ["scrolled": false, "reason": "zero_delta"] }
		var current: AXUIElement? = element
		var depth = 0

		while let candidate = current, depth < 10 {
			if let pid = pidForElement(candidate), pid != targetPid {
				return ["scrolled": false, "reason": "pid_mismatch", "ownerPid": Int(pid)]
			}
			var didScroll = false
			for _ in 0..<steps {
				for action in actions where supportsAction(candidate, action: action) {
					let status = AXUIElementPerformAction(candidate, action)
					if status == .success { didScroll = true }
				}
			}
			if didScroll { return ["scrolled": true] }
			current = parentElement(candidate)
			depth += 1
		}

		return ["scrolled": false, "reason": "no_scroll_action"]
	}

	private func performActionOrAncestor(startingAt element: AXUIElement, action: CFString, targetPid: Int32) -> [String: Any] {
		var current: AXUIElement? = element
		var depth = 0

		while let candidate = current, depth < 10 {
			if let pid = pidForElement(candidate), pid != targetPid {
				return ["performed": false, "reason": "pid_mismatch", "ownerPid": Int(pid)]
			}

			if supportsAction(candidate, action: action) {
				let actionStatus = AXUIElementPerformAction(candidate, action)
				if actionStatus == .success {
					return ["performed": true]
				}
			}

			current = parentElement(candidate)
			depth += 1
		}

		return ["performed": false, "reason": "no_matching_action"]
	}

	private func windowElement(pid: Int32, windowId: UInt32?, windowRef: String? = nil) -> AXUIElement? {
		if let windowRef, let stored = refStore.window(for: windowRef) {
			AXUIElementSetMessagingTimeout(stored, 1.0)
			var ownerPid: pid_t = 0
			if AXUIElementGetPid(stored, &ownerPid) == .success, ownerPid == pid {
				return stored
			}
		}

		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 1.0)
		let windows = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		guard !windows.isEmpty else { return nil }
		guard let windowId else {
			return windows.first
		}
		let candidates = cgWindowCandidates(pid: pid)
		let pairings = windowPairings(windows: windows, candidates: candidates)
		for window in windows {
			if pairings[ObjectIdentifier(window)]?.candidate?.windowId == windowId {
				return window
			}
			for sheet in sheetElements(of: window) {
				if bestCandidate(for: sheet, candidates: candidates)?.windowId == windowId {
					return sheet
				}
			}
		}
		return nil
	}

	private func findDescendant(startingAt root: AXUIElement, maxDepth: Int, predicate: (AXUIElement) -> Bool) -> AXUIElement? {
		collectDescendants(startingAt: root, maxDepth: maxDepth).first(where: predicate)
	}

	private func ensureEnhancedAccessibility(pid: Int32) {
		enhancedAccessibilityLock.lock()
		let inserted = enhancedAccessibilityPids.insert(pid).inserted
		enhancedAccessibilityLock.unlock()
		if !inserted { return }
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		let enhancedStatus = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
		let manualStatus = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
		// Chromium-family apps often materialize web-content AX asynchronously
		// after these toggles. Pay a small one-time settle cost per pid so the
		// first tree walk is less likely to see browser chrome only.
		if isBrowser(pid: pid) && (enhancedStatus == .success || manualStatus == .success) {
			Thread.sleep(forTimeInterval: 0.35)
		}
	}

	private func isBrowser(pid: Int32) -> Bool {
		let app = NSRunningApplication(processIdentifier: pid)
		if browserBundleIds.contains(app?.bundleIdentifier ?? "") { return true }
		let name = (app?.localizedName ?? processName(pid: pid) ?? "").lowercased()
		return ["chrome", "chromium", "brave", "edge", "vivaldi", "opera", "firefox", "helium"].contains { name.contains($0) }
	}

	private func collectDescendants(startingAt root: AXUIElement, maxDepth: Int, maxNodes: Int = 5000) -> [AXUIElement] {
		collectDescendantsWithContext(startingAt: root, maxDepth: maxDepth, maxNodes: maxNodes).map(\.element)
	}

	private func collectDescendantsWithContext(startingAt root: AXUIElement, maxDepth: Int, maxNodes: Int = 5000) -> [AXDescendant] {
		let nodeLimit = max(1, maxNodes)
		var queue: [(AXUIElement, Int, Bool, Bool)] = [(root, 0, false, true)]
		var seen = Set<ObjectIdentifier>()
		var index = 0
		var output: [AXDescendant] = []
		while index < queue.count && output.count < nodeLimit {
			let (element, depth, parentInsideWebArea, inheritedVisible) = queue[index]
			index += 1
			let identity = ObjectIdentifier(element)
			if seen.contains(identity) { continue }
			seen.insert(identity)
			let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let insideWebArea = parentInsideWebArea || role == "AXWebArea"
			output.append(AXDescendant(element: element, depth: depth, insideWebArea: insideWebArea, axVisible: inheritedVisible))
			if depth >= maxDepth { continue }
			let children = axElementArray(element, attribute: kAXChildrenAttribute as CFString)
			let visibleChildren = visibleAXChildren(element)
			for child in children {
				if queue.count >= nodeLimit { break }
				let childVisible = inheritedVisible && (visibleChildren.map { set in set.contains { self.sameElement($0, child) } } ?? true)
				queue.append((child, depth + 1, insideWebArea, childVisible))
			}
		}
		return output
	}

	private func visibleAXChildren(_ element: AXUIElement) -> [AXUIElement]? {
		let attributes: [CFString] = [
			kAXVisibleChildrenAttribute as CFString,
			kAXVisibleRowsAttribute as CFString,
			kAXVisibleColumnsAttribute as CFString,
			kAXVisibleCellsAttribute as CFString,
		]
		let visible = attributes.flatMap { axElementArray(element, attribute: $0) }
		return visible.isEmpty ? nil : visible
	}

	private func insideWebAreaMap(_ descendants: [AXDescendant]) -> [ObjectIdentifier: Bool] {
		var output: [ObjectIdentifier: Bool] = [:]
		for descendant in descendants {
			let key = ObjectIdentifier(descendant.element)
			output[key] = (output[key] ?? false) || descendant.insideWebArea
		}
		return output
	}

	private func axSource(role: String, insideWebArea: Bool, isBrowser: Bool, containsWebArea: Bool) -> String {
		if insideWebArea || role == "AXWebArea" { return "web_content_ax" }
		if isBrowser || containsWebArea { return "browser_chrome_ax" }
		return "desktop_ax"
	}

	private func frameForElement(_ element: AXUIElement) -> CGRect? {
		let origin = pointAttribute(element, attribute: kAXPositionAttribute as CFString)
		let size = sizeAttribute(element, attribute: kAXSizeAttribute as CFString)
		guard let origin, let size, size.width > 0, size.height > 0 else { return nil }
		return CGRect(origin: origin, size: size)
	}

	private func elementPayload(element: AXUIElement, key: String, score: Double? = nil, source: String? = nil, axVisible: Bool = true) -> [String: Any] {
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let description = stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? ""
		let identifier = stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? ""
		let value = displayValue(element, role: role, subrole: subrole)
		let frame = frameForElement(element)
		let parentFrame = copyAttribute(element, attribute: kAXParentAttribute as CFString).flatMap(asAXElement).flatMap(frameForElement)
		let centerX = frame.map { $0.midX } ?? 0
		let centerY = frame.map { $0.midY } ?? 0
		var valueSettable = DarwinBoolean(false)
		let valueStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
		var focusedSettable = DarwinBoolean(false)
		let focusedStatus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusedSettable)
		let actions = actionNames(element)
		let canSetValue = valueStatus == .success && valueSettable.boolValue
		let textRoles: Set<String> = [
			"AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField",
		]
		var payload: [String: Any] = [
			key: true,
			"elementRef": refStore.storeElement(element),
			"role": role,
			"subrole": subrole,
			"title": title,
			"description": description,
			"identifier": identifier,
			"value": value,
			"actions": actions,
			"isTextInput": textRoles.contains(role),
			"canSetValue": canSetValue,
			"canFocus": focusedStatus == .success && focusedSettable.boolValue,
			"canPress": actions.contains(kAXPressAction as String),
			"canScroll": supportsAnyScrollAction(element),
			"canIncrement": actions.contains(kAXIncrementAction as String),
			"canDecrement": actions.contains(kAXDecrementAction as String),
			"axVisible": axVisible,
			"x": centerX,
			"y": centerY,
		]
		if let frame {
			payload["frame"] = ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height]
		}
		if let parentFrame {
			payload["parentFrame"] = ["x": parentFrame.origin.x, "y": parentFrame.origin.y, "w": parentFrame.width, "h": parentFrame.height]
		}
		if let score {
			payload["score"] = score
		}
		if let source {
			payload["source"] = source
		}
		return payload
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

	private func sameElement(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
		CFEqual(lhs as CFTypeRef, rhs as CFTypeRef)
	}

	private func isElement(_ element: AXUIElement, descendantOf ancestor: AXUIElement) -> Bool {
		var current: AXUIElement? = element
		var depth = 0
		while let candidate = current, depth < 20 {
			if sameElement(candidate, ancestor) {
				return true
			}
			current = parentElement(candidate)
			depth += 1
		}
		return false
	}

	private func hasAncestorRole(_ element: AXUIElement, role: String) -> Bool {
		var current: AXUIElement? = element
		var depth = 0
		while let candidate = current, depth < 30 {
			if stringAttribute(candidate, attribute: kAXRoleAttribute as CFString) == role { return true }
			current = parentElement(candidate)
			depth += 1
		}
		return false
	}

	private func actionNames(_ element: AXUIElement) -> [String] {
		var actionsValue: CFArray?
		let status = AXUIElementCopyActionNames(element, &actionsValue)
		guard status == .success else { return [] }
		guard let actionsArray = actionsValue as? [AnyObject] else { return [] }
		return actionsArray.compactMap { $0 as? String }
	}

	private func supportsAction(_ element: AXUIElement, action: CFString) -> Bool {
		actionNames(element).contains(action as String)
	}

	private func focusedElement(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		let app = AXUIElementCreateApplication(pid)
		guard let focusedValue = copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString),
			let element = asAXElement(focusedValue)
		else {
			return ["exists": false]
		}
		if windowId != nil || windowRef != nil {
			guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
				return ["exists": false, "reason": "window_not_found"]
			}
			guard isElement(element, descendantOf: window) else {
				return ["exists": false, "reason": "focused_element_outside_window"]
			}
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

	private func axReadText(_ request: [String: Any]) throws -> [String: Any] {
		let elementRef = try stringArg(request, "elementRef")
		let offset = max(0, optionalIntArg(request, "offset") ?? 0)
		let limit = max(1, min(100_000, optionalIntArg(request, "limit") ?? 4_000))
		guard let element = refStore.element(for: elementRef) else {
			throw BridgeFailure(message: "Element reference is no longer valid", code: "element_ref_invalid")
		}
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		guard !isSecureTextElement(role: role, subrole: subrole) else {
			throw BridgeFailure(message: "Refers to a secure text field; refusing to read its value", code: "secure_text_unreadable")
		}
		guard let value = stringAttribute(element, attribute: kAXValueAttribute as CFString) else {
			throw BridgeFailure(message: "Element has no readable AXValue. Call snapshot/screenshot and choose a text-bearing ref.", code: "text_unavailable")
		}
		let characters = Array(value)
		if offset >= characters.count {
			return ["text": "", "offset": offset, "limit": limit, "totalChars": characters.count, "hasMore": false]
		}
		let end = min(characters.count, offset + limit)
		return [
			"text": String(characters[offset..<end]),
			"offset": offset,
			"limit": limit,
			"totalChars": characters.count,
			"hasMore": end < characters.count,
		]
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

	// Secure fields can expose plaintext through AX value in non-native apps,
	// and serialized values flow into the model conversation. Never emit them.
	private func isSecureTextElement(role: String, subrole: String) -> Bool {
		role == "AXSecureTextField" || subrole == "AXSecureTextField"
	}

	private func displayValue(_ element: AXUIElement, role: String, subrole: String) -> String {
		if isSecureTextElement(role: role, subrole: subrole) { return "" }
		return stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? ""
	}

	// kAXSheetsAttribute is unsupported (-25205) on recent macOS; sheets are
	// exposed only as AXSheet-role children. Merge both sources so sheet
	// discovery works across versions.
	private func sheetElements(of window: AXUIElement) -> [AXUIElement] {
		var sheets = axElementArray(window, attribute: "AXSheets" as CFString)
		for child in axElementArray(window, attribute: kAXChildrenAttribute as CFString) {
			guard (stringAttribute(child, attribute: kAXRoleAttribute as CFString) ?? "") == "AXSheet" else { continue }
			if !sheets.contains(where: { CFEqual($0, child) }) { sheets.append(child) }
		}
		return sheets
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

	private func axElementArrayIfPresent(_ element: AXUIElement, attribute: CFString) -> [AXUIElement]? {
		var value: CFTypeRef?
		let status = AXUIElementCopyAttributeValue(element, attribute, &value)
		guard status == .success, let value else { return nil }
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

	private func cgWindowOwners() -> [CGWindowOwnerSummary] {
		guard let entries = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
			return []
		}
		var seen = Set<Int32>()
		var owners: [CGWindowOwnerSummary] = []
		for entry in entries {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != 0 || seen.contains(ownerPid) { continue }
			guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
				bounds.width >= 100,
				bounds.height >= 80
			else {
				continue
			}
			let ownerName = (entry[kCGWindowOwnerName as String] as? String) ?? processName(pid: ownerPid) ?? "Unknown App"
			seen.insert(ownerPid)
			owners.append(CGWindowOwnerSummary(pid: ownerPid, name: ownerName))
		}
		return owners
	}

	private func pidForWindowId(_ windowId: UInt32) -> Int32? {
		windowInfo(windowId: windowId)?.pid
	}

	private func cgWindowCandidates(pid: Int32) -> [CGWindowCandidate] {
		guard let entries = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
			return []
		}

		var candidates: [CGWindowCandidate] = []
		for (zOrder, entry) in entries.enumerated() {
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
					isOnscreen: isOnscreen,
					layer: layer,
					zOrder: zOrder
				)
			)
		}
		return candidates
	}

	private func cgPopupMenuCandidates(pid: Int32?) -> [CGWindowCandidate] {
		guard let entries = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
			return []
		}
		let popupLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
		var candidates: [CGWindowCandidate] = []
		for (zOrder, entry) in entries.enumerated() {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
			if let pid, ownerPid != pid { continue }
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != popupLevel { continue }
			guard let windowNumber = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
				let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
			else { continue }
			let title = (entry[kCGWindowName as String] as? String) ?? ""
			let isOnscreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true
			candidates.append(CGWindowCandidate(windowId: windowNumber, title: title, bounds: bounds, isOnscreen: isOnscreen, layer: layer, zOrder: zOrder))
		}
		return candidates
	}

	private func openMenuElements(pid: Int32) -> [AXUIElement] {
		let app = AXUIElementCreateApplication(pid)
		let descendants = collectDescendants(startingAt: app, maxDepth: 6)
		var menus = descendants.filter { (stringAttribute($0, attribute: kAXRoleAttribute as CFString) ?? "") == "AXMenu" }
		if menus.isEmpty,
			let focused = copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
		{
			var current: AXUIElement? = focused
			while let element = current {
				if (stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? "") == "AXMenu" {
					menus.append(element)
					break
				}
				current = copyAttribute(element, attribute: kAXParentAttribute as CFString).flatMap(asAXElement)
			}
		}
		return menus
	}

	private func bestCandidate(for element: AXUIElement, candidates: [CGWindowCandidate]) -> CGWindowCandidate? {
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let frame = frameForWindow(element)
		return candidates.max { left, right in
			windowPairScore(frame: frame, title: title, candidate: left) < windowPairScore(frame: frame, title: title, candidate: right)
		}
	}

	private func pairingForWindow(_ window: AXUIElement, pid: Int32) -> WindowPairing {
		windowPairings(windows: [window], candidates: cgWindowCandidates(pid: pid))[ObjectIdentifier(window)] ?? WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
	}

	private func windowPairings(windows: [AXUIElement], candidates: [CGWindowCandidate]) -> [ObjectIdentifier: WindowPairing] {
		var pairs: [(window: AXUIElement, candidate: CGWindowCandidate, score: Double)] = []
		for window in windows {
			let title = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			let frame = frameForWindow(window)
			for candidate in candidates {
				pairs.append((window, candidate, windowPairScore(frame: frame, title: title, candidate: candidate)))
			}
		}
		pairs.sort { $0.score > $1.score }
		var output: [ObjectIdentifier: WindowPairing] = [:]
		var usedWindows = Set<ObjectIdentifier>()
		var usedCandidateIds = Set<UInt32>()
		for pair in pairs {
			let key = ObjectIdentifier(pair.window)
			if usedWindows.contains(key) || usedCandidateIds.contains(pair.candidate.windowId) { continue }
			usedWindows.insert(key)
			usedCandidateIds.insert(pair.candidate.windowId)
			let frame = frameForWindow(pair.window)
			let title = stringAttribute(pair.window, attribute: kAXTitleAttribute as CFString) ?? ""
			output[key] = WindowPairing(candidate: pair.score >= 0 ? pair.candidate : nil, score: pair.score, confidence: pairingConfidence(frame: frame, title: title, candidate: pair.candidate, score: pair.score))
		}
		for window in windows {
			let key = ObjectIdentifier(window)
			if output[key] == nil {
				output[key] = WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
			}
		}
		return output
	}

	private func windowPairScore(frame: CGRect, title: String, candidate: CGWindowCandidate) -> Double {
		var score = 0.0
		let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let candidateTitle = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		if !normalizedTitle.isEmpty && !candidateTitle.isEmpty {
			if normalizedTitle == candidateTitle {
				score += 100
			} else if normalizedTitle.contains(candidateTitle) || candidateTitle.contains(normalizedTitle) {
				score += 50
			}
		}
		if frame.width > 1 && frame.height > 1 {
			let dx = abs(candidate.bounds.origin.x - frame.origin.x)
			let dy = abs(candidate.bounds.origin.y - frame.origin.y)
			let dw = abs(candidate.bounds.size.width - frame.size.width)
			let dh = abs(candidate.bounds.size.height - frame.size.height)
			score -= Double(dx + dy + dw + dh) / 20.0
		}
		if candidate.isOnscreen { score += 10 }
		return score
	}

	private func pairingConfidence(frame: CGRect, title: String, candidate: CGWindowCandidate, score: Double) -> String {
		guard frame.width > 1 && frame.height > 1 else { return "low" }
		let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let candidateTitle = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let titleEqual = !normalizedTitle.isEmpty && !candidateTitle.isEmpty && normalizedTitle == candidateTitle
		let geometryExact = abs(frame.origin.x - candidate.bounds.origin.x) <= 2 && abs(frame.origin.y - candidate.bounds.origin.y) <= 2 && abs(frame.width - candidate.bounds.width) <= 2 && abs(frame.height - candidate.bounds.height) <= 2
		if titleEqual && geometryExact { return "exact" }
		if score >= 50 { return "high" }
		return "low"
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

	private func captureWindow(windowId: UInt32) throws -> CapturedWindowImage {
		if #available(macOS 14.0, *) {
			let semaphore = DispatchSemaphore(value: 0)
			let capturedImage = Box<CGImage?>(nil)
			let capturedError = Box<Error?>(nil)

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
					config.ignoreShadowsSingleWindow = true

					let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
					capturedImage.value = image
				} catch {
					capturedError.value = error
				}
			}

			if semaphore.wait(timeout: .now() + .seconds(8)) == .timedOut {
				task.cancel()
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				throw BridgeFailure(message: "Capture timed out while capturing window \(windowId)", code: "capture_timeout")
			}

			if let error = capturedError.value {
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				if let failure = error as? BridgeFailure {
					throw failure
				}
				throw BridgeFailure(message: "Capture failed: \(error.localizedDescription)", code: "capture_failed")
			}

			guard let image = capturedImage.value else {
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				throw BridgeFailure(message: "Capture failed", code: "capture_failed")
			}

			return CapturedWindowImage(image: image, windowId: windowId, frame: currentWindowBounds(windowId: windowId) ?? CGRect(x: 0, y: 0, width: image.width, height: image.height))
		}
		if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
			return payload
		}
		throw BridgeFailure(message: "Capture failed", code: "capture_failed")
	}

	private func jpegData(image: CGImage, quality: Double) -> Data? {
		let data = NSMutableData()
		guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
		CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
		guard CGImageDestinationFinalize(destination) else { return nil }
		return data as Data
	}

	private func downscaledImage(_ image: CGImage, maxDimension: Int?) -> CGImage? {
		guard let maxDimension, max(image.width, image.height) > maxDimension else { return nil }
		let scale = Double(maxDimension) / Double(max(image.width, image.height))
		let width = max(1, Int(Double(image.width) * scale))
		let height = max(1, Int(Double(image.height) * scale))
		guard let context = CGContext(
			data: nil,
			width: width,
			height: height,
			bitsPerComponent: image.bitsPerComponent,
			bytesPerRow: 0,
			space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
			bitmapInfo: image.bitmapInfo.rawValue
		) else { return nil }
		context.interpolationQuality = .medium
		context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
		return context.makeImage()
	}

	private func cgWindowScreenshotFallback(windowId: UInt32) throws -> CapturedWindowImage? {
		if let payload = try systemScreenshotWindow(windowId: windowId) {
			return payload
		}
		return nil
	}

	private func systemScreenshotWindow(windowId: UInt32) throws -> CapturedWindowImage? {
		let tempUrl = FileManager.default.temporaryDirectory.appendingPathComponent("pi-cu-\(UUID().uuidString).png")
		defer { try? FileManager.default.removeItem(at: tempUrl) }
		// Owner-only perms in case TMPDIR ever resolves to a shared directory.
		FileManager.default.createFile(atPath: tempUrl.path, contents: nil, attributes: [.posixPermissions: 0o600])

		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
		process.arguments = ["-x", "-l", String(windowId), tempUrl.path]
		try process.run()
		let deadline = Date().addingTimeInterval(5)
		while process.isRunning && Date() < deadline {
			Thread.sleep(forTimeInterval: 0.05)
		}
		if process.isRunning {
			process.terminate()
			Thread.sleep(forTimeInterval: 0.1)
			if process.isRunning { process.interrupt() }
			return nil
		}
		guard process.terminationStatus == 0 else { return nil }
		guard let data = try? Data(contentsOf: tempUrl), !data.isEmpty else { return nil }
		guard let imageRep = NSBitmapImageRep(data: data), let cgImage = imageRep.cgImage else { return nil }
		return CapturedWindowImage(image: cgImage, windowId: windowId, frame: currentWindowBounds(windowId: windowId) ?? CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
	}

	private func currentWindowBounds(windowId: UInt32) -> CGRect? {
		if #available(macOS 14.0, *), let scBounds = currentWindowBoundsViaScreenCaptureKit(windowId: windowId) {
			return scBounds
		}
		return windowInfo(windowId: windowId)?.bounds
	}

	private func windowInfo(windowId: UInt32) -> (pid: Int32, bounds: CGRect)? {
		guard let entries = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId)) as? [[String: Any]],
			let first = entries.first,
			let pid = (first[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
			let boundsDict = first[kCGWindowBounds as String] as? [String: Any],
			let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
		else {
			return nil
		}
		return (pid, bounds)
	}

	@available(macOS 14.0, *)
	private func currentWindowBoundsViaScreenCaptureKit(windowId: UInt32) -> CGRect? {
		let semaphore = DispatchSemaphore(value: 0)
		let output = Box<CGRect?>(nil)

		let task = Task {
			defer { semaphore.signal() }
			do {
				if Task.isCancelled {
					return
				}
				let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
				if let window = shareable.windows.first(where: { $0.windowID == windowId }) {
					output.value = window.frame
				}
			} catch {
				output.value = nil
			}
		}

		if semaphore.wait(timeout: .now() + .seconds(2)) == .timedOut {
			task.cancel()
			return nil
		}
		return output.value
	}

	private func eventDelivery(_ request: [String: Any]) -> String {
		optionalStringArg(request, "delivery") == "pid" ? "pid" : "hid"
	}

	private func postEvent(_ event: CGEvent, pid: Int32, delivery: String = "hid") {
		if delivery == "pid" {
			event.postToPid(pid)
			return
		}
		// Post as a real foreground HID event. AppKit views with mouseDown handlers
		// can ignore pid-targeted CGEvents even though postToPid reports success.
		// Keep the target app frontmost so the HID event is delivered to the intended
		// window, then post at the session event tap.
		if let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
			if #available(macOS 14.0, *) {
				_ = app.activate()
			} else {
				_ = app.activate(options: [.activateIgnoringOtherApps])
			}
			usleep(20_000)
		}
		event.post(tap: .cghidEventTap)
	}

	private func postMouseMove(to point: CGPoint, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
			throw BridgeFailure(message: "Failed to create mouse move event", code: "input_failed")
		}
		postEvent(move, pid: pid, delivery: delivery)
	}

	private func mouseButton(_ name: String) -> CGMouseButton {
		switch name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
		case "right":
			return .right
		case "middle", "center":
			return .center
		default:
			return .left
		}
	}

	private func mouseDownType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDown
		case .center:
			return .otherMouseDown
		default:
			return .leftMouseDown
		}
	}

	private func mouseUpType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseUp
		case .center:
			return .otherMouseUp
		default:
			return .leftMouseUp
		}
	}

	private func mouseDraggedType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDragged
		case .center:
			return .otherMouseDragged
		default:
			return .leftMouseDragged
		}
	}

	private func postMouseClick(at point: CGPoint, pid: Int32, button: CGMouseButton = .left, clickCount: Int = 1, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try postMouseMove(to: point, pid: pid, delivery: delivery)
		for index in 1...max(1, clickCount) {
			guard let down = CGEvent(mouseEventSource: nil, mouseType: mouseDownType(for: button), mouseCursorPosition: point, mouseButton: button),
				let up = CGEvent(mouseEventSource: nil, mouseType: mouseUpType(for: button), mouseCursorPosition: point, mouseButton: button)
			else {
				throw BridgeFailure(message: "Failed to create mouse click event", code: "input_failed")
			}
			down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
			up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
			postEvent(down, pid: pid, delivery: delivery)
			usleep(12_000)
			postEvent(up, pid: pid, delivery: delivery)
			if index < clickCount {
				usleep(70_000)
			}
		}
	}

	private func postMouseDrag(points: [CGPoint], pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard points.count >= 2, let first = points.first else {
			throw BridgeFailure(message: "Drag requires at least two points", code: "invalid_args")
		}
		try postMouseMove(to: first, pid: pid, delivery: delivery)
		guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: first, mouseButton: .left) else {
			throw BridgeFailure(message: "Failed to create mouse down event", code: "input_failed")
		}
		postEvent(down, pid: pid, delivery: delivery)
		usleep(12_000)

		for point in points.dropFirst() {
			guard let drag = CGEvent(mouseEventSource: nil, mouseType: mouseDraggedType(for: .left), mouseCursorPosition: point, mouseButton: .left) else {
				throw BridgeFailure(message: "Failed to create mouse drag event", code: "input_failed")
			}
			postEvent(drag, pid: pid, delivery: delivery)
			usleep(8_000)
		}

		guard let last = points.last,
			let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: last, mouseButton: .left)
		else {
			throw BridgeFailure(message: "Failed to create mouse up event", code: "input_failed")
		}
		postEvent(up, pid: pid, delivery: delivery)
	}

	private func postScrollWheel(at point: CGPoint, deltaX: Int, deltaY: Int, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try postMouseMove(to: point, pid: pid, delivery: delivery)
		guard let event = CGEvent(
			scrollWheelEvent2Source: nil,
			units: .pixel,
			wheelCount: 2,
			wheel1: Int32(-deltaY),
			wheel2: Int32(deltaX),
			wheel3: 0
		) else {
			throw BridgeFailure(message: "Failed to create scroll event", code: "input_failed")
		}
		event.location = point
		postEvent(event, pid: pid, delivery: delivery)
	}

	private func modifierFlag(_ key: String) -> CGEventFlags? {
		switch key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
		case "cmd", "command", "meta":
			return .maskCommand
		case "ctrl", "control":
			return .maskControl
		case "shift":
			return .maskShift
		case "option", "alt":
			return .maskAlternate
		default:
			return nil
		}
	}

	private func keyCode(_ key: String) -> CGKeyCode? {
		let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let table: [String: CGKeyCode] = [
			"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
			"q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
			"6": 22, "5": 23, "=": 24, "+": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
			"]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36,
			"l": 37, "j": 38, "'": 39, "\"": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
			"n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, " ": 49, "`": 50, "~": 50,
			"backspace": 51, "delete": 51, "del": 51, "esc": 53, "escape": 53,
			"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
			"f9": 101, "f10": 109, "f11": 103, "f12": 111,
			"home": 115, "pageup": 116, "page_up": 116, "page down": 121, "pagedown": 121, "page_down": 121,
			"forwarddelete": 117, "forward_delete": 117, "end": 119,
			"left": 123, "arrowleft": 123, "arrow_left": 123,
			"right": 124, "arrowright": 124, "arrow_right": 124,
			"down": 125, "arrowdown": 125, "arrow_down": 125,
			"up": 126, "arrowup": 126, "arrow_up": 126,
		]
		return table[normalized]
	}

	private func keyChord(_ keys: [String]) -> (flags: CGEventFlags, key: String)? {
		guard keys.count >= 2 else { return nil }
		var flags = CGEventFlags()
		for key in keys.dropLast() {
			guard let flag = modifierFlag(key) else {
				return nil
			}
			flags.insert(flag)
		}
		return (flags, keys.last ?? "")
	}

	private func postKeyPress(keys: [String], pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		if let chord = keyChord(keys) {
			try postKey(chord.key, flags: chord.flags, pid: pid, delivery: delivery)
			return
		}

		for key in keys {
			let parts = key
				.split(separator: "+")
				.map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
				.filter { !$0.isEmpty }
			if let chord = keyChord(parts) {
				try postKey(chord.key, flags: chord.flags, pid: pid, delivery: delivery)
			} else {
				try postKey(key, flags: [], pid: pid, delivery: delivery)
			}
		}
	}

	private func postKey(_ key: String, flags: CGEventFlags, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let code = keyCode(key) else {
			if key.count == 1 {
				try postUnicodeText(key, pid: pid, delivery: delivery)
				return
			}
			throw BridgeFailure(message: "Unsupported key '\(key)'", code: "invalid_args")
		}
		guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
			let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
		else {
			throw BridgeFailure(message: "Failed to create key event", code: "input_failed")
		}
		down.flags = flags
		up.flags = flags
		postEvent(down, pid: pid, delivery: delivery)
		postEvent(up, pid: pid, delivery: delivery)
		usleep(8_000)
	}

	private func postUnicodeText(_ text: String, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		for scalar in text.unicodeScalars {
			let char = String(scalar)
			if let stroke = physicalKeyStroke(for: char) {
				try postKey(stroke.key, flags: stroke.flags, pid: pid, delivery: delivery)
				continue
			}
			guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
				let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
			else {
				throw BridgeFailure(message: "Failed to create unicode key event", code: "input_failed")
			}
			setUnicodeString(event: down, text: char)
			setUnicodeString(event: up, text: char)
			postEvent(down, pid: pid, delivery: delivery)
			postEvent(up, pid: pid, delivery: delivery)
			usleep(8_000)
		}
	}

	private func postAtomicUnicodeText(_ text: String, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
			let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
		else { throw BridgeFailure(message: "Failed to create unicode text event", code: "input_failed") }
		setUnicodeString(event: down, text: text)
		setUnicodeString(event: up, text: text)
		postEvent(down, pid: pid, delivery: delivery)
		usleep(8_000)
		postEvent(up, pid: pid, delivery: delivery)
	}

	/// Prefer physical key codes for characters represented by the US layout.
	/// AppKit field editors can observe synthetic Unicode events without applying
	/// them to the backing value, while normal key codes follow the same input
	/// path as a user keystroke. Unicode synthesis remains the fallback for text
	/// that has no direct key representation.
	private func physicalKeyStroke(for character: String) -> (key: String, flags: CGEventFlags)? {
		guard character.count == 1 else { return nil }
		if character >= "a" && character <= "z" { return (character, []) }
		if character >= "A" && character <= "Z" { return (character.lowercased(), [.maskShift]) }
		if character >= "0" && character <= "9" { return (character, []) }
		switch character {
		case " ": return ("space", [])
		case ".", ",", "/", "-", "=", ";", "'", "[", "]", "\\", "`": return (character, [])
		case "_": return ("-", [.maskShift])
		case "+": return ("=", [.maskShift])
		case ":": return (";", [.maskShift])
		case "\"": return ("'", [.maskShift])
		case "?": return ("/", [.maskShift])
		case "<": return (",", [.maskShift])
		case ">": return (".", [.maskShift])
		default: return nil
		}
	}

	private func setUnicodeString(event: CGEvent, text: String) {
		var utf16 = Array(text.utf16)
		utf16.withUnsafeMutableBufferPointer { buffer in
			guard let base = buffer.baseAddress else { return }
			event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
		}
	}

}

@main
struct PiComputerUseHelper {
	static func main() {
		_ = NSApplication.shared
		NSApp.setActivationPolicy(CommandLine.arguments.contains("serve") ? .accessory : .prohibited)
		Bridge().run()
	}
}
