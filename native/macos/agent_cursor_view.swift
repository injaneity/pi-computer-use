import AppKit
import SwiftUI

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
