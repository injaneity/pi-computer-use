import AppKit

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
