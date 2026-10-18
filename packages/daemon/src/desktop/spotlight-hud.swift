import AppKit
import Foundation
import Carbon

/// One palette for the whole HUD: a solid black window, white text in three strengths, and a few accents.
enum Theme {
    static let background = NSColor.black
    static let border = NSColor(white: 1.0, alpha: 0.14)
    static let divider = NSColor(white: 1.0, alpha: 0.10)
    static let field = NSColor(white: 0.09, alpha: 1.0)
    static let text = NSColor(white: 0.96, alpha: 1.0)
    static let secondary = NSColor(white: 0.64, alpha: 1.0)
    static let tertiary = NSColor(white: 0.44, alpha: 1.0)
    static let accent = NSColor(red: 0.38, green: 0.64, blue: 1.0, alpha: 1.0)
    static let success = NSColor(red: 0.32, green: 0.86, blue: 0.56, alpha: 1.0)
    static let warning = NSColor(red: 1.0, green: 0.76, blue: 0.30, alpha: 1.0)
    static let danger = NSColor(red: 1.0, green: 0.44, blue: 0.44, alpha: 1.0)
    /// The chat pill and the little tags under it: solid, so they read over any wallpaper.
    static let pill = NSColor(white: 0.115, alpha: 1.0)
    static let send = NSColor(red: 0.22, green: 0.42, blue: 0.96, alpha: 1.0)
}

/// The words in the prompt window, in one place so they are easy to change.
enum Copy {
    static let placeholder = "Start a new task…"
    static let followUp = "Ask a follow-up…"
    static let followUpWhileWorking = "Type a follow-up, or press Esc to stop"
}

/// Geometry of the prompt window: the mascot standing on a chat pill that grows with the text, and (when there are
/// models to pick) a round button beside it. Every number is a whole point so edges land on pixels.
enum PromptLayout {
    static let pillWidth: CGFloat = 420
    static let side: CGFloat = 14             // empty space left and right of the pill (and its button)
    static let pillMinHeight: CGFloat = 52
    static let textBase: CGFloat = 22         // one line of text; the pill is the text plus 30 (15 above, 15 below)
    static let buttonSize: CGFloat = 32       // the + and the send arrow
    static let buttonInset: CGFloat = 10
    static let textLeft: CGFloat = 52         // after the +
    static let modelGap: CGFloat = 8
    static let bottomInset: CGFloat = 6
    static let gap: CGFloat = 4               // between the pill and the mascot's feet
    static let mascotHeight: CGFloat = 140
    static let topInset: CGFloat = 6
    static let chipsRow: CGFloat = 22         // extra pill height while something is attached with @

    static func windowWidth(hasModels: Bool) -> CGFloat {
        side * 2 + pillWidth + (hasModels ? modelGap + pillMinHeight : 0)
    }
}

/// What a line in the progress feed is, which decides how it is drawn.
enum EntryKind {
    case goal       // what the user asked
    case step       // something the agent did
    case attention  // the agent needs the user
    case error
    case answer     // the final result
    case note       // quiet system text
}

class HudActionButton: NSButton {
    override var mouseDownCanMoveWindow: Bool { false }
}

enum Glyph {
    case plus, arrowUp, sparkle
    case pencil, copy, check, chevronDown, chevronUp
    case returnKey, stopSquare, cross
}

/// Whether the window animates (the snapshot tool turns it off so a picture shows the finished state).
var hudAnimated = true

/// Runs layout changes with a short ease, or at once when animation is off.
func hudAnimate(_ duration: TimeInterval = 0.28, _ changes: () -> Void) {
    NSAnimationContext.runAnimationGroup({ context in
        context.duration = hudAnimated ? duration : 0
        context.allowsImplicitAnimation = hudAnimated
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        changes()
    }, completionHandler: nil)
}

/// A button with a drawn glyph (the +, the send arrow, the toolbar and card icons), so it needs no icon files.
/// Round with a fill by default; `flat` draws only the glyph, with a soft highlight on hover.
final class HudGlyphButton: HudActionButton {
    var glyph: Glyph = .plus { didSet { needsDisplay = true } }
    var fill: NSColor = NSColor(white: 1.0, alpha: 0.10) { didSet { needsDisplay = true } }
    var glyphColor: NSColor = Theme.text { didSet { needsDisplay = true } }
    var outlined = false
    var flat = false
    private var hovering = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?

    override var isFlipped: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func draw(_ dirtyRect: NSRect) {
        if flat {
            if hovering {
                NSColor(white: 1.0, alpha: 0.09).setFill()
                NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 4), xRadius: 9, yRadius: 9).fill()
            }
        } else {
            let circle = NSBezierPath(ovalIn: bounds)
            fill.setFill()
            circle.fill()
            if hovering {
                NSColor(white: 1.0, alpha: 0.10).setFill()
                circle.fill()
            }
            if outlined {
                Theme.border.setStroke()
                let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5))
                ring.lineWidth = 1
                ring.stroke()
            }
        }
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        let s = min(bounds.width, bounds.height)
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: c.x + x, y: c.y + y) }
        let path = NSBezierPath()
        path.lineWidth = 2
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        switch glyph {
        case .plus:
            let r = s * 0.26
            path.move(to: p(-r, 0)); path.line(to: p(r, 0))
            path.move(to: p(0, -r)); path.line(to: p(0, r))
        case .arrowUp:
            let r = s * 0.25
            path.move(to: p(0, -r)); path.line(to: p(0, r))
            path.move(to: p(-r, 0)); path.line(to: p(0, r)); path.line(to: p(r, 0))
        case .sparkle:
            let r = s * 0.21, k = r * 0.12
            path.lineWidth = 0
            path.move(to: p(0, r))
            path.curve(to: p(r, 0), controlPoint1: p(k, k), controlPoint2: p(k, k))
            path.curve(to: p(0, -r), controlPoint1: p(k, -k), controlPoint2: p(k, -k))
            path.curve(to: p(-r, 0), controlPoint1: p(-k, -k), controlPoint2: p(-k, -k))
            path.curve(to: p(0, r), controlPoint1: p(-k, k), controlPoint2: p(-k, k))
            path.close()
            glyphColor.setFill()
            path.fill()
            return
        case .pencil:
            let r = s * 0.2
            path.lineWidth = 1.7
            path.appendRoundedRect(NSRect(x: c.x - r * 1.15, y: c.y - r * 1.1, width: r * 2.1, height: r * 2.1), xRadius: 3, yRadius: 3)
            path.move(to: p(-r * 0.15, -r * 0.15)); path.line(to: p(r * 1.2, r * 1.2))
        case .copy:
            let r = s * 0.19
            path.lineWidth = 1.7
            path.appendRoundedRect(NSRect(x: c.x - r * 1.1, y: c.y - r * 1.1, width: r * 1.6, height: r * 1.6), xRadius: 2.5, yRadius: 2.5)
            path.appendRoundedRect(NSRect(x: c.x - r * 0.5, y: c.y - r * 0.5, width: r * 1.6, height: r * 1.6), xRadius: 2.5, yRadius: 2.5)
        case .check:
            let r = s * 0.22
            path.move(to: p(-r * 0.9, 0)); path.line(to: p(-r * 0.25, -r * 0.65)); path.line(to: p(r * 0.95, r * 0.7))
        case .chevronDown:
            let r = s * 0.2
            path.lineWidth = 1.9
            path.move(to: p(-r, r * 0.35)); path.line(to: p(0, -r * 0.45)); path.line(to: p(r, r * 0.35))
        case .chevronUp:
            let r = s * 0.2
            path.lineWidth = 1.9
            path.move(to: p(-r, -r * 0.35)); path.line(to: p(0, r * 0.45)); path.line(to: p(r, -r * 0.35))
        case .returnKey:
            let r = s * 0.2
            path.lineWidth = 1.8
            path.move(to: p(r, r * 0.8)); path.line(to: p(r, -r * 0.2)); path.line(to: p(-r, -r * 0.2))
            path.move(to: p(-r + r * 0.65, r * 0.45)); path.line(to: p(-r, -r * 0.2)); path.line(to: p(-r + r * 0.65, -r * 0.85))
        case .stopSquare:
            let r = s * 0.17
            path.lineWidth = 0
            path.appendRoundedRect(NSRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2), xRadius: 2.5, yRadius: 2.5)
            glyphColor.setFill()
            path.fill()
            return
        case .cross:
            let r = s * 0.24
            path.lineWidth = 1.8
            path.move(to: p(-r, -r)); path.line(to: p(r, r))
            path.move(to: p(-r, r)); path.line(to: p(r, -r))
        }
        glyphColor.setStroke()
        path.stroke()
    }
}

/// Where things are on the mascot's pictures, as fractions of the picture (see assets/mascot/pipeline/layers.py).
/// The Windows HUD has the same numbers in Hud.cs: change them together.
enum Face {
    /// The dark screen on the head: the face is only ever drawn inside it.
    static let visor = (x0: 0.2065, y0: 0.2192, x1: 0.6877, y1: 0.5100)
    static let eyeLeft = (x: 0.3261, y: 0.3611)
    static let eyeRight = (x: 0.5464, y: 0.3611)
    static let eyeSize = (w: 0.0620, h: 0.0760)
    static let mouth = (x: 0.4341, y: 0.4258)
    /// What the head turns about: the neck.
    static let pivot = (x: 0.4884, y: 0.5466)
    /// How far the head follows the cursor: sideways and up/down as a fraction of the picture, and tilt in degrees.
    static let headShift = (x: 0.035, y: 0.018)
    static let headTilt = 7.0
    static let gazeShift = (x: 0.05, y: 0.03)
}

enum Expression {
    case neutral, listening, happy, content, terminal, focus, thinking, surprised, sad, error, sleepy, wink, laugh, smug
}

enum EyeShape { case open, arcUp, arcDown, chevronRight, chevronLeft, underscore, cross }
enum MouthShape { case smile, grin, o, flat, wave, smirk }

/// What one expression looks like: the shape of each eye and of the mouth, and a few tweaks.
struct FaceSpec {
    var left: EyeShape = .open
    var right: EyeShape = .open
    var eyeWidth: CGFloat = 1
    var eyeHeight: CGFloat = 1
    var rightScale: CGFloat = 1
    var tilt: CGFloat = 0          // degrees; the left eye turns this way, the right one the opposite way
    var lid: CGFloat = 0           // how much of the eye is covered from the top
    var mouth: MouthShape = .smile
    var curve: CGFloat = 0.5       // -1 frown ... 1 big smile
    var mouthSize: CGFloat = 1
    var warning = false            // drawn in red instead of cyan
    var zzz = false
    var forcedGaze: CGPoint? = nil // where it looks, whatever the cursor does

    static func of(_ e: Expression) -> FaceSpec {
        var s = FaceSpec()
        switch e {
        case .neutral: break
        case .listening: s.eyeWidth = 1.05; s.eyeHeight = 1.15; s.curve = 0.65
        case .happy: s.left = .arcUp; s.right = .arcUp; s.mouth = .grin; s.mouthSize = 0.9
        case .content: s.left = .arcDown; s.right = .arcDown; s.curve = 0.8
        case .terminal: s.left = .chevronRight; s.right = .underscore; s.curve = 0.25; s.mouthSize = 0.8
        case .focus: s.eyeHeight = 0.55; s.mouth = .flat
        case .thinking: s.eyeWidth = 0.9; s.rightScale = 1.25; s.mouth = .wave; s.mouthSize = 0.95; s.forcedGaze = CGPoint(x: 0.8, y: -0.9)
        case .surprised: s.eyeHeight = 1.4; s.eyeWidth = 1.12; s.mouth = .o
        case .sad: s.eyeHeight = 0.9; s.tilt = 15; s.curve = -0.7
        case .error: s.left = .cross; s.right = .cross; s.mouth = .wave; s.warning = true
        case .sleepy: s.left = .arcDown; s.right = .arcDown; s.mouth = .o; s.mouthSize = 0.45; s.zzz = true
        case .wink: s.right = .arcUp; s.curve = 0.85
        case .laugh: s.left = .chevronRight; s.right = .chevronLeft; s.mouth = .grin; s.mouthSize = 1.15
        case .smug: s.lid = 0.5; s.mouth = .smirk; s.curve = 0.7; s.forcedGaze = CGPoint(x: 0.9, y: 0)
        }
        return s
    }
}

/// Draws the face in code, so every expression is crisp at any size and the eyes can go anywhere on the screen.
final class FaceLayer: CALayer {
    var spec = FaceSpec()
    var gaze = CGPoint.zero        // -1...1 each way
    var openness: CGFloat = 1      // eyes: 1 open ... 0 shut (a blink)
    var fade: CGFloat = 1
    var cursorOn = true
    var zPhase: CGFloat = 0

    static let cyan = NSColor(red: 0.40, green: 0.97, blue: 0.99, alpha: 1)
    static let coral = NSColor(red: 1.0, green: 0.47, blue: 0.47, alpha: 1)

