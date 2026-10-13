import Cocoa
import ApplicationServices
import Foundation

// rh-ax: a small long-running helper that reads (and later drives) the accessibility tree of native apps.
// It talks JSON lines on stdin/stdout: one request per line with an "id", one reply per request echoing it.
// The Node side (ax-helper.ts) owns its lifecycle; it exits by itself when stdin closes.

let helperVersion = 1

// MARK: - Output

let outLock = NSLock()

func send(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    outLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    outLock.unlock()
}

func reply(_ id: Any?, _ fields: [String: Any]) {
    var out = fields
    if let id = id { out["id"] = id }
    send(out)
}

func fail(_ id: Any?, _ code: String, _ message: String) {
    reply(id, ["ok": false, "error": code, "message": message])
}

// MARK: - Element handles

/// The same element keeps the same handle for as long as the helper lives, so ids the model saw stay valid.
final class HandleTable {
    private var byHandle: [Int: AXUIElement] = [:]
    private var buckets: [CFHashCode: [Int]] = [:]
    private var next = 1
    private let limit = 60_000
    /// Changes whenever the table is emptied, and differs on every launch: ids from an earlier epoch are refused, never reinterpreted.
    private(set) var epoch = Int.random(in: 1...1_000_000_000)
    private var signatures: [Int: String] = [:]

    func handle(for element: AXUIElement) -> Int {
        let hash = CFHash(element)
        if let list = buckets[hash] {
            for h in list {
                if let existing = byHandle[h], CFEqual(existing, element) { return h }
            }
        }
        if byHandle.count >= limit {
            // Forget everything: old ids then answer "unknown", they never point at something else because `next` keeps counting.
            byHandle = [:]
            buckets = [:]
            signatures = [:]
            epoch = Int.random(in: 1...1_000_000_000)
        }
        let h = next
        next += 1
        byHandle[h] = element
        buckets[hash, default: []].append(h)
        return h
    }

    func element(_ handle: Int) -> AXUIElement? {
        return byHandle[handle]
    }

    /// What the element looked like (role and name) when the model was shown it.
    func remember(_ handle: Int, signature: String) { signatures[handle] = signature }
    func signature(_ handle: Int) -> String? { return signatures[handle] }
}

let handles = HandleTable()

// MARK: - Attribute helpers

/// Reads several attributes with one round trip to the app. Failed ones come back as nil.
func fetch(_ element: AXUIElement, _ names: [String]) -> [AnyObject?] {
    var values: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard err == .success, let array = values as? [AnyObject] else {
        return Array(repeating: nil, count: names.count)
    }
    return array.map { value -> AnyObject? in
        if value is NSNull { return nil }
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { return nil }
        return value
    }
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func text(_ value: AnyObject?) -> String? {
    if let s = value as? String { return s }
    if let n = value as? NSNumber { return n.stringValue }
    return nil
}

func flag(_ value: AnyObject?) -> Bool? {
    guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
    return n.boolValue
}

func point(_ value: AnyObject?) -> CGPoint? {
    guard let v = value, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ value: AnyObject?) -> CGSize? {
    guard let v = value, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func clip(_ s: String, _ max: Int) -> String {
    let one = s.replacingOccurrences(of: "\r", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    if one.count <= max { return one }
    return String(one.prefix(max - 1)) + "…"
}

let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]

/// Whether an element is a password field. Fails closed: when the role or subrole cannot be read, it counts as one.
func classifySecure(_ element: AXUIElement) -> Bool {
    var role: AnyObject?
    let roleErr = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
    if roleErr != .success { return true }
    let r = text(role) ?? ""
    if r == "AXSecureTextField" { return true }
    if !textRoles.contains(r) { return false }
    var sub: AnyObject?
    let subErr = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &sub)
    if subErr == .success { return text(sub) == "AXSecureTextField" }
    return !(subErr == .noValue || subErr == .attributeUnsupported)
}

// MARK: - Which apps and windows

func findApp(_ query: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    if query.isEmpty { return NSWorkspace.shared.frontmostApplication }
    let matched = apps.filter {
        ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.bundleIdentifier ?? "").caseInsensitiveCompare(query) == .orderedSame ||
        ($0.localizedName ?? "").localizedCaseInsensitiveContains(query) ||
        ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains(query)
    }
    return matched.first(where: { $0.isActive }) ?? matched.first
}

