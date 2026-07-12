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

/// Main-display-only, click-through overlay that can never take focus.
public final class AgentCursorOverlayWindow: NSWindow {
    public override var canBecomeKey: Bool { false }
    public override var canBecomeMain: Bool { false }

    public convenience init() {
        let frame = AgentCursorOverlayWindow.mainScreenFrame()
        self.init(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        level = .normal
        collectionBehavior = [
            .canJoinAllSpaces, .fullScreenAuxiliary, .stationary,
        ]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }

    private static func mainScreenFrame() -> NSRect {
        return NSScreen.main?.frame ?? NSScreen.screens.first?.frame ?? .zero
    }
}

@MainActor
public struct AgentCursorView: View {
    @Bindable var renderer: AgentCursorRenderer

    public init() {
        self.renderer = .shared
    }

    public init(renderer: AgentCursorRenderer) {
        self.renderer = renderer
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 120.0)) { ctx in
            Canvas { gctx, size in
                renderer.tick(now: ctx.date.timeIntervalSinceReferenceDate)
                drawFocusRect(in: gctx, canvasSize: size)
                drawCursor(in: gctx)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    private func drawFocusRect(in ctx: GraphicsContext, canvasSize: CGSize) {
        guard let screenRect = renderer.focusRect else { return }
        let r = CGRect(
            x: screenRect.minX,
            y: screenRect.minY,
            width: screenRect.width,
            height: screenRect.height
        )
        let cornerRadius: CGFloat = 4
        let rounded = Path(roundedRect: r, cornerRadius: cornerRadius)
        let baseColor = Color(nsColor: renderer.style.bloomColor)

        ctx.fill(rounded, with: .color(baseColor.opacity(0.08)))
        ctx.stroke(rounded, with: .color(baseColor.opacity(0.90)), lineWidth: 2)
        ctx.stroke(rounded, with: .color(baseColor.opacity(0.30)), lineWidth: 8)
    }

    private func drawCursor(in ctx: GraphicsContext) {
        let p = renderer.position
        guard p.x > -100 else { return }   // skip until first moveTo

        let style = renderer.style
        let bloomColor = Color(nsColor: style.bloomColor)
        let bloomR: CGFloat = 22
        let bloomRect = CGRect(x: p.x - bloomR, y: p.y - bloomR,
                               width: bloomR * 2, height: bloomR * 2)

        ctx.fill(
            Path(ellipseIn: bloomRect),
            with: .radialGradient(
                Gradient(colors: [
                    bloomColor.opacity(style.bloomCenterAlpha),
                    bloomColor.opacity(style.bloomMidAlpha),
                    bloomColor.opacity(0),
                ]),
                center: p,
                startRadius: 0,
                endRadius: bloomR
            )
        )

        if let nsImage = style.image {
            var imgCtx = ctx
            imgCtx.translateBy(x: p.x, y: p.y)
            imgCtx.rotate(by: Angle(radians: renderer.heading + .pi))
            let s = style.shapeSize
            imgCtx.draw(Image(nsImage: nsImage),
                        in: CGRect(x: -s / 2, y: -s / 2, width: s, height: s))
        } else {
            let points = [
                CGPoint(x: 14, y: 0),
                CGPoint(x: -8, y: -9),
                CGPoint(x: -3, y: 0),
                CGPoint(x: -8, y: 9),
            ]
            var shape = Path()
            for index in points.indices {
                let previous = points[(index + points.count - 1) % points.count]
                let current = points[index]
                let next = points[(index + 1) % points.count]
                let entry = CGPoint(x: current.x + (previous.x - current.x) * 0.16, y: current.y + (previous.y - current.y) * 0.16)
                let exit = CGPoint(x: current.x + (next.x - current.x) * 0.16, y: current.y + (next.y - current.y) * 0.16)
                if index == points.startIndex { shape.move(to: entry) } else { shape.addLine(to: entry) }
                shape.addQuadCurve(to: exit, control: current)
            }
            shape.closeSubpath()

            let transform = CGAffineTransform(translationX: p.x, y: p.y)
                .rotated(by: CGFloat(renderer.heading + .pi))
            let transformed = shape.applying(transform)

            let gradientColors = style.strokeGradientStops.isEmpty
                ? AgentCursorStyle.defaultGradientStops.map { Color(nsColor: $0.color) }
                : style.strokeGradientStops.map { Color(nsColor: $0.color) }

            ctx.fill(
                transformed,
                with: .linearGradient(
                    Gradient(colors: gradientColors),
                    startPoint: CGPoint(x: p.x + 14, y: p.y - 9),
                    endPoint: CGPoint(x: p.x - 8, y: p.y + 9)
                )
            )
            ctx.stroke(transformed, with: .color(.white), lineWidth: style.strokeWidth)
        }
    }
}