    override func draw(in ctx: CGContext) {
        let W = bounds.width, H = bounds.height
        guard W > 0, H > 0, fade > 0.01 else { return }
        func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: CGFloat(x) * W, y: (1 - CGFloat(y)) * H) }
        let v = Face.visor
        let screen = CGRect(x: CGFloat(v.x0) * W, y: (1 - CGFloat(v.y1)) * H, width: CGFloat(v.x1 - v.x0) * W, height: CGFloat(v.y1 - v.y0) * H).insetBy(dx: 0.01 * W, dy: 0.008 * H)
        ctx.addPath(CGPath(roundedRect: screen, cornerWidth: 0.045 * W, cornerHeight: 0.045 * W, transform: nil))
        ctx.clip()
        ctx.setAlpha(fade)

        let ew = CGFloat(Face.eyeSize.w) * W
        let eh = CGFloat(Face.eyeSize.h) * H
        let shift = CGPoint(x: gaze.x * CGFloat(Face.gazeShift.x) * W, y: -gaze.y * CGFloat(Face.gazeShift.y) * H)
        let left = CGPoint(x: point(Face.eyeLeft.x, Face.eyeLeft.y).x + shift.x, y: point(Face.eyeLeft.x, Face.eyeLeft.y).y + shift.y)
        let right = CGPoint(x: point(Face.eyeRight.x, Face.eyeRight.y).x + shift.x, y: point(Face.eyeRight.x, Face.eyeRight.y).y + shift.y)
        let mouth = CGPoint(x: point(Face.mouth.x, Face.mouth.y).x + shift.x * 0.8, y: point(Face.mouth.x, Face.mouth.y).y + shift.y * 0.8)
        let color = spec.warning ? FaceLayer.coral : FaceLayer.cyan
        let lineWidth = ew * 0.4

        func eye(_ shape: EyeShape, at c: CGPoint, side: CGFloat, scale: CGFloat) {
            let w = ew * spec.eyeWidth * scale
            let h = eh * spec.eyeHeight * scale
            ctx.saveGState()
            ctx.translateBy(x: c.x, y: c.y)
            ctx.setStrokeColor(color.cgColor)
            ctx.setFillColor(color.cgColor)
            ctx.setLineWidth(lineWidth)
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            switch shape {
            case .open:
                let full = max(lineWidth * 0.7, h * openness)
                let shown = max(lineWidth * 0.7, full * (1 - spec.lid))
                ctx.rotate(by: side * spec.tilt * .pi / 180)
                let rb = min(w, shown) * 0.42                      // rounded below,
                let rt = spec.lid > 0 ? min(w, shown) * 0.12 : rb  // flatter on top when the lid is down
                let r = CGRect(x: -w / 2, y: -shown / 2 - (full - shown) / 2, width: w, height: shown)
                ctx.move(to: CGPoint(x: r.minX + rb, y: r.minY))
                ctx.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.maxY), radius: rb)
                ctx.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.maxY), radius: rt)
                ctx.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.minY), radius: rt)
                ctx.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY), radius: rb)
                ctx.closePath()
                ctx.fillPath()
            case .arcUp:
                ctx.move(to: CGPoint(x: -w * 0.95, y: -h * 0.2))
                ctx.addQuadCurve(to: CGPoint(x: w * 0.95, y: -h * 0.2), control: CGPoint(x: 0, y: h * 0.62))
                ctx.strokePath()
            case .arcDown:
                ctx.move(to: CGPoint(x: -w * 0.95, y: h * 0.12))
                ctx.addQuadCurve(to: CGPoint(x: w * 0.95, y: h * 0.12), control: CGPoint(x: 0, y: -h * 0.5))
                ctx.strokePath()
            case .chevronRight:
                ctx.move(to: CGPoint(x: -w * 0.7, y: h * 0.42))
                ctx.addLine(to: CGPoint(x: w * 0.7, y: 0))
                ctx.addLine(to: CGPoint(x: -w * 0.7, y: -h * 0.42))
                ctx.strokePath()
            case .chevronLeft:
                ctx.move(to: CGPoint(x: w * 0.7, y: h * 0.42))
                ctx.addLine(to: CGPoint(x: -w * 0.7, y: 0))
                ctx.addLine(to: CGPoint(x: w * 0.7, y: -h * 0.42))
                ctx.strokePath()
            case .underscore:
                if cursorOn {
                    ctx.move(to: CGPoint(x: -w * 0.85, y: -h * 0.4))
                    ctx.addLine(to: CGPoint(x: w * 0.85, y: -h * 0.4))
                    ctx.strokePath()
                }
            case .cross:
                ctx.move(to: CGPoint(x: -w * 0.7, y: h * 0.32)); ctx.addLine(to: CGPoint(x: w * 0.7, y: -h * 0.32))
                ctx.move(to: CGPoint(x: -w * 0.7, y: -h * 0.32)); ctx.addLine(to: CGPoint(x: w * 0.7, y: h * 0.32))
                ctx.strokePath()
            }
            ctx.restoreGState()
        }

        func mouthShape() {
            let mw = 0.056 * W * spec.mouthSize
            ctx.saveGState()
            ctx.translateBy(x: mouth.x, y: mouth.y)
            ctx.setStrokeColor(color.cgColor)
            ctx.setFillColor(color.cgColor)
            ctx.setLineWidth(ew * 0.3)
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            switch spec.mouth {
            case .smile:
                ctx.move(to: CGPoint(x: -mw, y: 0))
                ctx.addQuadCurve(to: CGPoint(x: mw, y: 0), control: CGPoint(x: 0, y: -spec.curve * mw * 1.6))
                ctx.strokePath()
            case .grin:
                ctx.move(to: CGPoint(x: -mw, y: mw * 0.15))
                ctx.addLine(to: CGPoint(x: mw, y: mw * 0.15))
                ctx.addArc(center: CGPoint(x: 0, y: mw * 0.15), radius: mw, startAngle: 0, endAngle: .pi, clockwise: true)
                ctx.closePath()
                ctx.fillPath()
            case .o:
                let r = mw * 0.42
                ctx.strokeEllipse(in: CGRect(x: -r, y: -r * 1.2, width: r * 2, height: r * 2.4))
            case .flat:
                ctx.move(to: CGPoint(x: -mw * 0.55, y: 0)); ctx.addLine(to: CGPoint(x: mw * 0.55, y: 0)); ctx.strokePath()
            case .wave:
                let steps = 24
                for i in 0...steps {
                    let t = CGFloat(i) / CGFloat(steps)
                    let p = CGPoint(x: (t - 0.5) * mw * 1.8, y: sin(t * .pi * 3) * mw * 0.18)
                    if i == 0 { ctx.move(to: p) } else { ctx.addLine(to: p) }
                }
                ctx.strokePath()
            case .smirk:
                ctx.move(to: CGPoint(x: -mw * 0.9, y: -mw * 0.1))
                ctx.addQuadCurve(to: CGPoint(x: mw, y: mw * 0.45), control: CGPoint(x: mw * 0.1, y: -spec.curve * mw * 1.5))
                ctx.strokePath()
            }
            ctx.restoreGState()
        }

        func sleepZs() {
            let base = point(0.6, 0.27)
            ctx.setStrokeColor(color.cgColor)
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            for i in 0..<3 {
                let t = (zPhase + CGFloat(i) / 3).truncatingRemainder(dividingBy: 1)
                let size = (0.012 + 0.012 * t) * W
                ctx.saveGState()
                ctx.setAlpha(fade * sin(t * .pi))
                ctx.setLineWidth(max(1, size * 0.28))
                ctx.translateBy(x: base.x + t * 0.04 * W, y: base.y + t * 0.07 * H)
                ctx.move(to: CGPoint(x: -size, y: size)); ctx.addLine(to: CGPoint(x: size, y: size))
                ctx.addLine(to: CGPoint(x: -size, y: -size)); ctx.addLine(to: CGPoint(x: size, y: -size))
                ctx.strokePath()
                ctx.restoreGState()
            }
        }

        // two passes: a wide soft glow, then the crisp shapes with a tight glow
        for (blur, alpha) in [(ew * 1.7, 0.55), (ew * 0.55, 0.95)] as [(CGFloat, CGFloat)] {
            ctx.saveGState()
            ctx.setShadow(offset: .zero, blur: blur, color: color.withAlphaComponent(alpha).cgColor)
            eye(spec.left, at: left, side: 1, scale: 1)
            eye(spec.right, at: right, side: -1, scale: spec.rightScale)
            mouthShape()
            ctx.restoreGState()
        }
        if spec.zzz { sleepZs() }
    }
}

/// The mascot: a fixed body, and a head that follows the cursor (it moves and tilts on the neck) with a face drawn on it.
/// The art is two PNGs (body.png, head.png) in a folder; without them the view is simply not used.
final class MascotView: NSView {
    enum Mood {
        case idle      // follows the cursor, blinks, now and then makes a face
        case typing    // looks down at what is being typed
        case working   // busy
        case happy     // task done
        case error     // task failed
        case stopped   // task stopped
    }

    static let directory: String = ProcessInfo.processInfo.environment["RH_MASCOT_DIR"] ?? (NSHomeDirectory() + "/.remote-hands/mascot")
    private static var cache: [String: CGImage] = [:]

    static func image(_ name: String) -> CGImage? {
        if let hit = cache[name] { return hit }
        let url = URL(fileURLWithPath: directory + "/" + name + ".png")
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        cache[name] = img
        return img
    }

    /// Width over height of the picture, or 0 when the art is not installed.
    static let aspect: CGFloat = {
        guard let body = image("body"), image("head") != nil else { return 0 }
        return CGFloat(body.width) / CGFloat(body.height)
    }()
    static var isAvailable: Bool { aspect > 0 }

    private let stage = CALayer()
    private let body = CALayer()
    private let head = CALayer()
    private let skull = CALayer()
    private let face = FaceLayer()
    private var timer: Timer?
    private var tick = 0

    // what is shown
    private var shown: Expression = .neutral
    private var wanted: Expression = .neutral
    private var fade: CGFloat = 1
    private var headX: CGFloat = 0
    private var headY: CGFloat = 0
    private var headTilt: CGFloat = 0
    private var gaze = CGPoint.zero
    private var drawnKey = ""

    // the little life it has
    private var nextBlink = 50
    private var blinkStart = -1
    private var reactions: [(expression: Expression, ticks: Int)] = []
    private var reactionLeft = 0
    /// Called when "Close" is picked from the right-click menu.
    var onCloseRequested: (() -> Void)?
    private var happyUntil = 0
    private var nextAmbient = 200
    private var ambient: Expression?
    private var ambientUntil = 0
    private var nextThought = 150
    private var thoughtUntil = 0
    private var lastMouse = NSPoint.zero
    private var lastActivity = 0
    private var held = false           // snapshot tool: keep the pose it was given

    /// How much has been typed (a long request makes it concentrate).
    var typedLength = 0

    var mood: Mood = .idle {
        didSet {
            guard oldValue != mood else { return }
            lastActivity = tick
            switch mood {
            case .happy:
                happyUntil = tick + 80
                hop()
            case .error:
                shake()
            default: break
            }
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        stage.anchorPoint = CGPoint(x: 0.5, y: 0)
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        for part in [body, skull] {
            part.contentsGravity = .resizeAspect
            part.minificationFilter = .trilinear
            part.magnificationFilter = .linear
            part.contentsScale = scale
        }
        body.contents = MascotView.image("body")
        skull.contents = MascotView.image("head")
        face.contentsScale = scale
        face.needsDisplayOnBoundsChange = true
        head.addSublayer(skull)
        head.addSublayer(face)
        stage.addSublayer(body)
        stage.addSublayer(head)
        layer?.addSublayer(stage)
        head.anchorPoint = CGPoint(x: Face.pivot.x, y: 1 - Face.pivot.y)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// A click makes it jump in surprise, then laugh.
    override func mouseUp(with event: NSEvent) {
        react([(.surprised, 8), (.laugh, 26)])
        hop()
        super.mouseUp(with: event)
    }

    /// Right-click opens a one-item menu to close the HUD.
    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        let item = NSMenuItem(title: "Close", action: #selector(closePicked), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    @objc private func closePicked() { onCloseRequested?() }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let size = bounds.size
        stage.bounds = CGRect(origin: .zero, size: size)
        stage.position = CGPoint(x: bounds.midX, y: 0)
        body.frame = stage.bounds
        head.bounds = stage.bounds
        head.position = CGPoint(x: CGFloat(Face.pivot.x) * size.width, y: CGFloat(1 - Face.pivot.y) * size.height)
        skull.frame = head.bounds
        face.frame = head.bounds
        CATransaction.commit()
        face.setNeedsDisplay()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate()
        timer = nil
        guard window != nil else { return }
        let t = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.step() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        startIdleMotion()
        react([(.wink, 26)])
    }

    private func startIdleMotion() {
        let bob = CABasicAnimation(keyPath: "transform.translation.y")
        bob.fromValue = 0
        bob.toValue = 3
        bob.duration = 1.5
        bob.autoreverses = true
        bob.repeatCount = .infinity
        bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        stage.add(bob, forKey: "bob")

        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.7
        pop.toValue = 1.0
        pop.damping = 11
        pop.stiffness = 190
        pop.duration = pop.settlingDuration
        stage.add(pop, forKey: "pop")
        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0
        fadeIn.toValue = 1
        fadeIn.duration = 0.18
        stage.add(fadeIn, forKey: "fade")
    }

    private func hop() {
        let jump = CAKeyframeAnimation(keyPath: "transform.translation.y")
        jump.values = [0, 14, 0, 6, 0]
        jump.keyTimes = [0, 0.25, 0.5, 0.74, 1]
        jump.duration = 0.55
        jump.isAdditive = true
        stage.add(jump, forKey: "hop")
    }

    private func shake() {
        let wiggle = CAKeyframeAnimation(keyPath: "transform.translation.x")
        wiggle.values = [0, -6, 6, -4, 4, 0]
        wiggle.duration = 0.4
        wiggle.isAdditive = true
        stage.add(wiggle, forKey: "shake")
    }

    /// Something was done on screen (a click, typing, a search...): the head nods, and the face notices.
    func noticeAction(_ text: String) {
        let t = text.lowercased()
        let nod = CAKeyframeAnimation(keyPath: "position.y")
        nod.values = [0, -5, 0]
        nod.keyTimes = [0, 0.4, 1]
        nod.duration = 0.28
        nod.isAdditive = true
        head.add(nod, forKey: "nod")
        if t.contains("click") || t.contains("press") || t.contains("tap") || t.contains("select") {
            react([(.focus, 9)])
        } else if t.contains("type") || t.contains("typing") || t.contains("enter") || t.contains("fill") {
            react([(.listening, 10)])
        } else if t.contains("search") || t.contains("read") || t.contains("look") || t.contains("scroll") || t.contains("open") {
            react([(.thinking, 12)])
        }
    }

    private func react(_ steps: [(Expression, Int)]) {
        reactions = steps.map { (expression: $0.0, ticks: $0.1) }
        reactionLeft = steps.first?.1 ?? 0
    }

    // MARK: - one tick (50 ms)

    private func step() {
        tick += 1
        if held { return }
        if mood == .happy && tick >= happyUntil { mood = .idle }

        // where the cursor is, from the eyes
        var look = CGPoint.zero
        if let w = window {
            let mouse = NSEvent.mouseLocation
            if abs(mouse.x - lastMouse.x) + abs(mouse.y - lastMouse.y) > 6 {
                lastMouse = mouse
                lastActivity = tick
            }
            let eye = w.convertPoint(toScreen: convert(NSPoint(x: bounds.width * CGFloat(Face.eyeLeft.x + Face.eyeRight.x) / 2, y: bounds.height * CGFloat(1 - Face.eyeLeft.y)), to: nil))
            look = CGPoint(x: max(-1, min(1, (mouse.x - eye.x) / 240)), y: max(-1, min(1, (eye.y - mouse.y) / 170)))
        }

        wanted = wantedExpression()
        let spec = FaceSpec.of(shown)

        // eyes and head
        var targetGaze = look
        // typing: it reads along the text, from left to right as the request grows, looking down at it
        if mood == .typing { targetGaze = CGPoint(x: min(0.8, -0.7 + CGFloat(typedLength) * 0.03), y: 0.9) }
        if let forced = spec.forcedGaze { targetGaze = forced }
        gaze.x += (targetGaze.x - gaze.x) * 0.4
        gaze.y += (targetGaze.y - gaze.y) * 0.4
        var headTarget = look
        if mood == .typing { headTarget = CGPoint(x: look.x * 0.3, y: 0.7) }
        var tiltExtra: CGFloat = 0
        if shown == .sleepy { headTarget = CGPoint(x: 0, y: 1.2); tiltExtra = -5 }
        if shown == .thinking { tiltExtra = 5 }
        let size = bounds.size
        headX += (headTarget.x * CGFloat(Face.headShift.x) * size.width - headX) * 0.25
        headY += (-headTarget.y * CGFloat(Face.headShift.y) * size.height - headY) * 0.25
        headTilt += ((-headTarget.x * CGFloat(Face.headTilt) + tiltExtra) - headTilt) * 0.25
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.1)
        head.transform = CATransform3DConcat(CATransform3DMakeRotation(headTilt * .pi / 180, 0, 0, 1), CATransform3DMakeTranslation(headX, headY, 0))
        CATransaction.commit()

        // changing the face: the old one fades out, the new one fades in
        if shown != wanted {
            fade -= 0.35
            if fade <= 0 { shown = wanted; fade = 0 }
        } else if fade < 1 {
            fade = min(1, fade + 0.35)
        }

        // blinking
        var openness: CGFloat = 1
        if blinkStart < 0 && tick >= nextBlink { blinkStart = tick }
        if blinkStart >= 0 {
            let i = (tick - blinkStart) / 2
            if i < 3 {
                openness = [0.45, 0.06, 0.45][i]
            } else {
                blinkStart = -1
                nextBlink = tick + (Int.random(in: 0..<5) == 0 ? 7 : Int.random(in: 50...130))
            }
        }

        draw(spec: FaceSpec.of(shown), openness: openness)
    }

    private func draw(spec: FaceSpec, openness: CGFloat) {
        let cursorOn = (tick / 8) % 2 == 0
        let zPhase = CGFloat(tick % 60) / 60
        let key = "\(shown)|\(Int(fade * 10))|\(Int(openness * 10))|\(Int(gaze.x * 20))|\(Int(gaze.y * 20))|\(cursorOn)|\(spec.zzz ? Int(zPhase * 30) : 0)"
        guard key != drawnKey else { return }
        drawnKey = key
        face.spec = spec
        face.gaze = gaze
        face.openness = openness
        face.fade = fade
        face.cursorOn = cursorOn
        face.zPhase = zPhase
        face.setNeedsDisplay()
    }

    /// What it feels like right now: a reaction first, then the mood, then (when idle) a little personality.
    private func wantedExpression() -> Expression {
        if let current = reactions.first {
            reactionLeft -= 1
            if reactionLeft <= 0 {
                reactions.removeFirst()
                if let next = reactions.first { reactionLeft = next.ticks }
            }
            return current.expression
        }
        switch mood {
        case .working:
            if tick >= nextThought {
                thoughtUntil = tick + 36
                nextThought = thoughtUntil + Int.random(in: 100...220)
            }
            return tick < thoughtUntil ? .thinking : .terminal
        case .happy: return .happy
        case .error: return .error
        case .stopped: return .sleepy
        case .typing: return typedLength > 90 ? .focus : .listening
        case .idle:
            if tick - lastActivity > 1000 { return .sleepy }
            if let a = ambient, tick < ambientUntil { return a }
            ambient = nil
            if tick >= nextAmbient {
                ambient = [Expression.content, .smug, .wink, .laugh, .content].randomElement()!
                ambientUntil = tick + Int.random(in: 20...32)
                nextAmbient = ambientUntil + Int.random(in: 160...300)
                return ambient!
            }
            return .neutral
        }
    }

    #if RH_UI_SNAPSHOT
    /// Developer tool: freeze the mascot in a given expression and head turn (look: -1...1 each way).
    func hold(_ name: String, look: CGPoint = .zero) {
        let all: [String: Expression] = ["neutral": .neutral, "listening": .listening, "happy": .happy, "content": .content, "terminal": .terminal, "focus": .focus, "thinking": .thinking, "surprised": .surprised, "sad": .sad, "error": .error, "sleepy": .sleepy, "wink": .wink, "laugh": .laugh, "smug": .smug]
        held = true
        shown = all[name] ?? .neutral
        wanted = shown
        fade = 1
        let spec = FaceSpec.of(shown)
        gaze = spec.forcedGaze ?? look
        let size = bounds.size
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        head.transform = CATransform3DConcat(CATransform3DMakeRotation(-look.x * CGFloat(Face.headTilt) * .pi / 180, 0, 0, 1), CATransform3DMakeTranslation(look.x * CGFloat(Face.headShift.x) * size.width, -look.y * CGFloat(Face.headShift.y) * size.height, 0))
        CATransaction.commit()
        drawnKey = ""
        draw(spec: spec, openness: 1)
    }
    #endif
}

/// A view that measures from the top, so a window that grows downward leaves everything in it where it was.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// A small round icon in a card's margin: a check, a cross, a bang or a dot.
final class CardIcon: NSView {
    enum Kind { case check, cross, bang, dot, spinner }
    let kind: Kind
    private let color: NSColor