/// Chromium-based apps and Electron apps only build their accessibility tree when asked.
func needsManualAccessibility(_ app: NSRunningApplication) -> Bool {
    let bundle = (app.bundleIdentifier ?? "").lowercased()
    for prefix in ["com.google.chrome", "org.chromium", "com.microsoft.edgemac", "com.brave.browser", "company.thebrowser", "com.operasoftware", "com.vivaldi"] where bundle.hasPrefix(prefix) {
        return true
    }
    if let url = app.bundleURL {
        let frameworks = url.appendingPathComponent("Contents/Frameworks")
        for name in ["Electron Framework.framework", "Chromium Embedded Framework.framework"] {
            if FileManager.default.fileExists(atPath: frameworks.appendingPathComponent(name).path) { return true }
        }
    }
    return false
}

var manualAccessibilitySet = Set<pid_t>()

/// Whether an element is something you can read as a window (an app that has none can report itself as its focused "window").
func isWindowLike(_ element: AXUIElement) -> Bool {
    let role = text(attribute(element, kAXRoleAttribute)) ?? ""
    return role == "AXWindow" || role == "AXSheet" || role == "AXDrawer"
}

func chooseWindow(_ appElement: AXUIElement, title: String) -> AXUIElement? {
    let windows = ((attribute(appElement, kAXWindowsAttribute) as? [AXUIElement]) ?? []).filter { isWindowLike($0) }
    if !title.isEmpty {
        for w in windows {
            let t = text(attribute(w, kAXTitleAttribute)) ?? ""
            if t.localizedCaseInsensitiveContains(title) || title.localizedCaseInsensitiveContains(t) { return w }
        }
    }
    if let focused = attribute(appElement, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(), isWindowLike(focused as! AXUIElement) {
        return (focused as! AXUIElement)
    }
    if let main = attribute(appElement, kAXMainWindowAttribute), CFGetTypeID(main) == AXUIElementGetTypeID(), isWindowLike(main as! AXUIElement) {
        return (main as! AXUIElement)
    }
    for w in windows {
        let sub = text(attribute(w, kAXSubroleAttribute)) ?? ""
        let t = text(attribute(w, kAXTitleAttribute)) ?? ""
        if sub == "AXStandardWindow" && !t.isEmpty { return w }
    }
    return windows.first
}

// MARK: - Snapshot

let snapshotAttributes: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXHelpAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXPositionAttribute,
    kAXSizeAttribute, kAXPlaceholderValueAttribute, "AXExpanded", "AXDisclosing",
]

/// Roles whose children are never worth a second round trip.
let leafRoles: Set<String> = [
    "AXStaticText", "AXImage", "AXScrollBar", "AXValueIndicator", "AXSplitter", "AXBusyIndicator", "AXProgressIndicator", "AXLevelIndicator",
]

/// Roles that can have something to press, open or increment.
let actionRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXLink",
    "AXDisclosureTriangle", "AXTab", "AXTabButton", "AXSwitch", "AXToggle", "AXSlider", "AXIncrementor", "AXStepper",
    "AXRow", "AXCell", "AXComboBox", "AXColorWell", "AXDateField", "AXTextField", "AXTextArea", "AXSearchField",
]

let noiseActions: Set<String> = ["AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"]

/// Roles whose rows far outside the view exist in the tree: ask only for the visible ones.
let listRoles: Set<String> = ["AXTable", "AXOutline", "AXList", "AXBrowser"]

/// Roles whose own frame is the visible part of what they contain.
let viewportRoles: Set<String> = ["AXScrollArea"]

final class Walker {
    var nodes: [[String: Any]] = []
    var truncated = false
    var timedOut = false
    /// Accessibility trees can contain loops and repeats (a row listing its table as a child): each element is read once.
    var seen = Set<Int>()
    let maxNodes: Int
    let deadline: UInt64

    init(maxNodes: Int, budgetMs: Int) {
        self.maxNodes = maxNodes
        self.deadline = DispatchTime.now().uptimeNanoseconds + UInt64(max(50, budgetMs)) * 1_000_000
    }

