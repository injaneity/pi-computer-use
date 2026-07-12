import AppKit
import SwiftUI

public struct AgentCursorGradientStop: @unchecked Sendable {
    public let color: NSColor
    public let location: CGFloat
    public init(color: NSColor, location: CGFloat) {
        self.color = color
        self.location = location
    }
}

public struct AgentCursorStyle: @unchecked Sendable {
    public let containerSize: CGFloat
    public let shapeSize: CGFloat
    public let strokeGradientStops: [AgentCursorGradientStop]
    public let strokeGradientAngleDegrees: CGFloat
    public let strokeWidth: CGFloat
    public let highlightStrokeWidth: CGFloat
    public let bloomColor: NSColor
    public let bloomCenterAlpha: CGFloat
    public let bloomMidAlpha: CGFloat
    public let bloomBreathPeak: CGFloat
    public let image: NSImage?

    public init(
        containerSize: CGFloat = 60,
        shapeSize: CGFloat = 22,
        strokeGradientStops: [AgentCursorGradientStop] = AgentCursorStyle.defaultGradientStops,
        strokeGradientAngleDegrees: CGFloat = 135,
        strokeWidth: CGFloat = 2,
        highlightStrokeWidth: CGFloat = 0.5,
        bloomColor: NSColor = NSColor(red: 1, green: 0x78 / 255, blue: 0x18 / 255, alpha: 1),
        bloomCenterAlpha: CGFloat = 0.55,
        bloomMidAlpha: CGFloat = 0.15,
        bloomBreathPeak: CGFloat = 0.75,
        image: NSImage? = nil
    ) {
        self.containerSize = containerSize
        self.shapeSize = shapeSize
        self.strokeGradientStops = strokeGradientStops
        self.strokeGradientAngleDegrees = strokeGradientAngleDegrees
        self.strokeWidth = strokeWidth
        self.highlightStrokeWidth = highlightStrokeWidth
        self.bloomColor = bloomColor
        self.bloomCenterAlpha = bloomCenterAlpha
        self.bloomMidAlpha = bloomMidAlpha
        self.bloomBreathPeak = bloomBreathPeak
        self.image = image
    }

    public static let defaultGradientStops: [AgentCursorGradientStop] = [
        AgentCursorGradientStop(color: NSColor(red: 1, green: 0xD0 / 255, blue: 0x76 / 255, alpha: 1), location: 0.0),
        AgentCursorGradientStop(color: NSColor(red: 1, green: 0x78 / 255, blue: 0x18 / 255, alpha: 1), location: 0.53),
        AgentCursorGradientStop(color: NSColor(red: 0xE8 / 255, green: 0x4A / 255, blue: 0x0C / 255, alpha: 1), location: 1.0),
    ]

    public static let `default` = AgentCursorStyle()
}

/// Visual-only cursor; native action delivery remains authoritative.
@MainActor
public final class AgentCursor {
    public static let shared = AgentCursor()

    private var overlay: AgentCursorOverlayWindow?
    private var idleHideTask: Task<Void, Never>?

    private init() {}

    public func animate(to point: CGPoint, above windowId: UInt32) {
        let window = ensureWindow()
        if !window.isVisible { window.orderFrontRegardless() }
        window.order(.above, relativeTo: Int(windowId))

        let renderer = AgentCursorRenderer.shared
        if renderer.position.x < -100 {
            let frame = NSScreen.main?.frame ?? .zero
            let start = CGPoint(
                x: min(max(point.x - 140, frame.minX + 2), frame.maxX - 2),
                y: min(max(point.y - 140, frame.minY + 2), frame.maxY - 2)
            )
            renderer.setInitialPosition(start)
        }
        renderer.moveTo(point: point, endAngleDegrees: 45)
    }

    public func finishAction() {
        idleHideTask?.cancel()
        idleHideTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled else { return }
            self?.overlay?.orderOut(nil)
        }
    }

    private func ensureWindow() -> AgentCursorOverlayWindow {
        if let overlay { return overlay }
        let window = AgentCursorOverlayWindow()
        window.contentView = NSHostingView(rootView: AgentCursorView())
        overlay = window
        return window
    }
}