    init(kind: Kind, color: NSColor) {
        self.kind = kind
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: 18, height: 18))
        if kind == .spinner {
            // a ring with a gap, turning: this step is happening right now
            wantsLayer = true
            let ring = CAShapeLayer()
            ring.frame = bounds
            ring.path = CGPath(ellipseIn: bounds.insetBy(dx: 2.5, dy: 2.5), transform: nil)
            ring.fillColor = nil
            ring.strokeColor = Theme.accent.cgColor
            ring.lineWidth = 2.2
            ring.lineCap = .round
            ring.strokeEnd = 0.72
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = -2 * Double.pi
            spin.duration = 0.9
            spin.repeatCount = .infinity
            ring.add(spin, forKey: "spin")
            layer?.addSublayer(ring)
        }
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        if kind == .spinner {
            NSColor(white: 1.0, alpha: 0.10).setStroke()
            let track = NSBezierPath(ovalIn: bounds.insetBy(dx: 2.5, dy: 2.5))
            track.lineWidth = 2.2
            track.stroke()
            return
        }
        color.setFill()
        NSBezierPath(ovalIn: bounds).fill()
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        let path = NSBezierPath()
        path.lineWidth = 1.9
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSColor.white.setStroke()
        switch kind {
        case .check:
            path.move(to: NSPoint(x: c.x - 3.6, y: c.y - 0.2)); path.line(to: NSPoint(x: c.x - 1, y: c.y - 2.9)); path.line(to: NSPoint(x: c.x + 3.8, y: c.y + 2.8))
        case .cross:
            path.move(to: NSPoint(x: c.x - 3, y: c.y - 3)); path.line(to: NSPoint(x: c.x + 3, y: c.y + 3))
            path.move(to: NSPoint(x: c.x - 3, y: c.y + 3)); path.line(to: NSPoint(x: c.x + 3, y: c.y - 3))
        case .bang:
            path.move(to: NSPoint(x: c.x, y: c.y + 4)); path.line(to: NSPoint(x: c.x, y: c.y - 0.8))
            path.move(to: NSPoint(x: c.x, y: c.y - 3.6)); path.line(to: NSPoint(x: c.x, y: c.y - 3.6))
        case .dot:
            NSColor(white: 1.0, alpha: 0.55).setFill()
            NSBezierPath(ovalIn: NSRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5)).fill()
            return
        case .spinner:
            return
        }
        path.stroke()
    }
}

enum CardStyle { case request, step, note, attention, error, answer }

/// One thing that happened, as a small rounded card: your request (with its live status), a step the agent took,
/// a problem, or the final answer. Cards are measured once, when they are made.
final class ActivityCard: NSView {
    override var isFlipped: Bool { true }

    static let pad: CGFloat = 14
    static let vertical: CGFloat = 12
    /// Room around the top-left of the card, so the close badge can hang over the corner inside the view.
    static let room: CGFloat = 8
    private let surface = FlippedView()

    let style: CardStyle
    private(set) var cardHeight: CGFloat = 0
    private var bodyView: NSTextView?
    private(set) var statusWord = ""
    private var statusColor = Theme.secondary
    private var working = false
    private var dots = 0
    private var isLatest = false

    var onClose: (() -> Void)?
    var onStop: (() -> Void)?
    var onReturn: (() -> Void)?
    private var closeBadge: HudGlyphButton?
    private var stopButton: HudGlyphButton?
    private var returnButton: HudGlyphButton?

    /// A step that is still happening shows a turning ring instead of a check.
    private(set) var inProgress = false
    private var iconView: CardIcon?
    private var iconOrigin = NSPoint.zero
    private let startedAt = Date()
    private var finishedAfter: Int?
    var onCopy: (() -> Void)?
    private var copyButton: HudGlyphButton?

    init(style: CardStyle, title: String, body: NSAttributedString?, width: CGFloat, inProgress: Bool = false) {
        self.style = style
        self.inProgress = inProgress && style == .step
        super.init(frame: .zero)
        surface.wantsLayer = true
        surface.layer?.backgroundColor = Theme.pill.cgColor
        surface.layer?.cornerRadius = 18
        surface.layer?.borderWidth = 1
        surface.layer?.borderColor = Theme.border.cgColor
        addSubview(surface)

        var icon: CardIcon?
        switch style {
        case .step: icon = CardIcon(kind: inProgress && style == .step ? .spinner : .check, color: Theme.success)
        case .answer: icon = CardIcon(kind: .check, color: Theme.success)
        case .error: icon = CardIcon(kind: .cross, color: Theme.danger)
        case .attention: icon = CardIcon(kind: .bang, color: Theme.warning)
        case .note: icon = CardIcon(kind: .dot, color: NSColor(white: 1.0, alpha: 0.16))
        case .request: icon = nil
        }
        let textX = ActivityCard.pad + (icon != nil ? 28 : 0)
        let reserve: CGFloat = style == .request ? 82 : 0
        let textW = width - textX - ActivityCard.pad - reserve

        let titleColor: NSColor
        let titleFont: NSFont
        switch style {
        case .request: titleColor = Theme.text; titleFont = NSFont.systemFont(ofSize: 14, weight: .semibold)
        case .step: titleColor = Theme.text; titleFont = NSFont.systemFont(ofSize: 13.5, weight: .medium)
        case .answer: titleColor = Theme.text; titleFont = NSFont.systemFont(ofSize: 14, weight: .semibold)
        case .note: titleColor = Theme.tertiary; titleFont = NSFont.systemFont(ofSize: 13, weight: .regular)
        case .attention: titleColor = Theme.warning; titleFont = NSFont.systemFont(ofSize: 13.5, weight: .medium)
        case .error: titleColor = Theme.danger; titleFont = NSFont.systemFont(ofSize: 13.5, weight: .medium)
        }
        let (titleView, titleH) = ActivityCard.textView(NSAttributedString(string: title, attributes: [.font: titleFont, .foregroundColor: titleColor]), width: textW, selectable: false)
        var y = ActivityCard.vertical
        titleView.frame.origin = NSPoint(x: textX, y: y)
        surface.addSubview(titleView)
        y += titleH
        if let body = body {
            let (view, h) = ActivityCard.textView(body, width: textW, selectable: style == .answer)
            view.frame.origin = NSPoint(x: textX, y: y + 3)
            surface.addSubview(view)
            bodyView = view
            y += 3 + h
        }
        let surfaceHeight = max(46, y + ActivityCard.vertical)
        cardHeight = surfaceHeight + ActivityCard.room
        surface.frame = NSRect(x: ActivityCard.room, y: ActivityCard.room, width: width, height: surfaceHeight)
        frame = NSRect(x: 0, y: 0, width: width + ActivityCard.room, height: cardHeight)
        if let icon = icon {
            // the icon sits beside the first line of the title
            iconOrigin = NSPoint(x: ActivityCard.pad, y: ActivityCard.vertical + (min(titleH, 18) - 18) / 2 + 0.5)
            icon.frame.origin = iconOrigin
            surface.addSubview(icon)
            iconView = icon
        }

        if style == .answer {
            let copy = HudGlyphButton(frame: NSRect(x: width - ActivityCard.pad - 24 + 4, y: 7, width: 28, height: 28))
            copy.glyph = .copy
            copy.flat = true
            copy.glyphColor = Theme.secondary
            copy.target = self
            copy.action = #selector(copyClicked)
            copy.toolTip = "Copy the answer"
            surface.addSubview(copy)
            copyButton = copy
        }
        if style == .request {
            let stop = HudGlyphButton(frame: NSRect(x: width - 14 - 30, y: (surfaceHeight - 30) / 2, width: 30, height: 30))
            stop.glyph = .stopSquare
            stop.fill = NSColor(white: 1.0, alpha: 0.10)
            stop.target = self
            stop.action = #selector(stopClicked)
            stop.toolTip = "Stop (Esc)"
            surface.addSubview(stop)
            stopButton = stop
            let ret = HudGlyphButton(frame: NSRect(x: width - 14 - 30 - 8 - 30, y: (surfaceHeight - 30) / 2, width: 30, height: 30))
            ret.glyph = .returnKey
            ret.fill = NSColor(white: 1.0, alpha: 0.10)
            ret.glyphColor = Theme.secondary
            ret.target = self
            ret.action = #selector(returnClicked)
            ret.toolTip = "Ask a follow-up"
            surface.addSubview(ret)
            returnButton = ret
            let close = HudGlyphButton(frame: NSRect(x: ActivityCard.room - 7, y: ActivityCard.room - 7, width: 20, height: 20))
            close.glyph = .cross
            close.fill = NSColor(white: 0.93, alpha: 1)
            close.glyphColor = .black
            close.target = self
            close.action = #selector(closeClicked)
            close.toolTip = "Close (Esc)"
            addSubview(close)
            closeBadge = close
        }
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func copyClicked() { onCopy?() }
    @objc private func stopClicked() { onStop?() }

    /// Older cards keep their solid background but their words go quieter (until the mouse comes to read them).
    func setDimmed(_ dimmed: Bool) {
        hudAnimate(0.25) {
            for view in surface.subviews { view.animator().alphaValue = dimmed ? 0.5 : 1 }
        }
    }

    /// The ring turns into a check once the next thing happens (or the task ends).
    func finishStep() {
        guard inProgress, let old = iconView else { return }
        inProgress = false
        old.removeFromSuperview()
        let done = CardIcon(kind: .check, color: Theme.success)
        done.frame.origin = iconOrigin
        done.alphaValue = 0
        surface.addSubview(done)
        iconView = done
        hudAnimate(0.25) { done.animator().alphaValue = 1 }
    }

    /// The answer's copy button shows a check for a moment.
    func flashCopied() {
        copyButton?.glyph = .check
        copyButton?.glyphColor = Theme.success
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            self?.copyButton?.glyph = .copy
            self?.copyButton?.glyphColor = Theme.secondary
        }
    }

    /// A quiet pulse around the request while it works, so the card looks alive.
    private func setPulse(_ on: Bool) {
        guard let layer = surface.layer else { return }
        layer.removeAnimation(forKey: "pulse")
        layer.borderColor = Theme.border.cgColor
        guard on, hudAnimated else { return }
        let pulse = CABasicAnimation(keyPath: "borderColor")
        pulse.fromValue = Theme.border.cgColor
        pulse.toValue = Theme.accent.withAlphaComponent(0.55).cgColor
        pulse.duration = 1.1
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(pulse, forKey: "pulse")
    }
    @objc private func returnClicked() { onReturn?() }
    @objc private func closeClicked() { onClose?() }

    /// A read-only text view measured to its text, so wrapped lines, bullets and links come out right.
    static func textView(_ text: NSAttributedString, width: CGFloat, selectable: Bool) -> (NSTextView, CGFloat) {
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: width, height: 10))
        view.drawsBackground = false
        view.isEditable = false
        view.isSelectable = selectable
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        view.textContainer?.widthTracksTextView = false
        view.isHorizontallyResizable = false
        view.isVerticallyResizable = false
        view.selectedTextAttributes = [.backgroundColor: NSColor(red: 0.38, green: 0.64, blue: 1.0, alpha: 0.35)]
        view.linkTextAttributes = [.foregroundColor: Theme.accent, .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand]
        view.textStorage?.setAttributedString(text)
        if let lm = view.layoutManager, let tc = view.textContainer {
            lm.ensureLayout(for: tc)
            let h = ceil(lm.usedRect(for: tc).height)
            view.frame.size.height = h
            return (view, h)
        }
        return (view, 16)
    }

    // MARK: the live parts of a request card

    /// The newest request carries the close badge and the buttons; older ones are just text.
    func setLatest(_ latest: Bool) {
        isLatest = latest
        if style == .request { setPulse(working && latest) }
        closeBadge?.isHidden = !latest
        returnButton?.isHidden = !latest
        refreshControls()
    }

    func setWorking(_ isWorking: Bool) {
        if working && !isWorking { finishedAfter = Int(Date().timeIntervalSince(startedAt)) }
        if !working && isWorking { finishedAfter = nil }
        working = isWorking
        if style == .request { setPulse(isWorking && isLatest) }
        refreshControls()
        refreshStatus()
    }

    private func refreshControls() {
        stopButton?.isHidden = !(isLatest && working)
        // the return arrow slides over to where the stop button was once there is nothing to stop
        if let ret = returnButton {
            let w = frame.width - ActivityCard.room
            let x = (stopButton?.isHidden ?? true) ? w - 14 - 30 : w - 14 - 30 - 8 - 30
            ret.frame.origin.x = x
        }
    }

    func setStatus(_ word: String, color: NSColor) {
        statusWord = word
        statusColor = color
        refreshStatus()
    }

    func tickDots() {
        dots = (dots + 1) % 4
        refreshStatus()
    }

    func refreshStatus() {
        guard style == .request, let view = bodyView, let storage = view.textStorage else { return }
        let suffix = working ? String(repeating: ".", count: dots) : ""
        // how long it has been going (or took), once that is worth saying
        let seconds = working ? Int(Date().timeIntervalSince(startedAt)) : (finishedAfter ?? 0)
        let time = seconds >= 3 ? "  ·  \(seconds)s" : ""
        let text = statusWord + suffix + time
        storage.setAttributedString(NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .regular), .foregroundColor: statusColor]))
    }
}

