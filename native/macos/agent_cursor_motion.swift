import CoreGraphics
import Foundation
import Observation

/// Main-actor Dubins-path animation state consumed by the SwiftUI overlay.
@Observable
@MainActor
public final class AgentCursorRenderer {
    public static let shared = AgentCursorRenderer()

    public var turnRadius: Double = 80

    public var peakSpeed: Double = 900

    public var minStartSpeed: Double = 300

    public var minEndSpeed: Double = 200

    public var clickOffset: Double = 16

    public var easing: Easing = .smootherstep

    public var springStiffness: Double = 400
    public var springDamping: Double = 17
    public var springOvershoot: Double = 0.8

    private(set) public var position: CGPoint = .init(x: -200, y: -200)
    private(set) public var heading: Double = .pi / 4  // ~NW, like the OS cursor
    public var focusRect: CGRect? = nil

    public var style: AgentCursorStyle = .default

    private var path: PlannedPath?
    private var trip: Trip?
    private var spring: Spring?
    private var distanceSoFar: Double = 0
    private var lastFrameTime: CFTimeInterval?
    private var springTarget: (point: CGPoint, heading: Double)?

    public init() {}

    public func moveTo(point: CGPoint, endAngleDegrees: Double) {
        moveTo(point: point, endAngleRadians: endAngleDegrees * .pi / 180)
    }

    public func moveTo(point clickPoint: CGPoint, endAngleRadians endAngle: Double) {
        let R = max(1, turnRadius)
        let tx = clickPoint.x + CGFloat(cos(endAngle)) * CGFloat(clickOffset)
        let ty = clickPoint.y + CGFloat(sin(endAngle)) * CGFloat(clickOffset)
        let targetPoint = CGPoint(x: tx, y: ty)
        let sMotion = heading + .pi
        let tMotion = endAngle + .pi
        path = planPath(
            x0: Double(position.x), y0: Double(position.y), th0: sMotion,
            x1: Double(targetPoint.x), y1: Double(targetPoint.y), th1: tMotion,
            R: R, endVisualHeading: endAngle, targetPoint: targetPoint)
        trip = Trip(peak: peakSpeed,
                    minStart: min(minStartSpeed, peakSpeed),
                    minEnd: min(minEndSpeed, peakSpeed),
                    easing: easing)
        spring = nil; springTarget = nil; distanceSoFar = 0
    }

    public func setInitialPosition(_ point: CGPoint, heading h: Double? = nil) {
        position = point
        heading = h ?? self.heading
        path = nil; trip = nil; spring = nil; springTarget = nil
        distanceSoFar = 0; lastFrameTime = nil
    }

    public func tick(now: CFTimeInterval) {
        let prev = lastFrameTime ?? now
        let dt = min(0.05, now - prev)
        lastFrameTime = now

        if let p = path, let t = trip {
            let u = min(1.0, distanceSoFar / max(p.length, 1))
            let profileValue = t.easing.profile(at: u)
            let floorSpeed = (u < 0.5) ? t.minStart : t.minEnd
            let currentSpeed = floorSpeed + (t.peak - floorSpeed) * profileValue
            distanceSoFar += currentSpeed * dt

            if distanceSoFar >= p.length {
                let endState = p.sample(at: p.length)
                let vx = cos(endState.heading) * currentSpeed * springOvershoot
                let vy = sin(endState.heading) * currentSpeed * springOvershoot
                spring = Spring(ox: 0, oy: 0, vx: vx, vy: vy)
                springTarget = (p.targetPoint, p.endVisualHeading)
                position = p.targetPoint; heading = p.endVisualHeading
                path = nil; trip = nil; distanceSoFar = 0
            } else {
                let st = p.sample(at: distanceSoFar)
                position = CGPoint(x: st.x, y: st.y)
                heading = rotateToward(current: heading,
                                       desired: st.heading + .pi,
                                       maxStep: 14 * dt)
            }
        } else if var s = spring, let tgt = springTarget {
            let k = springStiffness, c = springDamping
            let substeps = 4; let sdt = dt / Double(substeps)
            for _ in 0..<substeps {
                s.vx += (-k * s.ox - c * s.vx) * sdt
                s.vy += (-k * s.oy - c * s.vy) * sdt
                s.ox += s.vx * sdt; s.oy += s.vy * sdt
            }
            position = CGPoint(x: tgt.point.x + CGFloat(s.ox),
                               y: tgt.point.y + CGFloat(s.oy))
            heading = tgt.heading
            if hypot(s.ox, s.oy) < 0.3 && hypot(s.vx, s.vy) < 2 {
                position = tgt.point; spring = nil; springTarget = nil
            } else { spring = s }
        }
    }