    /// The children worth visiting, and how many more exist that are known to be out of view.
    func children(of element: AXUIElement, role: String) -> ([AXUIElement], Int) {
        if listRoles.contains(role) {
            for (name, total) in [("AXVisibleRows", "AXRows"), ("AXVisibleChildren", kAXChildrenAttribute)] {
                if let list = attribute(element, name) as? [AXUIElement] {
                    var count: CFIndex = 0
                    if AXUIElementGetAttributeValueCount(element, total as CFString, &count) == .success, count > list.count {
                        return (list, count - list.count)
                    }
                    return (list, 0)
                }
            }
        }
        return ((attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [], 0)
    }

    func visit(_ element: AXUIElement, parent: Int, clip viewport: CGRect?, owner: Int?, depth: Int) {
        if truncated || timedOut || depth > 48 { return }
        if nodes.count >= maxNodes { truncated = true; return }
        if DispatchTime.now().uptimeNanoseconds > deadline { timedOut = true; return }

        let id = handles.handle(for: element)
        if seen.contains(id) { return }
        seen.insert(id)

        let v = fetch(element, snapshotAttributes)
        let role = text(v[0]) ?? ""
        let sub = text(v[1])
        let title = text(v[2]) ?? ""
        let desc = text(v[3]) ?? ""
        let value = text(v[4])
        let help = text(v[5])
        let enabled = flag(v[6])
        let focused = flag(v[7])
        let selected = flag(v[8])
        let origin = point(v[9])
        let extent = size(v[10])
        let placeholder = text(v[11])
        let expanded = flag(v[12]) ?? flag(v[13])

        var frame: CGRect? = nil
        if let o = origin, let s = extent, o.x.isFinite, o.y.isFinite, s.width.isFinite, s.height.isFinite {
            frame = CGRect(origin: o, size: s)
        }

        // Things scrolled out of view, or outside their window, exist in the tree but are not on screen.
        if let c = viewport, let f = frame, f.width > 0, f.height > 0, !c.intersects(f) {
            if let o = owner { nodes[o]["off"] = ((nodes[o]["off"] as? Int) ?? 0) + 1 }
            return
        }

        let label = title.isEmpty ? desc : title
        let secure = (sub == "AXSecureTextField") || role == "AXSecureTextField" || role.isEmpty
            || (textRoles.contains(role) && !(value ?? "").isEmpty && classifySecure(element))
        let hasText = !label.isEmpty || !(value ?? "").isEmpty
        let visible = (frame?.width ?? 0) >= 1 && (frame?.height ?? 0) >= 1
        var myIndex: Int? = nil

        if visible || hasText {
            var node: [String: Any] = ["id": id, "parent": parent, "role": role]
            if let s = sub, !s.isEmpty { node["sub"] = s }
            if !label.isEmpty { node["label"] = clip(label, 200) }
            if !secure, let val = value, !val.isEmpty { node["value"] = clip(val, 300) }
            if let h = help, !h.isEmpty { node["help"] = clip(h, 120) }
            if let p = placeholder, !p.isEmpty { node["placeholder"] = clip(p, 80) }
            if enabled == false { node["enabled"] = false }
            if focused == true { node["focused"] = true }
            if selected == true { node["selected"] = true }
            if let e = expanded { node["expanded"] = e }
            if let f = frame {
                node["x"] = Int(f.origin.x.rounded())
                node["y"] = Int(f.origin.y.rounded())
                node["width"] = Int(f.size.width.rounded())
                node["height"] = Int(f.size.height.rounded())
            }
            if actionRoles.contains(role) {
                var names: CFArray?
                if AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] {
                    let kept = list.filter { !noiseActions.contains($0) }
                    if !kept.isEmpty { node["actions"] = kept }
                }
            }
            if viewportRoles.contains(role), let bar = attribute(element, "AXVerticalScrollBar"), CFGetTypeID(bar) == AXUIElementGetTypeID() {
                if let n = attribute(bar as! AXUIElement, kAXValueAttribute) as? NSNumber { node["scroll"] = n.doubleValue }
            }
            handles.remember(id, signature: "\(role)|\(clip(label, 200))")
            nodes.append(node)
            myIndex = nodes.count - 1
        }

        if leafRoles.contains(role) { return }

        var childClip = viewport
        var childOwner = owner
        if viewportRoles.contains(role), let f = frame, let mine = myIndex {
            childClip = viewport.map { $0.intersection(f) } ?? f
            childOwner = mine
        }
        let parentForChildren = (myIndex != nil) ? id : parent
        let (kids, leftOut) = children(of: element, role: role)
        if leftOut > 0, let o = childOwner { nodes[o]["off"] = ((nodes[o]["off"] as? Int) ?? 0) + leftOut }
        for child in kids {
            visit(child, parent: parentForChildren, clip: childClip, owner: childOwner, depth: depth + 1)
            if truncated || timedOut { break }
        }
    }
}