/// The stack of cards under the toolbar: newest at the bottom, older ones sliding up and fading out at the top edge, and
/// scrollable back to the first. It reports its height so the window can follow.
final class ActivityFeed: NSView {
    static let margin: CGFloat = 8     // the room each card has at its left (see ActivityCard.room)
    static let tail: CGFloat = 6

    private let scroll = NSScrollView()
    private let doc = FlippedView()
    private let fadeMask = CAGradientLayer()
    private(set) var cards: [ActivityCard] = []
    private let cardWidth: CGFloat
    var onChange: (() -> Void)?
    var collapsed = false { didSet { onChange?() } }
    /// The most the cards may take: set by the window from the room there is on screen, so an answer can be read whole.
    var maxHeight: CGFloat = 250
    private var hovering = false { didSet { updateDimming() } }
    private var activeStep: ActivityCard?

    init(cardWidth: CGFloat) {
        self.cardWidth = cardWidth
        super.init(frame: .zero)
        wantsLayer = true
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.borderType = .noBorder
        scroll.wantsLayer = true
        scroll.documentView = doc
        scroll.contentView.postsBoundsChangedNotifications = true
        addSubview(scroll)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
    }
    required init?(coder: NSCoder) { fatalError("not used") }
    deinit { NotificationCenter.default.removeObserver(self) }

    var contentHeight: CGFloat {
        guard let last = cards.last else { return 0 }
        return last.frame.maxY + ActivityFeed.tail
    }
    var visibleHeight: CGFloat { collapsed || cards.isEmpty ? 0 : min(contentHeight, maxHeight) }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        doc.frame.size.width = bounds.width
        updateMask()
    }

    @objc private func scrolled() { updateMask() }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    /// The newest cards are clear; older ones are a little dimmer until the mouse comes to read them.
    private func updateDimming() {
        let count = cards.count
        for (index, card) in cards.enumerated() {
            card.setDimmed(!hovering && count - 1 - index >= 3)
        }
    }

    /// The turning ring on the step that was happening becomes a check.
    func finishActiveStep() {
        activeStep?.finishStep()
        activeStep = nil
    }

    /// Cards scrolled up under the top edge fade out, and so do cards still waiting below the bottom edge; at either end of the
    /// list nothing fades, so whatever is fully in view reads at full strength.
    private func updateMask() {
        guard let layer = layer, bounds.height > 0 else { return }
        let offset = scroll.contentView.bounds.origin.y
        let below = max(0, doc.frame.height - bounds.height - offset)
        let topAlpha = 1 - min(1, max(0, offset) / 24)
        let bottomAlpha = 1 - min(1, below / 24)
        let fade = Double(min(0.4, 40 / bounds.height))
        fadeMask.frame = bounds
        fadeMask.startPoint = CGPoint(x: 0.5, y: 1)
        fadeMask.endPoint = CGPoint(x: 0.5, y: 0)
        fadeMask.colors = [NSColor(white: 0, alpha: topAlpha).cgColor, NSColor.black.cgColor, NSColor.black.cgColor, NSColor(white: 0, alpha: bottomAlpha).cgColor]
        fadeMask.locations = [0, NSNumber(value: fade), NSNumber(value: 1 - fade), 1]
        layer.mask = fadeMask
    }

    var isAtBottom: Bool {
        scroll.contentView.bounds.maxY >= doc.frame.height - 24
    }

    func append(_ card: ActivityCard, toTop: Bool = false) {
        let stick = isAtBottom || cards.isEmpty
        // a new card means the step that was happening is done
        finishActiveStep()
        if card.inProgress { activeStep = card }
        let y = cards.last?.frame.maxY ?? 0
        card.frame = NSRect(x: 0, y: y + 16, width: cardWidth + ActivityCard.room, height: card.cardHeight)
        card.alphaValue = 0
        doc.addSubview(card)
        cards.append(card)
        doc.frame = NSRect(x: 0, y: 0, width: cardWidth + ActivityCard.room * 2, height: y + card.cardHeight + ActivityFeed.tail)
        hudAnimate(0.32) {
            card.animator().frame.origin.y = y
            card.animator().alphaValue = 1
        }
        updateDimming()
        onChange?()
        updateMask()
        // bring the new card into view: the first line of a long answer, otherwise the bottom
        let target = toTop ? max(0, y - 6) : max(0, doc.frame.height - visibleHeight)
        if toTop || stick {
            hudAnimate(0.3) {
                scroll.contentView.animator().setBoundsOrigin(NSPoint(x: 0, y: min(target, max(0, doc.frame.height - visibleHeight))))
            }
            scroll.reflectScrolledClipView(scroll.contentView)
        }
    }

    /// Starts over with no cards (a different chat was picked).
    func reset() {
        for card in cards { card.removeFromSuperview() }
        cards.removeAll()
        activeStep = nil
        doc.frame = NSRect(x: 0, y: 0, width: cardWidth + ActivityCard.room * 2, height: 0)
        scroll.contentView.setBoundsOrigin(.zero)
        onChange?()
        updateMask()
    }

    func scrollToEnd() {
        scroll.contentView.setBoundsOrigin(NSPoint(x: 0, y: max(0, doc.frame.height - visibleHeight)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }
}

/// The small floating bar under the mascot: a new follow-up, copy the answer, and fold the cards away.
final class ToolbarView: NSView {
    static let size = NSSize(width: 132, height: 36)
    let newButton = HudGlyphButton(frame: NSRect(x: 0, y: 0, width: 44, height: 36))
    let copyButton = HudGlyphButton(frame: NSRect(x: 44, y: 0, width: 44, height: 36))
    let collapseButton = HudGlyphButton(frame: NSRect(x: 88, y: 0, width: 44, height: 36))

    override init(frame: NSRect) {
        super.init(frame: NSRect(origin: .zero, size: ToolbarView.size))
        wantsLayer = true
        layer?.backgroundColor = Theme.pill.cgColor
        layer?.cornerRadius = ToolbarView.size.height / 2
        layer?.borderWidth = 1
        layer?.borderColor = Theme.border.cgColor
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.45
        layer?.shadowRadius = 14
        layer?.shadowOffset = CGSize(width: 0, height: -4)
        for (button, glyph, tip) in [(newButton, Glyph.pencil, "Ask a follow-up"), (copyButton, Glyph.copy, "Copy the answer"), (collapseButton, Glyph.chevronDown, "Fold the cards away")] {
            button.glyph = glyph
            button.flat = true
            button.glyphColor = Theme.secondary
            button.toolTip = tip
            addSubview(button)
        }
        for x in [CGFloat(44), 88] {
            let line = NSView(frame: NSRect(x: x, y: 10, width: 1, height: 16))
            line.wantsLayer = true
            line.layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.12).cgColor
            addSubview(line)
        }
    }
    required init?(coder: NSCoder) { fatalError("not used") }
}

class ContextTableRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        if isSelected {
            let selectionRect = bounds.insetBy(dx: 4, dy: 2)
            let path = NSBezierPath(roundedRect: selectionRect, xRadius: 8, yRadius: 8)
            NSColor(white: 1.0, alpha: 0.12).setFill()
            path.fill()
        }
    }
}

class ContextTableCell: NSTableCellView {
    var iconField: NSTextField!
    var titleField: NSTextField!
    var subtitleField: NSTextField!
    var badgeField: NSTextField!

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupViews()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupViews()
    }

    private func setupViews() {
        wantsLayer = true

        iconField = NSTextField(labelWithString: "")
        iconField.font = NSFont.systemFont(ofSize: 15)
        iconField.frame = NSRect(x: 10, y: 8, width: 24, height: 22)
        addSubview(iconField)

        titleField = NSTextField(labelWithString: "")
        titleField.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        titleField.textColor = Theme.text
        titleField.lineBreakMode = .byTruncatingTail
        titleField.frame = NSRect(x: 38, y: 17, width: bounds.width - 125, height: 18)
        titleField.autoresizingMask = [.width]
        addSubview(titleField)

        subtitleField = NSTextField(labelWithString: "")
        subtitleField.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        subtitleField.textColor = Theme.secondary
        subtitleField.lineBreakMode = .byTruncatingTail
        subtitleField.frame = NSRect(x: 38, y: 3, width: bounds.width - 125, height: 15)
        subtitleField.autoresizingMask = [.width]
        addSubview(subtitleField)

        badgeField = NSTextField(labelWithString: "")
        badgeField.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        badgeField.textColor = Theme.tertiary
        badgeField.alignment = .right
        badgeField.frame = NSRect(x: bounds.width - 84, y: 10, width: 62, height: 18)
        badgeField.autoresizingMask = [.minXMargin]
        addSubview(badgeField)
    }
}

class SpotlightPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    /// With the follow-up pill away, just start typing: it comes back and gets the key.
    override func keyDown(with event: NSEvent) {
        if let delegate = NSApp.delegate as? AppDelegate, delegate.isExpanded, !delegate.pillVisible,
           let first = event.characters?.unicodeScalars.first?.value, first >= 32, first < 0xF700,
           !event.modifierFlags.contains(.command), !event.modifierFlags.contains(.control) {
            delegate.setFollowUp(visible: true)
            delegate.textField.currentEditor()?.keyDown(with: event)
            return
        }
        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.keyCode == 53 {
            if let delegate = NSApp.delegate as? AppDelegate {
                if delegate.contextPanel?.isVisible == true {
                    delegate.hideContextPanel()
                    return true
                }
                if delegate.isExpanded && delegate.isWorking {
                    delegate.onStopClicked()
                    return true
                }
                delegate.onCancelClicked()
                return true
            }
        }
        if event.modifierFlags.contains(.command), let chars = event.charactersIgnoringModifiers {
            switch chars.lowercased() {
            case ".":
                if let delegate = NSApp.delegate as? AppDelegate {
                    delegate.onStopClicked()
                    return true
                }
            case "w":
                if let delegate = NSApp.delegate as? AppDelegate {
                    if !delegate.isExpanded {
                        delegate.onCancelClicked()
                    }
                    return true
                }
            case "v":
                if NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: self) {
                    return true
                }
                if let str = NSPasteboard.general.string(forType: .string),
                   let editor = self.firstResponder as? NSText {
                    editor.replaceCharacters(in: editor.selectedRange, with: str)
                    return true
                }
                return false
            case "c": return NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: self)
            case "x": return NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: self)
            case "a":
                if NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: self) {
                    return true
                }
                if let editor = self.firstResponder as? NSText {
                    editor.selectAll(nil)
                    return true
                }
                return false
            case "z":
                if event.modifierFlags.contains(.shift) {
                    return NSApp.sendAction(Selector(("redo:")), to: nil, from: self)
                } else {
                    return NSApp.sendAction(Selector(("undo:")), to: nil, from: self)
                }
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        if let delegate = NSApp.delegate as? AppDelegate {
            if delegate.contextPanel?.isVisible == true {
                delegate.hideContextPanel()
                return
            }
            if delegate.isExpanded && delegate.isWorking {
                delegate.onStopClicked()
                return
            }
            delegate.onCancelClicked()
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    var panel: SpotlightPanel!
    var rootView: NSView!
    var textField: NSTextField!
    var attachmentChipsLabel: NSTextField!
    /// After a request is sent there is no box: the mascot, a small toolbar and a stack of cards.
    var progressRoot: FlippedView?
    var feed: ActivityFeed!
    var toolbar: ToolbarView!
    var requestCard: ActivityCard?
    var answerCard: ActivityCard?
    var statusTimer: Timer?
    /// The pill comes back for a follow-up (pencil, return arrow, or just start typing) and goes when one is sent.
    var pillVisible = true
    var pillTextHeight: CGFloat = PromptLayout.textBase
    var feedCollapsed = false
    /// The mascot over the chat pill; nil when its art is not installed.
    var mascot: MascotView?
    var pillView: NSView!
    var plusButton: HudGlyphButton!
    var sendButton: HudGlyphButton!
    /// The round button beside the pill that picks the model; nil when the daemon offered no choice.
    var modelGlyph: HudGlyphButton?
    var modelKey: String = hudModelKey
    var answerText: String = ""
    var copyResetWork: DispatchWorkItem?
    var targetApp: String = "Desktop"
    var targetWindowTitle: String = ""
    var isWorking: Bool = false {
        didSet { updateWorkingChrome() }
    }
    var isExpanded: Bool = false

    var initialContext: [String: Any]?
    var contextPanel: NSPanel?
    var contextScrollView: NSScrollView?
    var contextTableView: NSTableView?
    var contextItems: [[String: Any]] = []
    var filteredContextItems: [[String: Any]] = []
    var selectedAttachments: [[String: Any]] = []

    init(targetApp: String, initialContext: [String: Any]? = nil, targetWindowTitle: String = "") {
        self.targetApp = targetApp
        self.initialContext = initialContext
        self.targetWindowTitle = targetWindowTitle
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        setupUI()
        discoverNativeContext()
        if let ctx = initialContext {
            loadHierarchy(ctx)
        }
        setupInputReader()
        #if RH_UI_SNAPSHOT
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.runSnapshotScript() }
        #endif
    }

    #if RH_UI_SNAPSHOT
    /// Developer tool, compiled only with -D RH_UI_SNAPSHOT (never in the shipped helper): replays a
    /// JSON-lines script of daemon updates (RH_UI_SCRIPT) and writes PNGs of the window (RH_UI_OUT-<name>.png)
    /// so the layout can be checked without screen-recording permission.
    ///   {"submit":"..."}  act like the user pressed Return    {"type":"..."} type into the field
    ///   {"snap":"name"}   write a PNG                          anything else is a daemon update
    func runSnapshotScript() {
        let env = ProcessInfo.processInfo.environment
        guard let script = env["RH_UI_SCRIPT"], let text = try? String(contentsOfFile: script, encoding: .utf8) else { exit(2) }
        let out = env["RH_UI_OUT"] ?? "/tmp/rh-ui"
        // RH_UI_ANIMATE=1 plays the script live (with {"wait":seconds} pauses) so the real window can be watched or captured
        let live = env["RH_UI_ANIMATE"] != nil
        hudAnimated = live
        for line in text.split(separator: "\n") {
            guard let d = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            if let seconds = d["wait"] as? Double {
                RunLoop.current.run(until: Date().addingTimeInterval(seconds))
            } else if let q = d["submit"] as? String {
                selectedAttachments = []
                transitionToProgress(query: q)
            } else if let t = d["type"] as? String {
                textField.stringValue = t
                controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
            } else if d["followup"] != nil {
                setFollowUp(visible: true, focus: false)
            } else if d["collapse"] != nil {
                onToolbarCollapse()
            } else if let name = d["mascot"] as? String {
                let look = (d["look"] as? [Double]).map { CGPoint(x: $0[0], y: $0[1]) } ?? .zero
                mascot?.hold(name, look: look)
            } else if let q = d["picker"] as? String {
                showContextPanel(query: q)
            } else if let name = d["snap"] as? String {
                panel.displayIfNeeded()
                let view: NSView = (d["of"] as? String) == "picker" ? (contextPanel?.contentView ?? rootView) : (panel.contentView ?? rootView)
                view.layoutSubtreeIfNeeded()
                if let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                    view.cacheDisplay(in: view.bounds, to: rep)
                    if let data = rep.representation(using: .png, properties: [:]) {
                        try? data.write(to: URL(fileURLWithPath: "\(out)-\(name).png"))
                    }
                }
            } else {
                handleUpdate(d)
            }
        }
        if live { RunLoop.current.run(until: Date().addingTimeInterval(25)) }
        exit(0)
    }
    #endif

    func setupMainMenu() {
        let mainMenu = NSMenu()
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        NSApp.mainMenu = mainMenu
    }

    /// The pill: the text plus 15 above and below it, and a row for what is attached with @ when there is one.
    func pillHeight(textHeight: CGFloat) -> CGFloat {
        let chips: CGFloat = attachmentChipsLabel?.isHidden == false ? PromptLayout.chipsRow : 0
        return max(PromptLayout.pillMinHeight, textHeight + 30 + chips)
    }

    /// Height of the whole prompt window: the pill with the mascot standing on it.
    func promptHeight(textHeight: CGFloat) -> CGFloat {
        let above = MascotView.isAvailable ? PromptLayout.gap + PromptLayout.mascotHeight + PromptLayout.topInset : 6
        return PromptLayout.bottomInset + pillHeight(textHeight: textHeight) + above
    }

    func setupUI() {
        guard let screen = NSScreen.main else { exit(1) }
        let screenRect = screen.frame
        let width = PromptLayout.windowWidth(hasModels: !hudModels.isEmpty)
        let height = promptHeight(textHeight: PromptLayout.textBase)
        let x = (screenRect.origin.x + (screenRect.width - width) / 2).rounded()
        let y = (screenRect.origin.y + screenRect.height * 0.58).rounded()

        let rect = NSRect(x: x, y: y, width: width, height: height)
        panel = SpotlightPanel(
            contentRect: rect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The window is mostly see-through here, and a system shadow would trace the animated mascot badly: the pill carries its own.
        panel.hasShadow = false
        panel.isMovableByWindowBackground = true
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // Nothing behind the mascot and the pill: only they are drawn. (The progress window, once a task starts, is solid black.)
        rootView = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        rootView.wantsLayer = true

        if MascotView.isAvailable {
            let view = MascotView(frame: .zero)
            view.onCloseRequested = { [weak self] in self?.onCancelClicked() }
            mascot = view
            rootView.addSubview(view)
        }

        func softShadow(_ layer: CALayer?) {
            layer?.shadowColor = NSColor.black.cgColor
            layer?.shadowOpacity = 0.45
            layer?.shadowRadius = 14
            layer?.shadowOffset = CGSize(width: 0, height: -4)
        }

        pillView = NSView(frame: .zero)
        pillView.wantsLayer = true
        pillView.layer?.backgroundColor = Theme.pill.cgColor
        pillView.layer?.cornerRadius = PromptLayout.pillMinHeight / 2
        pillView.layer?.borderWidth = 1
        pillView.layer?.borderColor = Theme.border.cgColor
        softShadow(pillView.layer)
        pillView.toolTip = "Working in \(targetApp)"
        rootView.addSubview(pillView)

        plusButton = HudGlyphButton(frame: NSRect(x: 0, y: 0, width: PromptLayout.buttonSize, height: PromptLayout.buttonSize))
        plusButton.glyph = .plus
        plusButton.target = self
        plusButton.action = #selector(onPlusClicked)
        plusButton.toolTip = "Attach context (@)"
        pillView.addSubview(plusButton)

        sendButton = HudGlyphButton(frame: NSRect(x: 0, y: 0, width: PromptLayout.buttonSize, height: PromptLayout.buttonSize))
        sendButton.glyph = .arrowUp
        sendButton.target = self
        sendButton.action = #selector(onSendClicked)
        sendButton.toolTip = "Send (Return)"
        pillView.addSubview(sendButton)

        attachmentChipsLabel = NSTextField(labelWithString: "")
        attachmentChipsLabel.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        attachmentChipsLabel.textColor = Theme.accent
        attachmentChipsLabel.lineBreakMode = .byTruncatingTail
        attachmentChipsLabel.isHidden = true
        pillView.addSubview(attachmentChipsLabel)

        textField = NSTextField(frame: .zero)
        textField.isBordered = false
        textField.drawsBackground = false
        textField.focusRingType = .none
        textField.font = NSFont.systemFont(ofSize: 15, weight: .regular)
        textField.textColor = Theme.text
        setPlaceholder(Copy.placeholder, size: 15)
        textField.isEditable = true
        textField.isSelectable = true
        textField.delegate = self
        pillView.addSubview(textField)

        if !hudModels.isEmpty {
            let glyph = HudGlyphButton(frame: .zero)
            glyph.glyph = .sparkle
            glyph.fill = Theme.pill
            glyph.glyphColor = Theme.secondary
            glyph.outlined = true
            glyph.wantsLayer = true
            softShadow(glyph.layer)
            glyph.target = self
            glyph.action = #selector(onModelClicked(_:))
            modelGlyph = glyph
            rootView.addSubview(glyph)
            updateModelButton()
        }

        layoutPrompt(textHeight: PromptLayout.textBase)
        updateSendButton()

        panel.contentView = rootView
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(textField)
    }

    /// The inside of the pill: the buttons sit on its bottom line, centred on the first row of text.
    func layoutPillContents(textHeight: CGFloat) {
        let pillW = PromptLayout.pillWidth
        let size = PromptLayout.buttonSize
        plusButton.frame = NSRect(x: PromptLayout.buttonInset, y: PromptLayout.buttonInset, width: size, height: size)
        sendButton.frame = NSRect(x: pillW - PromptLayout.buttonInset - size, y: PromptLayout.buttonInset, width: size, height: size)
        textField.frame = NSRect(x: PromptLayout.textLeft, y: 15, width: pillW - PromptLayout.textLeft * 2, height: textHeight)
        if attachmentChipsLabel.isHidden == false {
            attachmentChipsLabel.frame = NSRect(x: 20, y: 15 + textHeight + 6, width: pillW - 40, height: 16)
        }
    }

    /// Places everything in the prompt window, bottom up: the pill (which grows with the text), the mascot on top of it.
    func layoutPrompt(textHeight: CGFloat) {
        let hasModels = modelGlyph != nil
        let width = PromptLayout.windowWidth(hasModels: hasModels)
        let pillW = PromptLayout.pillWidth
        let pillH = pillHeight(textHeight: textHeight)
        pillView.frame = NSRect(x: PromptLayout.side, y: PromptLayout.bottomInset, width: pillW, height: pillH)
        layoutPillContents(textHeight: textHeight)
        modelGlyph?.frame = NSRect(x: PromptLayout.side + pillW + PromptLayout.modelGap, y: PromptLayout.bottomInset, width: PromptLayout.pillMinHeight, height: PromptLayout.pillMinHeight)
        if let view = mascot {
            let h = PromptLayout.mascotHeight
            let w = (h * MascotView.aspect).rounded()
            view.frame = NSRect(x: ((width - w) / 2).rounded(), y: PromptLayout.bottomInset + pillH + PromptLayout.gap, width: w, height: h)
        }
    }

    /// The send arrow is bright once there is something to send.
    func updateSendButton() {
        guard sendButton != nil, textField != nil else { return }
        let hasText = !textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        sendButton.fill = hasText ? Theme.send : Theme.send.withAlphaComponent(0.35)
        sendButton.glyphColor = hasText ? .white : NSColor(white: 1.0, alpha: 0.65)
    }

    /// The + opens the same picker as typing @.
    @objc func onPlusClicked() {
        if !textField.stringValue.hasSuffix("@") { textField.stringValue += "@" }
        panel.makeFirstResponder(textField)
        textField.currentEditor()?.moveToEndOfDocument(nil)
        controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: textField))
    }

    @objc func onSendClicked() {
        // The arrow does what Return does: with the / menu open it picks the highlighted row instead of sending the words.
        if contextPanel?.isVisible == true, textField.stringValue.hasPrefix("/") {
            let sel = contextTableView?.selectedRow ?? 0
            if sel >= 0 && sel < filteredContextItems.count {
                attachItem(filteredContextItems[sel])
                return
            }
        }
        _ = submitPrompt()
    }

    /// The button shows the model the next task will use.
    func updateModelButton() {
        let label = hudModels.first(where: { $0["key"] == modelKey })?["label"] ?? hudModels.first?["label"] ?? ""
        modelGlyph?.toolTip = "Model for your next task: \(label)"
    }

    @objc func onModelClicked(_ sender: NSButton) {
        let menu = NSMenu()
        for model in hudModels {
            guard let key = model["key"], let label = model["label"] else { continue }
            let item = NSMenuItem(title: label, action: #selector(onModelPicked(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            item.state = key == modelKey ? .on : .off
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: 0), in: sender)
        panel.makeFirstResponder(textField)
    }

    @objc func onModelPicked(_ item: NSMenuItem) {
        guard let key = item.representedObject as? String, key != modelKey else { return }
        modelKey = key
        updateModelButton()
        let dict: [String: Any] = ["event": "model", "model": key]
        if let data = try? JSONSerialization.data(withJSONObject: dict), let json = String(data: data, encoding: .utf8) {
            print(json)
            fflush(stdout)
        }
    }

    func badgeText(_ app: String) -> NSAttributedString {
        let out = NSMutableAttributedString(string: "●  ", attributes: [.font: NSFont.systemFont(ofSize: 8, weight: .bold), .foregroundColor: Theme.accent, .baselineOffset: 1.5])
        out.append(NSAttributedString(string: app, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: Theme.secondary]))
        return out
    }

    func setPlaceholder(_ text: String, size: CGFloat) {
        textField.placeholderAttributedString = NSAttributedString(string: text, attributes: [
            .foregroundColor: Theme.tertiary,
            .font: NSFont.systemFont(ofSize: size, weight: .regular)
        ])
    }

    func makePillButton(title: String, frame: NSRect, tint: NSColor, fill: NSColor, action: Selector) -> HudActionButton {
        let b = HudActionButton(frame: frame)
        b.title = title
        b.bezelStyle = .regularSquare
        b.isBordered = false
        b.wantsLayer = true
        b.layer?.cornerRadius = frame.height / 2
        b.layer?.masksToBounds = true
        b.layer?.backgroundColor = fill.cgColor
        b.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        b.contentTintColor = tint
        b.attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: tint, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)])
        b.target = self
        b.action = action
        return b
    }

    /// One place that sets the status word (on the newest request card) and its colour.
    func setStatus(_ word: String, color: NSColor) {
        requestCard?.setStatus(word, color: color)
    }

    /// Follows `isWorking`: the stop button, the dots after the status word, the follow-up hint.
    func updateWorkingChrome() {
        guard isExpanded else { return }
        requestCard?.setWorking(isWorking)
        if !isWorking { feed?.finishActiveStep() }
        statusTimer?.invalidate()
        statusTimer = nil
        if isWorking {
            let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in self?.requestCard?.tickDots() }
            RunLoop.main.add(timer, forMode: .common)
            statusTimer = timer
        }
        if textField != nil {
            setPlaceholder(isWorking ? Copy.followUpWhileWorking : Copy.followUp, size: 15)
        }
    }

    func discoverNativeContext() {
        var items: [[String: Any]] = []

        let arcPath = NSHomeDirectory() + "/Library/Application Support/Arc/StorableSidebar.json"
        if FileManager.default.fileExists(atPath: arcPath),
           let data = try? Data(contentsOf: URL(fileURLWithPath: arcPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            var tabs: [(title: String, url: String)] = []
            var seen = Set<String>()
            func walk(_ obj: Any) {
                if let dict = obj as? [String: Any] {
                    if let d = dict["data"] as? [String: Any],
                       let tab = d["tab"] as? [String: Any],
                       let url = tab["savedURL"] as? String {
                        if !seen.contains(url) {
                            seen.insert(url)
                            let title = (dict["title"] as? String) ?? (tab["savedTitle"] as? String) ?? url
                            tabs.append((title: title, url: url))
                        }
                    }
                    for (_, v) in dict { walk(v) }
                } else if let arr = obj as? [Any] {
                    for v in arr { walk(v) }
                }
            }
            walk(json)
            for (idx, t) in tabs.enumerated() {
                let domain = URL(string: t.url)?.host ?? ""
                items.append([
                    "type": "browser_tab",
                    "id": "arc-\(idx)",
                    "browser": "Arc",
                    "profile": "Default",
                    "title": t.title,
                    "url": t.url,
                    "label": "Arc: \(t.title)",
                    "subtitle": domain.isEmpty ? t.url : "Arc · \(domain)",
                    "icon": "🌐"
                ])
            }
        }

        func parseChromium(folder: String, browserName: String) {
            let base = NSHomeDirectory() + "/Library/Application Support/" + folder
            guard FileManager.default.fileExists(atPath: base) else { return }
            var profileNames: [String: String] = ["Default": "Default"]
            let localState = (base as NSString).appendingPathComponent("Local State")
            if let data = try? Data(contentsOf: URL(fileURLWithPath: localState)),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let profDict = json["profile"] as? [String: Any],
               let infoCache = profDict["info_cache"] as? [String: Any] {
                for (k, v) in infoCache {
                    if let d = v as? [String: Any], let name = d["name"] as? String {
                        profileNames[k] = name
                    }
                }
            }

            let fm = FileManager.default
            for (dirName, profName) in profileNames {
                let sessionsDir = (base as NSString).appendingPathComponent(dirName + "/Sessions")
                guard let files = try? fm.contentsOfDirectory(atPath: sessionsDir) else { continue }
                let sessionFiles = files.filter { $0.hasPrefix("Tabs_") || $0.hasPrefix("Session_") }
                guard let latest = sessionFiles.max(by: { a, b in
                    let aPath = (sessionsDir as NSString).appendingPathComponent(a)
                    let bPath = (sessionsDir as NSString).appendingPathComponent(b)
                    let aTime = (try? fm.attributesOfItem(atPath: aPath)[.modificationDate] as? Date) ?? Date.distantPast
                    let bTime = (try? fm.attributesOfItem(atPath: bPath)[.modificationDate] as? Date) ?? Date.distantPast
                    return aTime < bTime
                }) else { continue }

                let filePath = (sessionsDir as NSString).appendingPathComponent(latest)
                guard let data = try? Data(contentsOf: URL(fileURLWithPath: filePath)) else { continue }

                var seen = Set<String>()
                data.withUnsafeBytes { raw in
                    guard let ptr = raw.bindMemory(to: UInt8.self).baseAddress else { return }
                    let len = data.count
                    var i = 0
                    while i < len - 8 {
                        if (ptr[i] == 0x68 && ptr[i+1] == 0x74 && ptr[i+2] == 0x74 && ptr[i+3] == 0x70 && ptr[i+4] == 0x73 && ptr[i+5] == 0x3a && ptr[i+6] == 0x2f && ptr[i+7] == 0x2f) ||
                           (ptr[i] == 0x68 && ptr[i+1] == 0x74 && ptr[i+2] == 0x74 && ptr[i+3] == 0x70 && ptr[i+4] == 0x3a && ptr[i+5] == 0x2f && ptr[i+6] == 0x2f) {
                            let start = i
                            while i < len && ptr[i] >= 0x21 && ptr[i] <= 0x7e {
                                i += 1
                            }
                            let sub = data.subdata(in: start..<i)
                            if let urlStr = String(data: sub, encoding: .utf8),
                               let url = URL(string: urlStr),
                               let host = url.host,
                               !seen.contains(urlStr) {
                                seen.insert(urlStr)
                                var title = host
                                let comps = url.pathComponents.filter { $0 != "/" }
                                if let last = comps.last {
                                    title += " / " + last
                                }
                                items.append([
                                    "type": "browser_tab",
                                    "id": "\(browserName.lowercased())-\(dirName)-\(items.count)",
                                    "browser": browserName,
                                    "profile": profName,
                                    "title": title,
                                    "url": urlStr,
                                    "label": "\(browserName): \(title)",
                                    "subtitle": "\(browserName) (\(profName)) · \(host)",
                                    "icon": "🌐"
                                ])
                            }
                        } else {
                            i += 1
                        }
                    }
                }
            }
        }

        parseChromium(folder: "Google/Chrome", browserName: "Google Chrome")
        parseChromium(folder: "BraveSoftware/Brave-Browser", browserName: "Brave")

        let regularApps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        for app in regularApps {
            if let name = app.localizedName, !name.isEmpty {
                let id = app.bundleIdentifier ?? name
                items.append([
                    "type": "app_window",
                    "id": "app-\(id)",
                    "app": name,
                    "title": name,
                    "label": name,
                    "subtitle": "Running Application",
                    "icon": "💻"
                ])
            }
        }

        let downloadsDir = NSHomeDirectory() + "/Downloads"
        let desktopDir = NSHomeDirectory() + "/Desktop"
        let fm = FileManager.default
        for dir in [downloadsDir, desktopDir] {
            guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            let folderName = (dir as NSString).lastPathComponent
            let sortedEntries = entries.filter { !$0.hasPrefix(".") }.sorted { a, b in
                let aP = (dir as NSString).appendingPathComponent(a)
                let bP = (dir as NSString).appendingPathComponent(b)
                let aT = (try? fm.attributesOfItem(atPath: aP)[.modificationDate] as? Date) ?? Date.distantPast
                let bT = (try? fm.attributesOfItem(atPath: bP)[.modificationDate] as? Date) ?? Date.distantPast
                return aT > bT
            }
            for name in sortedEntries.prefix(30) {
                let fullPath = (dir as NSString).appendingPathComponent(name)
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: fullPath, isDirectory: &isDir) {
                    items.append([
                        "type": "local_file",
                        "id": "file-\(name)",
                        "name": name,
                        "path": fullPath,
                        "isDir": isDir.boolValue,
                        "folder": folderName,
                        "label": name,
                        "subtitle": "\(folderName) · \(name)",
                        "icon": "📄"
                    ])
                }
            }
        }

        if !items.isEmpty {
            self.contextItems = items
        }
    }

    func loadHierarchy(_ h: [String: Any]) {
        var items: [[String: Any]] = []

        if let browsers = h["browsers"] as? [[String: Any]] {
            for b in browsers {
                let bName = b["name"] as? String ?? "Browser"
                if let profiles = b["profiles"] as? [[String: Any]] {
                    for p in profiles {
                        let pName = p["name"] as? String ?? "Default"
                        if let tabs = p["tabs"] as? [[String: Any]] {
                            for t in tabs {
                                let title = t["title"] as? String ?? ""
                                let url = t["url"] as? String ?? ""
                                let id = t["id"] as? String ?? UUID().uuidString
                                let tabIndex = t["tabIndex"] as? Int
                                let domain = URL(string: url)?.host ?? ""
                                var att: [String: Any] = [
                                    "type": "browser_tab",
                                    "id": id,
                                    "browser": bName,
                                    "profile": pName,
                                    "title": title,
                                    "url": url,
                                    "label": "\(bName): \(title)",
                                    "subtitle": domain.isEmpty ? "\(bName) (\(pName))" : "\(bName) (\(pName)) · \(domain)",
                                    "icon": "🌐"
                                ]
                                if let idx = tabIndex {
                                    att["tabIndex"] = idx
                                }
                                items.append(att)
                            }
                        }
                    }
                }
            }
        }

        if let apps = h["apps"] as? [[String: Any]] {
            for a in apps {
                let aName = a["name"] as? String ?? ""
                let aId = a["id"] as? String ?? aName
                let windows = a["windows"] as? [[String: Any]] ?? []
                let wTitle = windows.first?["title"] as? String ?? aName
                items.append([
                    "type": "app_window",
                    "id": "app-\(aId)",
                    "app": aName,
                    "title": wTitle,
                    "label": aName,
                    "subtitle": "Running Application",
                    "icon": "💻"
                ])
            }
        }

        if let files = h["files"] as? [[String: Any]] {
            for f in files {
                let fName = f["name"] as? String ?? ""
                let fPath = f["path"] as? String ?? ""
                let fId = f["id"] as? String ?? fName
                let isDir = f["isDir"] as? Bool ?? false
                let folderName = (fPath as NSString).deletingLastPathComponent.split(separator: "/").last.map(String.init) ?? "Files"
                items.append([
                    "type": "local_file",
                    "id": fId,
                    "name": fName,
                    "path": fPath,
                    "isDir": isDir,
                    "folder": folderName,
                    "label": fName,
                    "subtitle": "\(folderName) · \(fName)",
                    "icon": "📄"
                ])
            }
        }

        if !items.isEmpty {
            self.contextItems = items
        }
    }

    /// The chats /history listed (nil until the daemon answers).
    var historyItems: [[String: Any]]?
    var historyRequested = false
    /// True while the chat list is what the / menu shows, so it is fetched once per opening and kept fresh.
    var inHistoryView = false

    func requestHistory() {
        guard !historyRequested else { return }
        historyRequested = true
        print("{\"event\":\"history\"}")
        fflush(stdout)
    }

    /// The / menu: one command now (/history), then the chats once /history is picked ("/history " + words filters them).
    func showSlashPanel(_ text: String) {
        let lower = text.lowercased()
        if lower.hasPrefix("/history ") {
            if !inHistoryView {
                inHistoryView = true
                requestHistory()
            }
            let query = String(lower.dropFirst("/history ".count)).trimmingCharacters(in: .whitespaces)
            var rows: [[String: Any]] = []
            if let chats = historyItems {
                for chat in chats {
                    let title = chat["title"] as? String ?? ""
                    if !query.isEmpty && !title.lowercased().contains(query) { continue }
                    let count = chat["count"] as? Int ?? 1
                    rows.append(["type": "chat", "id": chat["id"] as? String ?? "", "label": title,
                                 "subtitle": count == 1 ? "1 message" : "\(count) messages", "icon": "💬", "badge": chat["when"] as? String ?? ""])
                }
                if rows.isEmpty {
                    rows = [["type": "info", "id": "", "label": chats.isEmpty ? "No chats yet" : "No chats match", "subtitle": "", "icon": "🕘", "badge": ""]]
                }
            } else {
                rows = [["type": "info", "id": "", "label": "Loading chats…", "subtitle": "", "icon": "🕘", "badge": ""]]
            }
            filteredContextItems = rows
        } else {
            inHistoryView = false
            let query = String(lower.dropFirst())
            if !query.isEmpty && !"history".hasPrefix(query) {
                hideContextPanel()   // not a command: it is an ordinary message
                return
            }
            filteredContextItems = [["type": "slash", "id": "/history", "label": "/history", "subtitle": "Continue a previous chat", "icon": "🕘", "badge": ""]]
        }
        presentPanelRows()
    }

    /// A row of the / menu was picked.
    func pickSlashRow(_ item: [String: Any]) {
        switch item["type"] as? String ?? "" {
        case "slash":
            textField.stringValue = "/history "
            textField.currentEditor()?.selectedRange = NSRange(location: textField.stringValue.count, length: 0)
            showSlashPanel(textField.stringValue)
        case "chat":
            guard let id = item["id"] as? String, !id.isEmpty else { return }
            textField.stringValue = ""
            hideContextPanel()
            fitPromptHeight()
            updateSendButton()
            if let data = try? JSONSerialization.data(withJSONObject: ["event": "resume", "id": id]),
               let json = String(data: data, encoding: .utf8) {
                print(json)
                fflush(stdout)
            }
        default:
            break   // "Loading…" / "No chats yet": nothing to pick
        }
    }

    func showContextPanel(query: String) {
        if contextItems.isEmpty {
            discoverNativeContext()
        }

        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = q.split(separator: "/").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

        if q.isEmpty {
            var topList: [[String: Any]] = []

            let currentAppLower = targetApp.lowercased()
            let activeItems = contextItems.filter {
                let b = ($0["browser"] as? String ?? "").lowercased()
                let a = ($0["app"] as? String ?? "").lowercased()
                return (!b.isEmpty && b.contains(currentAppLower)) || (!a.isEmpty && a.contains(currentAppLower))
            }
            for it in activeItems.prefix(4) {
                var copy = it
                copy["badge"] = "⚡ Active"
                topList.append(copy)
            }

            let categories: [[String: Any]] = [
                ["type": "category", "id": "cat:arc", "category": "Arc", "label": "Arc", "subtitle": "Open tabs & spaces", "icon": "🌐", "badge": "›"],
                ["type": "category", "id": "cat:chrome", "category": "Chrome", "label": "Google Chrome", "subtitle": "Profiles & tabs", "icon": "🌐", "badge": "›"],
                ["type": "category", "id": "cat:brave", "category": "Brave", "label": "Brave Browser", "subtitle": "Tabs", "icon": "🌐", "badge": "›"],
                ["type": "category", "id": "cat:downloads", "category": "Downloads", "label": "Downloads", "subtitle": "Recent downloaded files", "icon": "📁", "badge": "›"],
                ["type": "category", "id": "cat:desktop", "category": "Desktop", "label": "Desktop", "subtitle": "Desktop files & screenshots", "icon": "📁", "badge": "›"],
                ["type": "category", "id": "cat:apps", "category": "Apps", "label": "Running Applications", "subtitle": "Switch or reference apps", "icon": "💻", "badge": "›"],
            ]
            topList.append(contentsOf: categories)
            filteredContextItems = topList
        } else if parts.count > 1 || q.hasSuffix("/") {
            let cat = parts.first ?? ""
            let filterTerm = parts.count > 1 ? parts[1] : ""

            if cat.contains("arc") {
                filteredContextItems = contextItems.filter {
                    guard ($0["browser"] as? String ?? "").lowercased().contains("arc") else { return false }
                    if filterTerm.isEmpty { return true }
                    let title = ($0["title"] as? String ?? "").lowercased()
                    let url = ($0["url"] as? String ?? "").lowercased()
                    return title.contains(filterTerm) || url.contains(filterTerm)
                }
            } else if cat.contains("chrome") {
                if parts.count > 2 {
                    let prof = parts[1]
                    let tabTerm = parts[2]
                    filteredContextItems = contextItems.filter {
                        guard ($0["browser"] as? String ?? "").lowercased().contains("chrome") else { return false }
                        guard ($0["profile"] as? String ?? "").lowercased().contains(prof) else { return false }
                        if tabTerm.isEmpty { return true }
                        let title = ($0["title"] as? String ?? "").lowercased()
                        let url = ($0["url"] as? String ?? "").lowercased()
                        return title.contains(tabTerm) || url.contains(tabTerm)
                    }
                } else if filterTerm.isEmpty {
                    var profilesSeen = Set<String>()
                    var profItems: [[String: Any]] = []
                    for it in contextItems where (it["browser"] as? String ?? "").lowercased().contains("chrome") {
                        if let prof = it["profile"] as? String, !profilesSeen.contains(prof) {
                            profilesSeen.insert(prof)
                            profItems.append([
                                "type": "category",
                                "id": "cat:chrome:\(prof)",
                                "category": "Chrome / \(prof)",
                                "label": prof,
                                "subtitle": "Profile",
                                "icon": "👤",
                                "badge": "›"
                            ])
                        }
                    }
                    filteredContextItems = profItems
                } else {
                    filteredContextItems = contextItems.filter {
                        guard ($0["browser"] as? String ?? "").lowercased().contains("chrome") else { return false }
                        let title = ($0["title"] as? String ?? "").lowercased()
                        let url = ($0["url"] as? String ?? "").lowercased()
                        let prof = ($0["profile"] as? String ?? "").lowercased()
                        return title.contains(filterTerm) || url.contains(filterTerm) || prof.contains(filterTerm)
                    }
                }
            } else if cat.contains("brave") {
                filteredContextItems = contextItems.filter {
                    guard ($0["browser"] as? String ?? "").lowercased().contains("brave") else { return false }
                    if filterTerm.isEmpty { return true }
                    let title = ($0["title"] as? String ?? "").lowercased()
                    let url = ($0["url"] as? String ?? "").lowercased()
                    return title.contains(filterTerm) || url.contains(filterTerm)
                }
            } else if cat.contains("download") || cat.contains("finder") {
                filteredContextItems = contextItems.filter {
                    guard ($0["folder"] as? String ?? "").lowercased().contains("download") else { return false }
                    if filterTerm.isEmpty { return true }
                    let name = ($0["name"] as? String ?? "").lowercased()
                    return name.contains(filterTerm)
                }
            } else if cat.contains("desktop") {
                filteredContextItems = contextItems.filter {
                    guard ($0["folder"] as? String ?? "").lowercased().contains("desktop") else { return false }
                    if filterTerm.isEmpty { return true }
                    let name = ($0["name"] as? String ?? "").lowercased()
                    return name.contains(filterTerm)
                }
            } else if cat.contains("app") {
                filteredContextItems = contextItems.filter {
                    guard $0["type"] as? String == "app_window" else { return false }
                    if filterTerm.isEmpty { return true }
                    let name = ($0["name"] as? String ?? "").lowercased()
                    return name.contains(filterTerm)
                }
            } else {
                filteredContextItems = contextItems.filter {
                    let label = ($0["label"] as? String ?? "").lowercased()
                    let title = ($0["title"] as? String ?? "").lowercased()
                    let name = ($0["name"] as? String ?? "").lowercased()
                    let url = ($0["url"] as? String ?? "").lowercased()
                    return label.contains(q) || title.contains(q) || name.contains(q) || url.contains(q)
                }
            }
        } else {
            let catMatches = [
                ("arc", ["type": "category", "id": "cat:arc", "category": "Arc", "label": "Arc", "subtitle": "Open tabs & spaces", "icon": "🌐", "badge": "›"]),
                ("chrome", ["type": "category", "id": "cat:chrome", "category": "Chrome", "label": "Google Chrome", "subtitle": "Profiles & tabs", "icon": "🌐", "badge": "›"]),
                ("brave", ["type": "category", "id": "cat:brave", "category": "Brave", "label": "Brave Browser", "subtitle": "Tabs", "icon": "🌐", "badge": "›"]),
                ("download", ["type": "category", "id": "cat:downloads", "category": "Downloads", "label": "Downloads", "subtitle": "Recent downloaded files", "icon": "📁", "badge": "›"]),
                ("finder", ["type": "category", "id": "cat:downloads", "category": "Downloads", "label": "Downloads", "subtitle": "Recent downloaded files", "icon": "📁", "badge": "›"]),
                ("desktop", ["type": "category", "id": "cat:desktop", "category": "Desktop", "label": "Desktop", "subtitle": "Desktop files & screenshots", "icon": "📁", "badge": "›"]),
                ("app", ["type": "category", "id": "cat:apps", "category": "Apps", "label": "Running Applications", "subtitle": "Switch or reference apps", "icon": "💻", "badge": "›"]),
            ]
            var matchedCats: [[String: Any]] = []
            for (key, dict) in catMatches {
                if key.contains(q) || q.contains(key) {
                    matchedCats.append(dict)
                }
            }

            let itemMatches = contextItems.filter {
                let label = ($0["label"] as? String ?? "").lowercased()
                let title = ($0["title"] as? String ?? "").lowercased()
                let name = ($0["name"] as? String ?? "").lowercased()
                let url = ($0["url"] as? String ?? "").lowercased()
                let app = ($0["app"] as? String ?? "").lowercased()
                let browser = ($0["browser"] as? String ?? "").lowercased()
                return label.contains(q) || title.contains(q) || name.contains(q) || url.contains(q) || app.contains(q) || browser.contains(q)
            }

            var merged = matchedCats
            merged.append(contentsOf: itemMatches)
            filteredContextItems = merged
        }

        presentPanelRows()
    }

    /// Shows `filteredContextItems` in the popover under the pill (the @ attach list and the / menu share it).
    func presentPanelRows() {
        if filteredContextItems.isEmpty {
            hideContextPanel()
            return
        }

        let rowCount = min(7, filteredContextItems.count)
        let targetHeight: CGFloat = CGFloat(rowCount * 38 + 14)
        let panelFrame = panel.frame
        // Under the pill, as wide as the pill (the expanded window has no pill: full width).
        let inset = PromptLayout.side
        let popoverWidth = PromptLayout.pillWidth
        let popoverRect = NSRect(x: panelFrame.origin.x + inset, y: panelFrame.origin.y - targetHeight - 6, width: popoverWidth, height: targetHeight)

        if contextPanel == nil {
            let p = NSPanel(
                contentRect: popoverRect,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            p.level = .floating
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.appearance = NSAppearance(named: .darkAqua)

            let effect = NSView(frame: NSRect(origin: .zero, size: popoverRect.size))
            effect.wantsLayer = true
            effect.layer?.backgroundColor = Theme.background.cgColor
            effect.layer?.cornerRadius = 14
            effect.layer?.masksToBounds = true
            effect.layer?.borderWidth = 1
            effect.layer?.borderColor = Theme.border.cgColor

            let scroll = NSScrollView(frame: NSRect(x: 6, y: 6, width: popoverRect.width - 12, height: targetHeight - 12))
            scroll.drawsBackground = false
            scroll.hasVerticalScroller = true
            scroll.autohidesScrollers = true
            scroll.borderType = .noBorder

            let table = NSTableView(frame: scroll.bounds)
            table.headerView = nil
            table.backgroundColor = .clear
            table.rowHeight = 38
            table.selectionHighlightStyle = .regular
            table.target = self
            table.action = #selector(onTableRowClicked)
            table.autoresizingMask = [.width, .height]

            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("contextCol"))
            column.resizingMask = .autoresizingMask
            column.width = scroll.bounds.width
            table.addTableColumn(column)

            table.dataSource = self
            table.delegate = self

            scroll.documentView = table

            effect.addSubview(scroll)
            p.contentView = effect

            self.contextPanel = p
            self.contextScrollView = scroll
            self.contextTableView = table
        } else {
            contextPanel?.setFrame(popoverRect, display: true)
            contextScrollView?.frame = NSRect(x: 6, y: 6, width: popoverRect.width - 12, height: targetHeight - 12)
            contextTableView?.frame = contextScrollView?.bounds ?? .zero
        }

        contextTableView?.reloadData()
        if !filteredContextItems.isEmpty {
            contextTableView?.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        }
        contextPanel?.orderFront(nil)
        panel.addChildWindow(contextPanel!, ordered: .above)
    }

    func hideContextPanel() {
        inHistoryView = false
        if let cp = contextPanel, cp.isVisible {
            panel.removeChildWindow(cp)
            cp.orderOut(nil)
        }
    }

    func attachItem(_ item: [String: Any]) {
        if let kind = item["type"] as? String, kind == "slash" || kind == "chat" || kind == "info" {
            pickSlashRow(item)
            return
        }
        let itemType = item["type"] as? String ?? ""
        if itemType == "category" {
            let catName = item["category"] as? String ?? ""
            let cur = textField.stringValue
            if let atRange = cur.range(of: "@", options: .backwards) {
                let prefix = String(cur[..<atRange.lowerBound])
                textField.stringValue = "\(prefix)@\(catName) / "
                showContextPanel(query: "\(catName.lowercased()) / ")
            }
            return
        }

        var cleanItem = item
        cleanItem.removeValue(forKey: "label")
        cleanItem.removeValue(forKey: "subtitle")
        cleanItem.removeValue(forKey: "icon")
        cleanItem.removeValue(forKey: "badge")
        cleanItem.removeValue(forKey: "category")

        var alreadyAttached = false
        for existing in selectedAttachments {
            if let id1 = existing["id"] as? String, let id2 = cleanItem["id"] as? String, id1 == id2 {
                alreadyAttached = true
                break
            }
            if let u1 = existing["url"] as? String, let u2 = cleanItem["url"] as? String, u1 == u2 {
                alreadyAttached = true
                break
            }
            if let p1 = existing["path"] as? String, let p2 = cleanItem["path"] as? String, p1 == p2 {
                alreadyAttached = true
                break
            }
        }
        if !alreadyAttached {
            selectedAttachments.append(cleanItem)
        }

        let token: String
        if itemType == "browser_tab" {
            let b = cleanItem["browser"] as? String ?? "Web"
            let t = cleanItem["title"] as? String ?? "Tab"
            let shortTitle = t.count > 30 ? String(t.prefix(28)) + "…" : t
            token = "@[\(b): \(shortTitle)] "
        } else if itemType == "app_window" {
            let a = cleanItem["app"] as? String ?? "App"
            token = "@[App: \(a)] "
        } else if itemType == "local_file" {
            let n = cleanItem["name"] as? String ?? "File"
            let folder = cleanItem["folder"] as? String ?? "File"
            token = "@[\(folder): \(n)] "
        } else {
            let l = item["label"] as? String ?? "Item"
            token = "@[\(l)] "
        }

        let cur = textField.stringValue
        if let atRange = cur.range(of: "@", options: .backwards) {
            let prefix = String(cur[..<atRange.lowerBound])
            textField.stringValue = "\(prefix)\(token)"
        } else {
            textField.stringValue += " \(token)"
        }

        updateChipsDisplay()
        hideContextPanel()
        fitPromptHeight()
    }

    func updateChipsDisplay() {
        if selectedAttachments.isEmpty {
            attachmentChipsLabel.stringValue = ""
            attachmentChipsLabel.isHidden = true
        } else {
            let labels = selectedAttachments.compactMap { att -> String? in
                let type = att["type"] as? String ?? ""
                if type == "browser_tab" {
                    let b = att["browser"] as? String ?? "Web"
                    let t = att["title"] as? String ?? "Tab"
                    return "[\(b): \(t)]"
                } else if type == "app_window" {
                    let a = att["app"] as? String ?? "App"
                    return "[\(a)]"
                } else if type == "local_file" {
                    let n = att["name"] as? String ?? "File"
                    return "[\(n)]"
                }
                return nil
            }
            attachmentChipsLabel.stringValue = "📎 " + labels.joined(separator: " ")
            attachmentChipsLabel.isHidden = false
        }
        fitPromptHeight()
    }

    @objc func onTableRowClicked() {
        let row = contextTableView?.clickedRow ?? -1
        let targetRow = row >= 0 ? row : (contextTableView?.selectedRow ?? -1)
        if targetRow >= 0 && targetRow < filteredContextItems.count {
            attachItem(filteredContextItems[targetRow])
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int {
        return filteredContextItems.count
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        return ContextTableRowView()
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        return 38
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < filteredContextItems.count else { return nil }
        let item = filteredContextItems[row]
        let label = item["label"] as? String ?? ""
        let subtitle = item["subtitle"] as? String ?? ""
        let icon = item["icon"] as? String ?? "🌐"
        let badge = item["badge"] as? String ?? ""

        let cellId = NSUserInterfaceItemIdentifier("ContextCell")
        var cell = tableView.makeView(withIdentifier: cellId, owner: self) as? ContextTableCell
        if cell == nil {
            cell = ContextTableCell(frame: NSRect(x: 0, y: 0, width: tableView.bounds.width, height: 38))
            cell?.identifier = cellId
        }

        cell?.iconField.stringValue = icon
        cell?.titleField.stringValue = label
        cell?.subtitleField.stringValue = subtitle
        cell?.badgeField.stringValue = badge
        if badge == "⚡ Active" {
            cell?.badgeField.textColor = NSColor.systemCyan
        } else {
            cell?.badgeField.textColor = NSColor(white: 0.50, alpha: 1.0)
        }

        return cell
    }

    /// The pill grows with long or pasted text, line by line, so no line is cut off. In the prompt it grows upward (the
    /// mascot rides on top of it); in the progress view it grows in place and the window follows.
    func fitPromptHeight() {
        guard panel != nil, rootView != nil, textField != nil else { return }
        let font = textField.font ?? NSFont.systemFont(ofSize: 15)
        let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
        let wrapWidth = PromptLayout.pillWidth - PromptLayout.textLeft * 2 - 8   // the field keeps a few points of its own padding
        let measured = (textField.stringValue as NSString).boundingRect(
            with: NSSize(width: wrapWidth, height: 10_000),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        ).height
        let textHeight = min(lineHeight * 9 + 4, max(PromptLayout.textBase, ceil(measured) + 4))
        if isExpanded {
            pillTextHeight = textHeight
            layoutProgress(animated: false)
            return
        }
        let height = promptHeight(textHeight: textHeight)
        if abs(panel.frame.height - height) > 0.5 {
            var frame = panel.frame
            frame.size.height = height
            panel.setFrame(frame, display: true, animate: false)
            rootView.frame = NSRect(x: 0, y: 0, width: frame.width, height: height)
        }
        layoutPrompt(textHeight: textHeight)
    }

    func controlTextDidChange(_ obj: Notification) {
        fitPromptHeight()
        updateSendButton()
        if !isExpanded {
            mascot?.typedLength = textField.stringValue.count
            mascot?.mood = textField.stringValue.isEmpty ? .idle : .typing
        }
        let current = textField.stringValue
        if current.hasPrefix("/") && !current.contains("@") && !current.contains("\n") {
            showSlashPanel(current)
        } else if let atIndex = current.lastIndex(of: "@") {
            let afterAt = String(current[current.index(after: atIndex)...])
            showContextPanel(query: afterAt)
        } else {
            hideContextPanel()
        }
    }

    @objc func onStopClicked() {
        isWorking = false
        mascot?.mood = .stopped
        print("{\"event\":\"stop\"}")
        fflush(stdout)
        setStatus("Stopped", color: Theme.warning)
        appendEntry(.note, "Stopped.")
    }

    @objc func onCancelClicked() {
        print("{\"event\":\"cancel\"}")
        fflush(stdout)
        usleep(50000)
        exit(0)
    }

    /// Sends what is typed (Return, or the send button) and starts or continues the task. False when there was nothing to send.
    func submitPrompt() -> Bool {
        let text = textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        textField.stringValue = ""
        var dict: [String: Any] = ["event": "submit", "query": text, "app": targetApp]
        if !hudModels.isEmpty { dict["model"] = modelKey }
        if !targetWindowTitle.isEmpty {
            dict["windowTitle"] = targetWindowTitle
        }
        if !selectedAttachments.isEmpty {
            dict["attachments"] = selectedAttachments
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return false }
        print(json)
        fflush(stdout)
        selectedAttachments = []
        updateChipsDisplay()
        updateSendButton()
        if !isExpanded {
            transitionToProgress(query: text)
        } else {
            answerText = ""
            appendEntry(.goal, text)
            isWorking = true
            mascot?.mood = .working
            setStatus("Starting", color: Theme.secondary)
            setFollowUp(visible: false)
        }
        return true
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if contextPanel?.isVisible == true {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) || commandSelector == #selector(NSResponder.insertTab(_:)) {
                let sel = contextTableView?.selectedRow ?? 0
                if sel >= 0 && sel < filteredContextItems.count {
                    attachItem(filteredContextItems[sel])
                    return true
                }
            } else if commandSelector == #selector(NSResponder.moveDown(_:)) {
                if let tv = contextTableView {
                    let next = min(tv.selectedRow + 1, filteredContextItems.count - 1)
                    if next >= 0 {
                        tv.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
                        tv.scrollRowToVisible(next)
                    }
                }
                return true
            } else if commandSelector == #selector(NSResponder.moveUp(_:)) {
                if let tv = contextTableView {
                    let prev = max(tv.selectedRow - 1, 0)
                    tv.selectRowIndexes(IndexSet(integer: prev), byExtendingSelection: false)
                    tv.scrollRowToVisible(prev)
                }
                return true
            } else if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
                hideContextPanel()
                return true
            }
        }

        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            _ = submitPrompt()
            return true
        } else if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            if isExpanded && isWorking {
                onStopClicked()
            } else {
                onCancelClicked()
            }
            return true
        }
        return false
    }

    // MARK: - Progress feed

    func paragraphStyle(before: CGFloat = 0, after: CGFloat = 0, lineSpacing: CGFloat = 2, first: CGFloat = 0, head: CGFloat = 0, tab: CGFloat? = nil) -> NSMutableParagraphStyle {
        let ps = NSMutableParagraphStyle()
        ps.paragraphSpacingBefore = before
        ps.paragraphSpacing = after
        ps.lineSpacing = lineSpacing
        ps.firstLineHeadIndent = first
        ps.headIndent = head
        if let t = tab { ps.tabStops = [NSTextTab(textAlignment: .left, location: t, options: [:])] }
        return ps
    }

    /// Plain text as paragraphs: blank lines become a gap, bullets and numbers get a hanging indent so wrapped lines line up.
    func body(_ text: String, font: NSFont, color: NSColor, lineSpacing: CGFloat, after: CGFloat) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        let lines = text.components(separatedBy: "\n")
        for (n, raw) in lines.enumerated() {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            let isLast = n == lines.count - 1
            if trimmed.isEmpty {
                if !out.string.isEmpty && !isLast {
                    out.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 6), .paragraphStyle: paragraphStyle()]))
                }
                continue
            }
            let leading = raw.prefix(while: { $0 == " " }).count
            let indent = CGFloat(min(leading / 2, 4)) * 18
            var head = indent
            if trimmed.hasPrefix("• ") {
                head = indent + 15
            } else if trimmed.range(of: "^[0-9]{1,2}[.)] ", options: .regularExpression) != nil {
                head = indent + 22
            }
            let spacing = isLast ? after : 4
            out.append(NSAttributedString(string: trimmed + "\n", attributes: [
                .font: font,
                .foregroundColor: color,
                .paragraphStyle: paragraphStyle(after: spacing, lineSpacing: lineSpacing, first: indent, head: head)
            ]))
        }
        return out
    }

    /// Adds one card for what just happened: your request, a step, a problem, or the final answer.
    func appendEntry(_ kind: EntryKind, _ rawText: String) {
        guard let feed = feed else { return }
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        let width = PromptLayout.pillWidth
        switch kind {
        case .goal:
            let card = ActivityCard(style: .request, title: text, body: NSAttributedString(string: "Starting", attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: Theme.secondary]), width: width)
            card.onClose = { [weak self] in self?.onCancelClicked() }
            card.onStop = { [weak self] in self?.onStopClicked() }
            card.onReturn = { [weak self] in self?.setFollowUp(visible: true) }
            // the older request keeps its words but gives up the buttons
            requestCard?.setLatest(false)
            requestCard?.setWorking(false)
            requestCard = card
            card.setLatest(true)
            card.setStatus("Starting", color: Theme.secondary)
            card.setWorking(isWorking)
            feed.append(card)
        case .step:
            mascot?.noticeAction(text)
            feed.append(ActivityCard(style: .step, title: text, body: nil, width: width, inProgress: true))
        case .note:
            feed.append(ActivityCard(style: .note, title: text, body: nil, width: width))
        case .attention:
            feed.append(ActivityCard(style: .attention, title: text, body: nil, width: width))
        case .error:
            feed.append(ActivityCard(style: .error, title: text, body: nil, width: width))
        case .answer:
            let answer = body(text, font: NSFont.systemFont(ofSize: 13.5, weight: .regular), color: NSColor(white: 0.80, alpha: 1), lineSpacing: 3, after: 0)
            if answer.length > 0, answer.string.hasSuffix("\n") { answer.deleteCharacters(in: NSRange(location: answer.length - 1, length: 1)) }
            if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
                let whole = NSRange(location: 0, length: answer.length)
                for match in detector.matches(in: answer.string, options: [], range: whole) {
                    // Only web and mail links are clickable: a file: path in the agent's text must never open or launch anything.
                    if let url = match.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                        answer.addAttribute(.link, value: url, range: match.range)
                    }
                }
            }
            answerText = text
            let card = ActivityCard(style: .answer, title: "Done", body: answer, width: width)
            card.onCopy = { [weak self] in self?.onCopyClicked() }
            answerCard = card
            feed.append(card, toTop: true)
        }
    }

    @objc func onCopyClicked() {
        guard !answerText.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(answerText, forType: .string)
        toolbar?.copyButton.glyph = .check
        toolbar?.copyButton.glyphColor = Theme.success
        answerCard?.flashCopied()
        copyResetWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.toolbar?.copyButton.glyph = .copy
            self?.toolbar?.copyButton.glyphColor = Theme.secondary
        }
        copyResetWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
    }

    @objc func onToolbarNew() { setFollowUp(visible: true) }

    @objc func onToolbarCollapse() {
        feedCollapsed.toggle()
        toolbar.collapseButton.glyph = feedCollapsed ? .chevronUp : .chevronDown
        feed.collapsed = feedCollapsed
    }

    /// "READING" from the helper's protocol becomes "Reading" on screen.
    func displayStatus(_ raw: String) -> String {
        let lower = raw.lowercased()
        return lower.prefix(1).uppercased() + lower.dropFirst()
    }

    // MARK: - Updates from the daemon

    func setupInputReader() {
        var pending = LineBuffer()
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            for line in pending.append(data) {
                guard let dict = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    self?.handleUpdate(dict)
                }
            }
        }
    }

    func handleUpdate(_ dict: [String: Any]) {
        if dict["event"] as? String == "context", let h = dict["hierarchy"] as? [String: Any] {
            loadHierarchy(h)
            return
        }

        if dict["event"] as? String == "history-list" {
            historyItems = dict["items"] as? [[String: Any]] ?? []
            historyRequested = false
            let current = textField?.stringValue ?? ""
            if current.lowercased().hasPrefix("/history ") { showSlashPanel(current) }
            return
        }
        if dict["event"] as? String == "resumed" {
            showResumed(dict)
            return
        }

        let status = (dict["status"] as? String)?.uppercased() ?? "WORKING"
        let text = dict["text"] as? String ?? ""
        let role = dict["role"] as? String

        if status == "COMPLETE" || status == "DONE" {
            isWorking = false
            mascot?.mood = .happy
            setStatus("Done", color: Theme.success)
            answerText = ""
            let finalText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            appendEntry(.answer, finalText.isEmpty ? "Task completed successfully." : finalText)
        } else if status == "STOPPED" || status == "CANCELLED" {
            if isWorking {
                appendEntry(.note, text.isEmpty ? "Stopped." : text)
            }
            isWorking = false
            mascot?.mood = .stopped
            setStatus("Stopped", color: Theme.warning)
        } else if status == "FAILED" {
            // The task is over: stop the dots.
            isWorking = false
            mascot?.mood = .error
            setStatus("Failed", color: Theme.danger)
            appendEntry(.error, text.isEmpty ? "The task failed." : text)
        } else if status == "ERROR" {
            appendEntry(.error, text.isEmpty ? "Something went wrong." : text)
        } else if text.isEmpty && !isWorking {
            // A status-word-only update that arrives after the task ended must not bring the dots back.
            return
        } else {
            isWorking = true
            mascot?.mood = .working
            setStatus(displayStatus(status), color: Theme.secondary)
            if !text.isEmpty {
                appendEntry(role == "ATTENTION" || role == "PROBLEM" ? .attention : .step, text)
            }
        }
    }

    // MARK: - Progress view: the mascot, a small toolbar and a stack of cards (no box)

    /// The window follows what it shows, growing downward so the mascot stays where it was.
    func resizePanel(toHeight height: CGFloat) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        var frame = panel.frame
        guard abs(frame.height - height) > 0.5 else { return }
        let top = frame.maxY
        frame.size.height = height
        frame.origin.y = max(screen.visibleFrame.minY + 8, top - height)
        panel.setFrame(frame, display: true, animate: false)
        progressRoot?.frame = NSRect(x: 0, y: 0, width: frame.width, height: height)
    }

    /// Everything measured from the top: mascot, toolbar, cards, and (when asked for) the follow-up pill.
    func layoutProgress(animated: Bool) {
        guard isExpanded, let root = progressRoot, feed != nil, toolbar != nil else { return }
        let width = root.bounds.width
        let side = PromptLayout.side
        let pillW = PromptLayout.pillWidth
        var y = PromptLayout.topInset
        let mascotH = PromptLayout.mascotHeight
        if let m = mascot {
            let w = (mascotH * MascotView.aspect).rounded()
            m.frame = NSRect(x: ((width - w) / 2).rounded(), y: y, width: w, height: mascotH)
        }
        y += mascotH + 4
        let barFrame = NSRect(x: ((width - ToolbarView.size.width) / 2).rounded(), y: y, width: ToolbarView.size.width, height: ToolbarView.size.height)
        y += ToolbarView.size.height + 10
        // as many cards as the screen has room for (keeping room for the follow-up pill), so an answer can be read whole
        if let screen = panel.screen ?? NSScreen.main {
            let reserved = y + 12 + PromptLayout.pillMinHeight + 12
            let room = panel.frame.maxY - screen.visibleFrame.minY - 16 - reserved
            feed.maxHeight = max(250, min(600, room))
        }
        let feedHeight = feed.visibleHeight
        let feedFrame = NSRect(x: side - ActivityCard.room, y: y, width: pillW + ActivityCard.room * 2, height: feedHeight)
        y += feedHeight
        var pillFrame = pillView.frame
        var glyphFrame = modelGlyph?.frame ?? .zero
        if pillVisible {
            let pillH = pillHeight(textHeight: pillTextHeight)
            if feedHeight > 0 { y += 2 }
            pillFrame = NSRect(x: side, y: y, width: pillW, height: pillH)
            glyphFrame = NSRect(x: side + pillW + PromptLayout.modelGap, y: y + pillH - PromptLayout.pillMinHeight, width: PromptLayout.pillMinHeight, height: PromptLayout.pillMinHeight)
            y += pillH
            layoutPillContents(textHeight: pillTextHeight)
        }
        y += 12
        resizePanel(toHeight: y)
        let place: () -> Void = {
            if animated && !self.pillView.isHidden {
                self.pillView.animator().frame = pillFrame
                self.modelGlyph?.animator().frame = glyphFrame
            } else {
                self.pillView.frame = pillFrame
                self.modelGlyph?.frame = glyphFrame
            }
            if animated {
                self.toolbar.animator().frame = barFrame
                self.feed.animator().frame = feedFrame
            } else {
                self.toolbar.frame = barFrame
                self.feed.frame = feedFrame
            }
        }
        if animated { hudAnimate(0.28, place) } else { place() }
    }

    /// Brings the follow-up pill in (or sends it away). A request sent from it sends it away again.
    func setFollowUp(visible: Bool, focus: Bool = true) {
        guard isExpanded else { return }
        pillVisible = visible
        if visible {
            pillView.alphaValue = 0
            modelGlyph?.alphaValue = 0
            pillView.isHidden = false
            modelGlyph?.isHidden = false
        }
        layoutProgress(animated: false)
        hudAnimate(0.26) {
            pillView.animator().alphaValue = visible ? 1 : 0
            modelGlyph?.animator().alphaValue = visible ? 1 : 0
        }
        if !visible {
            let hide = { [weak self] in
                guard let self = self, !self.pillVisible else { return }
                self.pillView.isHidden = true
                self.modelGlyph?.isHidden = true
            }
            if hudAnimated { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: hide) } else { hide() }
        }
        if visible && focus { panel.makeFirstResponder(textField) }
    }

    /// A past chat was picked: show its messages as cards and wait for the next one, which continues it.
    func showResumed(_ dict: [String: Any]) {
        let turns = dict["turns"] as? [[String: Any]] ?? []
        if isExpanded {
            isWorking = false
            feed.reset()
            requestCard = nil
            answerCard = nil
            answerText = ""
        } else {
            transitionToProgress(query: nil)
        }
        for turn in turns {
            appendEntry(.goal, turn["goal"] as? String ?? "")
            isWorking = false
            setStatus("Done", color: Theme.success)
            let answer = (turn["answer"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !answer.isEmpty { appendEntry(.answer, answer) }
        }
        mascot?.mood = .happy
        setFollowUp(visible: true)
        feed.scrollToEnd()
    }

    func transitionToProgress(query: String?) {
        isExpanded = true
        isWorking = query != nil
        hideContextPanel()
        let width = PromptLayout.windowWidth(hasModels: modelGlyph != nil)
        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: width, height: panel.frame.height))
        root.wantsLayer = true
        progressRoot = root
        panel.contentView = root
        rootView = root
        // the mascot, the pill and the model button carry over from the prompt
        for view in [mascot, pillView, modelGlyph] as [NSView?] {
            if let v = view {
                v.removeFromSuperview()
                root.addSubview(v)
            }
        }

        feed = ActivityFeed(cardWidth: PromptLayout.pillWidth)
        feed.onChange = { [weak self] in self?.layoutProgress(animated: true) }
        toolbar = ToolbarView(frame: .zero)
        toolbar.newButton.target = self
        toolbar.newButton.action = #selector(onToolbarNew)
        toolbar.copyButton.target = self
        toolbar.copyButton.action = #selector(onCopyClicked)
        toolbar.collapseButton.target = self
        toolbar.collapseButton.action = #selector(onToolbarCollapse)
        root.addSubview(feed)
        root.addSubview(toolbar)

        // the pill steps aside while the task runs
        pillVisible = false
        pillView.isHidden = true
        modelGlyph?.isHidden = true
        pillTextHeight = PromptLayout.textBase
        setPlaceholder(Copy.followUp, size: 15)
        updateSendButton()

        toolbar.alphaValue = 0
        layoutProgress(animated: false)
        if let first = query { appendEntry(.goal, first) }
        updateWorkingChrome()
        hudAnimate(0.3) { toolbar.animator().alphaValue = 1 }
    }
}