    private func rotateToward(current: Double, desired: Double, maxStep: Double) -> Double {
        var diff = desired - current
        while diff > .pi  { diff -= 2 * .pi }
        while diff < -.pi { diff += 2 * .pi }
        return current + max(-maxStep, min(maxStep, diff))
    }
}

public extension AgentCursorRenderer {
    enum Easing: String, CaseIterable, Sendable {
        case linear, smoothstep, smootherstep, cubic, quint

        func profile(at u: Double) -> Double {
            switch self {
            case .linear:       return 1
            case .smoothstep:   return (6 * u * (1 - u)) / 1.5
            case .smootherstep: return (30 * u * u * (1 - u) * (1 - u)) / 1.875
            case .cubic:        return ((u < 0.5) ? 12 * u * u : 12 * (1 - u) * (1 - u)) / 6
            case .quint:        return ((u < 0.5) ? 80 * pow(u, 4) : 80 * pow(1 - u, 4)) / 5
            }
        }
    }
}

private struct Trip {
    let peak, minStart, minEnd: Double
    let easing: AgentCursorRenderer.Easing
}

private struct Spring { var ox, oy, vx, vy: Double }

struct DubinsPlannedPath {
    enum Kind { case dubins, linear }
    let kind: Kind
    let length: Double
    let endVisualHeading: Double
    let targetPoint: CGPoint
    let x0, y0, th0, R, seg1, seg2, seg3: Double
    let types: [Character]
    let x1, y1, th1: Double

    struct State { let x, y, heading: Double }

    func sample(at s: Double) -> State {
        switch kind { case .linear: return sampleLinear(s); case .dubins: return sampleDubins(s) }
    }

    private func sampleLinear(_ s: Double) -> State {
        let u = max(0, min(1, s / length))
        var diff = th1 - th0
        while diff > .pi  { diff -= 2 * .pi }
        while diff < -.pi { diff += 2 * .pi }
        return State(x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, heading: th0 + diff * u)
    }

    private func sampleDubins(_ sIn: Double) -> State {
        guard sIn > 0 else { return State(x: x0, y: y0, heading: th0) }
        let L1 = seg1 * R, L2 = seg2 * R, L3 = seg3 * R
        let s = min(sIn, L1 + L2 + L3)
        var x = x0, y = y0, th = th0

        func advance(length L: Double, type: Character) {
            if type == "S" { x += cos(th) * L; y += sin(th) * L }
            else {
                let dth = L / R * (type == "L" ? 1.0 : -1.0)
                let perp: Double = (type == "L") ? .pi / 2 : -.pi / 2
                let cx = x + cos(th + perp) * R, cy = y + sin(th + perp) * R
                let ang = atan2(y - cy, x - cx)
                x = cx + cos(ang + dth) * R; y = cy + sin(ang + dth) * R; th += dth
            }
        }
        if s <= L1 { advance(length: s, type: types[0]); return State(x: x, y: y, heading: th) }
        advance(length: L1, type: types[0])
        if s <= L1 + L2 { advance(length: s - L1, type: types[1]); return State(x: x, y: y, heading: th) }
        advance(length: L2, type: types[1])
        advance(length: s - L1 - L2, type: types[2])
        return State(x: x, y: y, heading: th)
    }
}

private typealias PlannedPath = DubinsPlannedPath

private func mod2pi(_ x: Double) -> Double {
    let tau = 2 * Double.pi; let r = x - tau * floor(x / tau); return r < 0 ? r + tau : r
}

private struct DubinsSolution { let t, p, q: Double; let types: [Character]; var length: Double { t + p + q } }