func snapshot(_ id: Any?, _ request: [String: Any]) {
    guard AXIsProcessTrusted() else {
        fail(id, "not_trusted", "Accessibility permission is not granted for the process that started this helper.")
        return
    }
    let started = DispatchTime.now().uptimeNanoseconds
    let query = (request["app"] as? String) ?? ""
    guard let app = findApp(query) else {
        fail(id, "no_app", query.isEmpty ? "No frontmost app." : "No running app matches \"\(query)\".")
        return
    }
    let maxNodes = max(10, min(5000, (request["maxNodes"] as? Int) ?? 600))
    let budgetMs = max(100, min(30_000, (request["budgetMs"] as? Int) ?? 3000))
    let windowTitle = (request["window"] as? String) ?? ""

    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    if needsManualAccessibility(app), !manualAccessibilitySet.contains(app.processIdentifier) {
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        manualAccessibilitySet.insert(app.processIdentifier)
    }

    func walkOnce() -> (Walker, AXUIElement?, [String: Any]?) {
        let walker = Walker(maxNodes: maxNodes, budgetMs: budgetMs)
        let window = chooseWindow(appElement, title: windowTitle)
        var windowInfo: [String: Any]? = nil
        if let w = window {
            let v = fetch(w, [kAXTitleAttribute, kAXPositionAttribute, kAXSizeAttribute])
            var info: [String: Any] = ["title": clip(text(v[0]) ?? "", 200)]
            var frame: CGRect? = nil
            if let o = point(v[1]), let s = size(v[2]) {
                frame = CGRect(origin: o, size: s)
                info["x"] = Int(o.x.rounded()); info["y"] = Int(o.y.rounded())
                info["width"] = Int(s.width.rounded()); info["height"] = Int(s.height.rounded())
            }
            windowInfo = info
            // Children of the window are limited to the window's own area.
            walker.visit(w, parent: 0, clip: frame, owner: nil, depth: 0)
        }
        // Open menus and popovers hang off the app, not the window.
        for extra in (attribute(appElement, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
            if walker.truncated || walker.timedOut { break }
            let role = text(attribute(extra, kAXRoleAttribute)) ?? ""
            if role == "AXMenu" || role == "AXPopover" || role == "AXDrawer" {
                let f = fetch(extra, [kAXPositionAttribute, kAXSizeAttribute])
                var frame: CGRect? = nil
                if let o = point(f[0]), let s = size(f[1]) { frame = CGRect(origin: o, size: s) }
                walker.visit(extra, parent: 0, clip: frame, owner: nil, depth: 0)
            }
        }
        return (walker, window, windowInfo)
    }

    var (walker, window, windowInfo) = walkOnce()

    // Some older apps only build their tree when "enhanced UI" is on. Ask for it only when the tree came back nearly empty,
    // and put the previous setting back afterwards (it can disturb window managers and animations).
    var enhancedRetried = false
    if walker.nodes.count < 6 && !walker.timedOut {
        let previous = flag(attribute(appElement, "AXEnhancedUserInterface")) ?? false
        if !previous {
            AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            usleep(120_000)
            let again = walkOnce()
            if again.0.nodes.count > walker.nodes.count { (walker, window, windowInfo) = again }
            AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
            enhancedRetried = true
        }
    }

    var out: [String: Any] = [
        "ok": true,
        "app": ["name": app.localizedName ?? "", "pid": Int(app.processIdentifier), "bundle": app.bundleIdentifier ?? ""],
        "nodes": walker.nodes,
        "epoch": handles.epoch,
        "truncated": walker.truncated,
        "timedOut": walker.timedOut,
        "enhancedRetry": enhancedRetried,
        "elapsedMs": Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000),
    ]
    if let info = windowInfo { out["window"] = info }
    if window == nil { out["noWindow"] = true }
    reply(id, out)
}

// MARK: - Acting on elements

/// Synthetic input comes from a private event source with no modifiers, so keys the person happens to be holding
/// (Command, Option, Control) cannot turn a click or a Return into something else.
let inputSource = CGEventSource(stateID: .privateState)