let args = CommandLine.arguments
var mode = "prompt"
var appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Desktop"
var windowTitle = ""
var initialContext: [String: Any]? = nil
/// The models the prompt window offers ([{key,label}]) and the one selected; empty when the daemon offered none.
var hudModels: [[String: String]] = []
var hudModelKey = ""

for arg in args {
    if arg == "listen" {
        mode = "listen"
    } else if arg.starts(with: "--app=") {
        appName = String(arg.dropFirst(6))
    } else if arg.starts(with: "--window-title=") {
        windowTitle = String(arg.dropFirst(15))
    } else if arg.starts(with: "--models=") {
        if let data = String(arg.dropFirst(9)).data(using: .utf8),
           let list = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] {
            hudModels = list.filter { $0["key"] != nil && $0["label"] != nil }
        }
    } else if arg.starts(with: "--model=") {
        hudModelKey = String(arg.dropFirst(8))
    } else if arg.starts(with: "--context=") {
        let jsonStr = String(arg.dropFirst(10))
        if let data = jsonStr.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            initialContext = obj
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

var lastHotkeyTime: TimeInterval = 0

func emitHotkey() {
    let now = Date().timeIntervalSince1970
    if now - lastHotkeyTime < 0.5 { return }
    lastHotkeyTime = now
    let frontApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Desktop"
    var winTitle = ""
    if let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        for w in windowList {
            let layer = w[kCGWindowLayer as String] as? Int ?? -1
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            let title = w[kCGWindowName as String] as? String ?? ""
            if layer == 0 && !title.isEmpty && (owner == frontApp || frontApp == "Desktop") {
                winTitle = title
                break
            }
        }
    }
    let escapedTitle = winTitle.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    print("{\"event\":\"hotkey\",\"app\":\"\(frontApp)\",\"windowTitle\":\"\(escapedTitle)\"}")
    fflush(stdout)
}

