import AppKit
import QuartzCore

private let agentCursorBloomColor = NSColor(
	calibratedRed: 1,
	green: 0x78 / 255,
	blue: 0x18 / 255,
	alpha: 1
)

private final class ActivityGlowView: NSView {
	private let edgeWidth: CGFloat = 30
	private let edges = (0..<4).map { _ in CAGradientLayer() }
	private let border = CALayer()

	override init(frame frameRect: NSRect) {
		super.init(frame: frameRect)
		wantsLayer = true
		layer?.masksToBounds = true

		let strong = agentCursorBloomColor.withAlphaComponent(0.72).cgColor
		let soft = agentCursorBloomColor.withAlphaComponent(0.22).cgColor
		let clear = agentCursorBloomColor.withAlphaComponent(0).cgColor

		for edge in edges {
			edge.colors = [strong, soft, clear]
			edge.locations = [0, 0.35, 1]
			layer?.addSublayer(edge)
		}

		border.borderColor = agentCursorBloomColor.withAlphaComponent(0.9).cgColor
		border.borderWidth = 2
		layer?.addSublayer(border)

		let pulse = CAKeyframeAnimation(keyPath: "opacity")
		pulse.values = [0.72, 1, 0.72]
		pulse.keyTimes = [0, 0.5, 1]
		pulse.duration = 1.8
		pulse.repeatCount = .infinity
		pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
		layer?.add(pulse, forKey: "computer-use-activity-pulse")
	}

	required init?(coder: NSCoder) {
		fatalError("init(coder:) has not been implemented")
	}

	override func layout() {
		super.layout()

		let width = bounds.width
		let height = bounds.height

		edges[0].frame = CGRect(x: 0, y: height - edgeWidth, width: width, height: edgeWidth)
		edges[0].startPoint = CGPoint(x: 0.5, y: 1)
		edges[0].endPoint = CGPoint(x: 0.5, y: 0)

		edges[1].frame = CGRect(x: 0, y: 0, width: width, height: edgeWidth)
		edges[1].startPoint = CGPoint(x: 0.5, y: 0)
		edges[1].endPoint = CGPoint(x: 0.5, y: 1)

		edges[2].frame = CGRect(x: 0, y: 0, width: edgeWidth, height: height)
		edges[2].startPoint = CGPoint(x: 0, y: 0.5)
		edges[2].endPoint = CGPoint(x: 1, y: 0.5)

		edges[3].frame = CGRect(x: width - edgeWidth, y: 0, width: edgeWidth, height: height)
		edges[3].startPoint = CGPoint(x: 1, y: 0.5)
		edges[3].endPoint = CGPoint(x: 0, y: 0.5)

		border.frame = bounds
	}
}

final class ActivityGlowController: NSObject {
	private let stateLock = NSLock()
	private var activeClients = Set<UUID>()
	private var windows: [NSWindow] = []
	private var visible = false

	override init() {
		super.init()
		NotificationCenter.default.addObserver(
			self,
			selector: #selector(screensChanged),
			name: NSApplication.didChangeScreenParametersNotification,
			object: nil
		)
		rebuildWindows()
	}

	deinit {
		NotificationCenter.default.removeObserver(self)
	}

	func setActive(_ active: Bool, for clientID: UUID) {
		stateLock.lock()
		if active {
			activeClients.insert(clientID)
		} else {
			activeClients.remove(clientID)
		}
		stateLock.unlock()
		DispatchQueue.main.async { [weak self] in
			self?.syncVisibility()
		}
	}

	func disconnect(_ clientID: UUID) {
		setActive(false, for: clientID)
	}

	var isActive: Bool {
		stateLock.lock()
		defer { stateLock.unlock() }
		return !activeClients.isEmpty
	}

	@objc private func screensChanged() {
		rebuildWindows()
	}

	private func rebuildWindows() {
		windows.forEach { $0.close() }
		windows = NSScreen.screens.map(makeWindow)
		if visible {
			windows.forEach { $0.orderFrontRegardless() }
		}
	}

	private func makeWindow(for screen: NSScreen) -> NSWindow {
		let window = NSWindow(
			contentRect: screen.frame,
			styleMask: .borderless,
			backing: .buffered,
			defer: false,
			screen: screen
		)
		window.setFrame(screen.frame, display: true)
		window.backgroundColor = .clear
		window.isOpaque = false
		window.hasShadow = false
		window.ignoresMouseEvents = true
		window.isReleasedWhenClosed = false
		window.sharingType = .readOnly
		window.setAccessibilityElement(false)
		window.level = .screenSaver
		window.collectionBehavior = [
			.canJoinAllSpaces,
			.stationary,
			.fullScreenAuxiliary,
			.ignoresCycle,
		]
		let glowView = ActivityGlowView(frame: NSRect(origin: .zero, size: screen.frame.size))
		glowView.setAccessibilityElement(false)
		window.contentView = glowView
		return window
	}

	private func syncVisibility() {
		let shouldShow = isActive
		guard visible != shouldShow else { return }
		visible = shouldShow
		if shouldShow {
			windows.forEach { $0.orderFrontRegardless() }
		} else {
			windows.forEach { $0.orderOut(nil) }
		}
	}
}