/// The element for a handle, or a reply saying why not. An element that left the screen, was replaced by another,
/// or belongs to an earlier run of this helper answers "stale".
func liveElement(_ id: Any?, _ request: [String: Any], key: String = "h", epochKey: String = "epoch") -> AXUIElement? {
    guard let h = request[key] as? Int else {
        fail(id, "bad_request", "Missing element id.")
        return nil
    }
    if let epoch = request[epochKey] as? Int, epoch != handles.epoch {
        fail(id, "stale", "The accessibility helper was restarted: take a new snapshot.")
        return nil
    }
    guard let element = handles.element(h) else {
        fail(id, "stale", "Unknown element id \(h): take a new snapshot.")
        return nil
    }
    let v = fetch(element, [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
    guard let role = text(v[0]) else {
        fail(id, "stale", "That element is no longer on screen: take a new snapshot.")
        return nil
    }
    if let seen = handles.signature(h) {
        let title = text(v[1]) ?? ""
        let desc = text(v[2]) ?? ""
        let now = "\(role)|\(clip(title.isEmpty ? desc : title, 200))"
        if now != seen {
            fail(id, "stale", "That element changed since the snapshot: take a new snapshot.")
            return nil
        }
    }
    return element
}

func frameOf(_ element: AXUIElement) -> CGRect? {
    let v = fetch(element, [kAXPositionAttribute, kAXSizeAttribute])
    guard let o = point(v[0]), let s = size(v[1]), s.width > 0, s.height > 0, o.x.isFinite, o.y.isFinite else { return nil }
    return CGRect(origin: o, size: s)
}

/// The part of an element that is actually on screen: its frame cut down to the scroll areas and window around it.
func visibleFrame(_ element: AXUIElement) -> CGRect? {
    guard var frame = frameOf(element) else { return nil }
    var current: AXUIElement = element
    for _ in 0..<16 {
        guard let parent = attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
        let p = parent as! AXUIElement
        let role = text(attribute(p, kAXRoleAttribute)) ?? ""
        if viewportRoles.contains(role) || role == "AXWindow" || role == "AXSheet" {
            if let f = frameOf(p) { frame = frame.intersection(f) }
            if frame.isNull || frame.width < 1 || frame.height < 1 { return nil }
        }
        current = p
    }
    return frame
}

func pidOf(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

/// Brings an app forward and says whether it really is in front.
func activate(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    if app.isActive { return true }
    if #available(macOS 14.0, *) {
        app.activate()
    } else {
        app.activate(options: [.activateIgnoringOtherApps])
    }
    for _ in 0..<20 {
        if app.isActive { return true }
        usleep(15_000)
    }
    // A background helper is not always allowed to take the front directly; asking the system to open the app
    // ("open -a") is the sanctioned way and brings its windows forward.
    if let url = app.bundleURL {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config, completionHandler: nil)
    }
    for _ in 0..<30 {
        if app.isActive { return true }
        usleep(15_000)
    }
    // Last resort, the way people script it.
    if let bundle = app.bundleIdentifier {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", "tell application id \"\(bundle)\" to activate"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        if (try? task.run()) != nil {
            let limit = Date().addingTimeInterval(3)
            while task.isRunning && Date() < limit { usleep(20_000) }
            if task.isRunning { task.terminate() }
        }
    }
    for _ in 0..<60 {
        if app.isActive { return true }
        usleep(15_000)
    }
    return app.isActive
}

func appName(_ pid: pid_t) -> String {
    return NSRunningApplication(processIdentifier: pid)?.localizedName ?? "another app"
}

func isAncestor(_ ancestor: AXUIElement, of element: AXUIElement) -> Bool {
    var current = element
    for _ in 0..<16 {
        if CFEqual(current, ancestor) { return true }
        guard let parent = attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
        current = parent as! AXUIElement
    }
    return false
}

/// Nil when the topmost thing at the point is the element, something inside it, or something it sits inside; otherwise why not.
/// A hit test that cannot answer counts as covered: input is never sent blind.
func coverProblem(_ element: AXUIElement, at p: CGPoint) -> String? {
    var hit: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit)
    guard err == .success, let top = hit else { return "Could not confirm that the element is uncovered." }
    if isAncestor(element, of: top) || isAncestor(top, of: element) { return nil }
    if let owner = pidOf(top), let mine = pidOf(element), owner != mine { return "\(appName(owner)) is on top of that element." }
    return "Something else is on top of that element."
}

/// The point to click for an element: the centre of its visible part, once the element is known to be uncovered.
func clickTarget(_ id: Any?, _ element: AXUIElement) -> CGPoint? {
    guard let visible = visibleFrame(element) else {
        fail(id, "no_frame", "This element is not visible on screen.")
        return nil
    }
    let target = CGPoint(x: visible.midX, y: visible.midY)
    if let pid = pidOf(element), !activate(pid) {
        fail(id, "not_active", "\(appName(pid)) could not be brought to the front.")
        return nil
    }
    // Bring the element's own window above the others of its app and of other apps.
    if let window = attribute(element, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
        _ = AXUIElementPerformAction(window as! AXUIElement, kAXRaiseAction as CFString)
        usleep(120_000)
    }
    if let problem = coverProblem(element, at: target) {
        fail(id, "covered", problem)
        return nil
    }
    return target
}

func perform(_ id: Any?, _ request: [String: Any]) {
    guard let element = liveElement(id, request) else { return }
    guard let action = request["action"] as? String, action.hasPrefix("AX") else {
        fail(id, "bad_request", "Missing action.")
        return
    }
    let err = AXUIElementPerformAction(element, action as CFString)
    switch err {
    case .success: reply(id, ["ok": true])
    case .actionUnsupported: fail(id, "unsupported", "This element does not support \(action).")
    case .invalidUIElement, .cannotComplete: fail(id, "stale", "That element is no longer on screen: take a new snapshot.")
    default: fail(id, "failed", "\(action) failed (code \(err.rawValue)).")
    }
}