if mode == "listen" {
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    var hotKeyRef: EventHotKeyRef?
    let hotKeyID = EventHotKeyID(signature: OSType(0x5248444B), id: 1)

    InstallEventHandler(
        GetApplicationEventTarget(),
        { (_, _, _) -> OSStatus in
            emitHotkey()
            return noErr
        },
        1,
        &eventType,
        nil,
        nil
    )

    let registered = RegisterEventHotKey(
        UInt32(kVK_Space),
        UInt32(cmdKey | shiftKey),
        hotKeyID,
        GetApplicationEventTarget(),
        0,
        &hotKeyRef
    )
    // Say whether the shortcut was really ours (another app, such as Raycast or Alfred, may already hold it)
    print(registered == noErr ? "{\"event\":\"hotkey-ready\",\"keys\":\"Shift+Cmd+Space\"}" : "{\"event\":\"hotkey-failed\"}")
    fflush(stdout)

    NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 49 && flags.contains(.command) && flags.contains(.shift) {
            emitHotkey()
        }
    }
    app.run()
} else {
    let delegate = AppDelegate(targetApp: appName, initialContext: initialContext, targetWindowTitle: windowTitle)
    app.delegate = delegate
    app.run()
}

/// Keeps the bytes of a line that arrives in pieces (a long answer is bigger than one pipe read) until its newline comes.
struct LineBuffer {
    private var held = Data()

    mutating func append(_ chunk: Data) -> [Data] {
        held.append(chunk)
        var lines: [Data] = []
        while let newline = held.firstIndex(of: 0x0A) {
            let line = held.subdata(in: held.startIndex..<newline)
            held.removeSubrange(held.startIndex...newline)
            if !line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { lines.append(line) }
        }
        return lines
    }
}
