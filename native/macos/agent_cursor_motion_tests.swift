import CoreGraphics
import Foundation

@main
struct AgentCursorMotionTests {
    @MainActor
    static func main() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 100, y: 100))

        expect(!renderer.isAnimating, "renderer should start idle")

        renderer.moveTo(point: CGPoint(x: 500, y: 400))
        expect(renderer.isAnimating, "renderer should become active when motion starts")

        var now: CFTimeInterval = 0
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        expect(!renderer.isAnimating, "renderer should become idle after motion settles")

        renderer.moveTo(point: CGPoint(x: 800, y: 600))
        renderer.tick(now: now + 1.0 / 120.0)
        let stoppedPosition = renderer.position

        renderer.cancelAnimation()
        expect(!renderer.isAnimating, "cancelled motion should become idle")

        renderer.tick(now: now + 1)
        expect(renderer.position == stoppedPosition, "idle ticks should not change the cancelled position")

        renderer.setInitialPosition(CGPoint(x: 100, y: 100))
        renderer.moveTo(point: CGPoint(x: 300, y: 300))
        for _ in 0..<12 {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }
        let latestTarget = CGPoint(x: 900, y: 700)
        renderer.moveTo(point: latestTarget)
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        let endpointOffset = CGFloat(cos(Double.pi / 4) * 16)
        let expectedPosition = CGPoint(
            x: latestTarget.x + endpointOffset,
            y: latestTarget.y + endpointOffset
        )
        expect(distance(renderer.position, expectedPosition) < 0.001, "latest target should supersede in-flight motion")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else {
            FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
            exit(1)
        }
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }
}