func mouseEvent(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clickState: Int64, source: CGEventSource? = inputSource) -> CGEvent? {
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
    event?.setIntegerValueField(.mouseEventClickState, value: clickState)
    event?.flags = []
    return event
}

/// A real click, posted at the visible centre of the element without moving the cursor.
func click(_ id: Any?, _ request: [String: Any]) {
    guard request["h"] != nil else {
        fail(id, "bad_request", "Missing element id.")
        return
    }
    guard let element = liveElement(id, request), let target = clickTarget(id, element) else { return }
    let right = (request["button"] as? String) == "right"
    let count = max(1, min(3, (request["count"] as? Int) ?? 1))
    let button: CGMouseButton = right ? .right : .left
    let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
    for n in 1...count {
        mouseEvent(down, target, button, clickState: Int64(n))?.post(tap: .cghidEventTap)
        usleep(30_000)
        mouseEvent(up, target, button, clickState: Int64(n))?.post(tap: .cghidEventTap)
        usleep(60_000)
    }
    reply(id, ["ok": true, "x": Int(target.x.rounded()), "y": Int(target.y.rounded())])
}

func focus(_ id: Any?, _ request: [String: Any]) {
    guard let element = liveElement(id, request) else { return }
    if let pid = pidOf(element), !activate(pid) {
        fail(id, "not_active", "\(appName(pid)) could not be brought to the front.")
        return
    }
    if let window = attribute(element, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
        _ = AXUIElementPerformAction(window as! AXUIElement, kAXRaiseAction as CFString)
    }
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard flag(attribute(element, kAXFocusedAttribute)) == true else {
        fail(id, "focus_failed", "Could not put the cursor in this element. Click it first, then type without an index.")
        return
    }
    reply(id, ["ok": true, "focused": true])
}

func isSecureElement(_ element: AXUIElement) -> Bool {
    return classifySecure(element)
}

func setValue(_ id: Any?, _ request: [String: Any]) {
    guard let element = liveElement(id, request) else { return }
    guard let value = request["value"] as? String else {
        fail(id, "bad_request", "Missing value.")
        return
    }
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    if !settable.boolValue {
        fail(id, "not_settable", "The value of this element cannot be set directly.")
        return
    }
    let secure = isSecureElement(element)
    let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
    if err != .success {
        fail(id, "failed", "Setting the value failed (code \(err.rawValue)).")
        return
    }
    if secure {
        // What a password field holds is never read back, so it cannot be confirmed.
        reply(id, ["ok": true, "matches": true, "value": "", "secure": true])
        return
    }
    let after = text(attribute(element, kAXValueAttribute)) ?? ""
    reply(id, ["ok": true, "matches": after == value, "value": clip(after, 300), "secure": false])
}

/// Whether keys sent now would reach the element's app (and, when a handle is given, its field).
func keyboardProblem(_ request: [String: Any]) -> String? {
    guard let pid = request["pid"] as? Int else { return nil }
    guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier == pid_t(pid) else {
        return "The app is no longer in front. Take a new snapshot and try again."
    }
    if request["h"] != nil, request["h"] is Int {
        guard let element = handles.element(request["h"] as! Int) else { return "That element is no longer there. Take a new snapshot." }
        var focused: AnyObject?
        let err = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid_t(pid)), kAXFocusedUIElementAttribute as CFString, &focused)
        guard err == .success, let f = focused, CFGetTypeID(f) == AXUIElementGetTypeID(),
              isAncestor(element, of: f as! AXUIElement) || isAncestor(f as! AXUIElement, of: element) else {
            return "The cursor is not in that field any more. Take a new snapshot and try again."
        }
    }
    return nil
}

func postKey(_ code: CGKeyCode, command: Bool = false) {
    if let d = CGEvent(keyboardEventSource: inputSource, virtualKey: code, keyDown: true),
       let u = CGEvent(keyboardEventSource: inputSource, virtualKey: code, keyDown: false) {
        d.flags = command ? .maskCommand : []
        u.flags = command ? .maskCommand : []
        d.post(tap: .cghidEventTap)
        u.post(tap: .cghidEventTap)
    }
}

/// Keys for characters that are not text.
let specialKeys: [Character: CGKeyCode] = ["\n": 36, "\r": 36, "\t": 48]