private func dubinsLSL(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp0 = d + sin(a) - sin(b)
    let p2 = 2 + d * d - 2 * cos(a - b) + 2 * d * (sin(a) - sin(b))
    guard p2 >= 0 else { return nil }
    let tmp1 = atan2(cos(b) - cos(a), tmp0)
    return DubinsSolution(t: mod2pi(-a + tmp1), p: sqrt(p2), q: mod2pi(b - tmp1), types: ["L","S","L"])
}
private func dubinsRSR(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp0 = d - sin(a) + sin(b)
    let p2 = 2 + d * d - 2 * cos(a - b) + 2 * d * (sin(b) - sin(a))
    guard p2 >= 0 else { return nil }
    let tmp1 = atan2(cos(a) - cos(b), tmp0)
    return DubinsSolution(t: mod2pi(a - tmp1), p: sqrt(p2), q: mod2pi(-b + tmp1), types: ["R","S","R"])
}
private func dubinsLSR(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let p2 = -2 + d * d + 2 * cos(a - b) + 2 * d * (sin(a) + sin(b))
    guard p2 >= 0 else { return nil }
    let p = sqrt(p2)
    let tmp1 = atan2(-cos(a) - cos(b), d + sin(a) + sin(b)) - atan2(-2, p)
    return DubinsSolution(t: mod2pi(-a + tmp1), p: p, q: mod2pi(-mod2pi(b) + tmp1), types: ["L","S","R"])
}
private func dubinsRSL(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let p2 = d * d - 2 + 2 * cos(a - b) - 2 * d * (sin(a) + sin(b))
    guard p2 >= 0 else { return nil }
    let p = sqrt(p2)
    let tmp1 = atan2(cos(a) + cos(b), d - sin(a) - sin(b)) - atan2(2, p)
    return DubinsSolution(t: mod2pi(a - tmp1), p: p, q: mod2pi(b - tmp1), types: ["R","S","L"])
}
private func dubinsRLR(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp = (6 - d * d + 2 * cos(a - b) + 2 * d * (sin(a) - sin(b))) / 8
    guard abs(tmp) <= 1 else { return nil }
    let p = mod2pi(2 * .pi - acos(tmp))
    let t = mod2pi(a - atan2(cos(a) - cos(b), d - sin(a) + sin(b)) + p / 2)
    return DubinsSolution(t: t, p: p, q: mod2pi(a - b - t + p), types: ["R","L","R"])
}
private func dubinsLRL(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp = (6 - d * d + 2 * cos(a - b) + 2 * d * (sin(b) - sin(a))) / 8
    guard abs(tmp) <= 1 else { return nil }
    let p = mod2pi(2 * .pi - acos(tmp))
    let t = mod2pi(-a + atan2(-cos(a) + cos(b), d + sin(a) - sin(b)) + p / 2)
    return DubinsSolution(t: t, p: p, q: mod2pi(mod2pi(b) - a - t + p), types: ["L","R","L"])
}

private func planPath(x0: Double, y0: Double, th0: Double,
                      x1: Double, y1: Double, th1: Double,
                      R: Double, endVisualHeading: Double,
                      targetPoint: CGPoint) -> PlannedPath {
    if let p = planDubins(x0: x0, y0: y0, th0: th0, x1: x1, y1: y1, th1: th1,
                          R: R, endVisualHeading: endVisualHeading, targetPoint: targetPoint) {
        return p
    }
    let D = max(1, hypot(x1 - x0, y1 - y0))
    return PlannedPath(kind: .linear, length: D, endVisualHeading: endVisualHeading,
                       targetPoint: targetPoint, x0: x0, y0: y0, th0: th0, R: R,
                       seg1: 0, seg2: 0, seg3: 0, types: [], x1: x1, y1: y1, th1: th1)
}

private func planDubins(x0: Double, y0: Double, th0: Double,
                        x1: Double, y1: Double, th1: Double,
                        R: Double, endVisualHeading: Double,
                        targetPoint: CGPoint) -> PlannedPath? {
    let dx = x1 - x0, dy = y1 - y0, D = hypot(dx, dy)
    guard D > 0.5 else { return nil }
    let d = D / R, theta = mod2pi(atan2(dy, dx))
    let a = mod2pi(th0 - theta), b = mod2pi(th1 - theta)
    let solvers: [(Double, Double, Double) -> DubinsSolution?] = [
        dubinsLSL, dubinsRSR, dubinsLSR, dubinsRSL, dubinsRLR, dubinsLRL,
    ]
    var best: DubinsSolution?; var bestLen = Double.infinity
    for s in solvers {
        if let sol = s(d, a, b), sol.length.isFinite, sol.length >= 0, sol.length < bestLen {
            bestLen = sol.length; best = sol
        }
    }
    guard let b = best else { return nil }
    return PlannedPath(kind: .dubins, length: (b.t + b.p + b.q) * R,
                       endVisualHeading: endVisualHeading, targetPoint: targetPoint,
                       x0: x0, y0: y0, th0: th0, R: R,
                       seg1: b.t, seg2: b.p, seg3: b.q, types: b.types,
                       x1: x1, y1: y1, th1: th1)
}