func typeText(_ id: Any?, _ request: [String: Any]) {
    guard let content = request["text"] as? String else {
        fail(id, "bad_request", "Missing text.")
        return
    }
    if let epoch = request["epoch"] as? Int, epoch != handles.epoch {
        fail(id, "stale", "The accessibility helper was restarted: take a new snapshot.")
        return
    }
    if let problem = keyboardProblem(request) {
        fail(id, "wrong_target", problem)
        return
    }
    var pending: [UniChar] = []
    func flush() {
        guard !pending.isEmpty else { return }
        var units = pending
        if let d = CGEvent(keyboardEventSource: inputSource, virtualKey: 0, keyDown: true),
           let u = CGEvent(keyboardEventSource: inputSource, virtualKey: 0, keyDown: false) {
            d.flags = []
            u.flags = []
            d.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            u.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            d.post(tap: .cghidEventTap)
            u.post(tap: .cghidEventTap)
        }
        pending = []
        usleep(4_000)
    }
    var count = 0
    for ch in content {
        if let key = specialKeys[ch] {
            flush()
            postKey(key)
            usleep(6_000)
        } else {
            let units = Array(String(ch).utf16)
            // never split a character across two events
            if pending.count + units.count > 16 { flush() }
            pending.append(contentsOf: units)
        }
        count += 1
    }
    flush()
    reply(id, ["ok": true, "chars": count])
}

/// One key press (Return or select-all) with the same checks as typing.
func pressKey(_ id: Any?, _ request: [String: Any]) {
    guard let name = request["key"] as? String, name == "return" || name == "selectAll" else {
        fail(id, "bad_request", "Unknown key.")
        return
    }
    if let epoch = request["epoch"] as? Int, epoch != handles.epoch {
        fail(id, "stale", "The accessibility helper was restarted: take a new snapshot.")
        return
    }
    if let problem = keyboardProblem(request) {
        fail(id, "wrong_target", problem)
        return
    }
    if name == "return" { postKey(36) } else { postKey(0, command: true) }
    usleep(20_000)
    reply(id, ["ok": true])
}

/// The text shown by an element's descendants, for rows and cells whose text lives in children.
func descendantText(_ element: AXUIElement, budget: inout Int, depth: Int = 0) -> [String] {
    if depth > 5 || budget <= 0 { return [] }
    var out: [String] = []
    for child in (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
        budget -= 1
        if budget <= 0 { break }
        let v = fetch(child, [kAXRoleAttribute, kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
        let role = text(v[0]) ?? ""
        if textRoles.contains(role) { continue }
        if role == "AXStaticText" || role == "AXHeading" {
            if let t = text(v[1]) ?? text(v[2]) ?? text(v[3]), !t.isEmpty { out.append(t) }
        } else {
            out.append(contentsOf: descendantText(child, budget: &budget, depth: depth + 1))
        }
    }
    return out
}

func readText(_ id: Any?, _ request: [String: Any]) {
    guard let element = liveElement(id, request) else { return }
    if isSecureElement(element) {
        fail(id, "secure", "This is a password field; its contents are never read.")
        return
    }
    let maxChars = max(100, min(100_000, (request["max"] as? Int) ?? 20_000))
    let v = fetch(element, [kAXValueAttribute, kAXSelectedTextAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXNumberOfCharacters"])
    var content = text(v[0]) ?? ""
    if content.isEmpty { content = text(v[2]) ?? text(v[3]) ?? "" }
    if content.isEmpty {
        var budget = 200
        content = descendantText(element, budget: &budget).joined(separator: "\n")
    }
    let total = content.count
    var out: [String: Any] = ["ok": true, "length": (v[4] as? NSNumber)?.intValue ?? total, "truncated": total > maxChars]
    out["text"] = total > maxChars ? String(content.prefix(maxChars)) : content
    if let selected = text(v[1]), !selected.isEmpty { out["selected"] = clip(selected, 2000) }
    reply(id, out)
}

/// The vertical scroll position of the scroll area an element is in (or is), 0...1, when it has one.
func scrollPosition(_ element: AXUIElement) -> Double? {
    var current: AXUIElement? = element
    for _ in 0..<12 {
        guard let el = current else { return nil }
        if (text(attribute(el, kAXRoleAttribute)) ?? "") == "AXScrollArea",
           let bar = attribute(el, "AXVerticalScrollBar"), CFGetTypeID(bar) == AXUIElementGetTypeID(),
           let n = attribute(bar as! AXUIElement, kAXValueAttribute) as? NSNumber {
            return n.doubleValue
        }
        guard let parent = attribute(el, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
        current = (parent as! AXUIElement)
    }
    return nil
}

func scroll(_ id: Any?, _ request: [String: Any]) {
    guard let element = liveElement(id, request), let target = clickTarget(id, element) else { return }
    let dy = Int32(max(-200, min(200, (request["dy"] as? Int) ?? 0)))
    let dx = Int32(max(-200, min(200, (request["dx"] as? Int) ?? 0)))
    let before = scrollPosition(element)

    func post() {
        if let event = CGEvent(scrollWheelEvent2Source: inputSource, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            event.location = target
            event.flags = []
            event.post(tap: .cghidEventTap)
        }
        usleep(180_000)
    }
    post()
    var method = "event"
    var after = scrollPosition(element)
    if let b = before, let a = after, abs(a - b) < 0.0001, dy != 0 {
        // The event was not routed to that spot: aim the cursor there for a moment and put it back.
        let saved = CGEvent(source: nil)?.location ?? target
        CGWarpMouseCursorPosition(target)
        usleep(20_000)
        post()
        CGWarpMouseCursorPosition(saved)
        method = "cursor"
        after = scrollPosition(element)
    }
    var out: [String: Any] = ["ok": true, "method": method]
    if let b = before { out["before"] = b }
    if let a = after { out["after"] = a }
    reply(id, out)
}

func drag(_ id: Any?, _ request: [String: Any]) {
    guard let fromSpec = request["from"] as? [String: Any], let toSpec = request["to"] as? [String: Any] else {
        fail(id, "bad_request", "Missing drag ends.")
        return
    }
    var fromRequest = fromSpec
    var toRequest = toSpec
    if let epoch = request["epoch"] { fromRequest["epoch"] = epoch; toRequest["epoch"] = epoch }
    guard let source = liveElement(id, fromRequest), let destination = liveElement(id, toRequest) else { return }
    guard let from = clickTarget(id, source) else { return }
    guard let toVisible = visibleFrame(destination) else {
        fail(id, "no_frame", "The drop target is not visible on screen.")
        return
    }
    let to = CGPoint(x: toVisible.midX, y: toVisible.midY)
    if let problem = coverProblem(destination, at: to) {
        fail(id, "covered", "The drop target is covered. \(problem)")
        return
    }
    // A drag needs a real pointer: move it, drag, and put it back where it was.
    let dragSource = CGEventSource(stateID: .combinedSessionState)
    let saved = CGEvent(source: nil)?.location ?? from
    func finish(_ ok: Bool) {
        usleep(80_000)
        CGWarpMouseCursorPosition(saved)
        if ok { reply(id, ["ok": true, "method": "cursor"]) }
    }
    CGWarpMouseCursorPosition(from)
    usleep(60_000)
    if (request["select"] as? Bool) == true {
        // Lists drag what is selected: select the row first so the drag moves it instead of lassoing its neighbours.
        mouseEvent(.leftMouseDown, from, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
        usleep(30_000)
        mouseEvent(.leftMouseUp, from, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
        usleep(500_000)
    }
    mouseEvent(.mouseMoved, from, .left, clickState: 0, source: dragSource)?.post(tap: .cghidEventTap)
    usleep(60_000)
    mouseEvent(.leftMouseDown, from, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
    usleep(150_000)
    let steps = 30
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        mouseEvent(.leftMouseDragged, p, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
        usleep(20_000)
    }
    // hold over the drop spot so the target can highlight
    for _ in 0..<5 {
        mouseEvent(.leftMouseDragged, to, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
        usleep(60_000)
    }
    // Check the drop spot again just before letting go; if something moved over it, drop back where the drag started.
    if let problem = coverProblem(destination, at: to) {
        mouseEvent(.leftMouseDragged, from, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
        usleep(40_000)
        mouseEvent(.leftMouseUp, from, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
        finish(false)
        fail(id, "covered", "The drop target was covered before releasing, so nothing was moved. \(problem)")
        return
    }
    mouseEvent(.leftMouseUp, to, .left, clickState: 1, source: dragSource)?.post(tap: .cghidEventTap)
    finish(true)
}

// MARK: - Requests

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        fail(nil, "bad_request", "Not a JSON object.")
        return
    }
    let id = request["id"]
    switch request["op"] as? String ?? "" {
    case "ping":
        reply(id, ["ok": true, "version": helperVersion, "trusted": AXIsProcessTrusted()])
    case "snapshot":
        snapshot(id, request)
    case "perform":
        perform(id, request)
    case "click":
        click(id, request)
    case "focus":
        focus(id, request)
    case "setValue":
        setValue(id, request)
    case "typeText":
        typeText(id, request)
    case "key":
        pressKey(id, request)
    case "read":
        readText(id, request)
    case "scroll":
        scroll(id, request)
    case "drag":
        drag(id, request)
    default:
        fail(id, "bad_request", "Unknown op.")
    }
}

// MARK: - Main loop

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        DispatchQueue.main.async { handle(line) }
    }
    exit(0)
}

dispatchMain()
