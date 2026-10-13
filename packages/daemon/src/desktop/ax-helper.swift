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

    func children(of element: AXUIElement, role: String) -> [AXUIElement] {
        if listRoles.contains(role) {
            for name in ["AXVisibleRows", "AXVisibleChildren"] {
                if let list = attribute(element, name) as? [AXUIElement] { return list }
            }
        }
        return (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
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
        let secure = (sub == "AXSecureTextField") || role == "AXSecureTextField"
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
        for child in children(of: element, role: role) {
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

/// The element for a handle, or a reply saying why not. An element that left the screen answers "stale".
func liveElement(_ id: Any?, _ request: [String: Any], key: String = "h") -> AXUIElement? {
    guard let h = request[key] as? Int else {
        fail(id, "bad_request", "Missing element id.")
        return nil
    }
    guard let element = handles.element(h) else {
        fail(id, "stale", "Unknown element id \(h): take a new snapshot.")
        return nil
    }
    var role: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
    if err == .invalidUIElement || err == .cannotComplete || (err != .success && err != .noValue && err != .attributeUnsupported) {
        fail(id, "stale", "That element is no longer on screen: take a new snapshot.")
        return nil
    }
    return element
}

func frameOf(_ element: AXUIElement) -> CGRect? {
    let v = fetch(element, [kAXPositionAttribute, kAXSizeAttribute])
    guard let o = point(v[0]), let s = size(v[1]), s.width > 0, s.height > 0, o.x.isFinite, o.y.isFinite else { return nil }
    return CGRect(origin: o, size: s)
}

func pidOf(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

func activate(_ pid: pid_t) {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isActive else { return }
    if #available(macOS 14.0, *) {
        app.activate()
    } else {
        app.activate(options: [.activateIgnoringOtherApps])
    }
    // give the window server a moment so that what follows lands in this app
    for _ in 0..<20 {
        if app.isActive { break }
        usleep(15_000)
    }
}

/// Which app owns the topmost thing at a screen point.
func ownerAt(_ p: CGPoint) -> pid_t? {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let el = hit else { return nil }
    return pidOf(el)
}

func appName(_ pid: pid_t) -> String {
    return NSRunningApplication(processIdentifier: pid)?.localizedName ?? "another app"
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

func mouseEvent(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clickState: Int64) -> CGEvent? {
    let source = CGEventSource(stateID: .hidSystemState)
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
    event?.setIntegerValueField(.mouseEventClickState, value: clickState)
    return event
}

/// A real click, posted at the element's centre without moving the cursor. Refuses when another app's window is on top.
func click(_ id: Any?, _ request: [String: Any]) {
    var target: CGPoint
    var owner: pid_t?
    if let element = (request["h"] != nil ? liveElement(id, request) : nil) {
        guard let frame = frameOf(element) else {
            fail(id, "no_frame", "This element has no position on screen.")
            return
        }
        target = CGPoint(x: frame.midX, y: frame.midY)
        owner = pidOf(element)
    } else if request["h"] != nil {
        return // liveElement already replied
    } else if let x = request["x"] as? Double, let y = request["y"] as? Double {
        target = CGPoint(x: x, y: y)
        owner = nil
    } else {
        fail(id, "bad_request", "Missing element id or position.")
        return
    }
    if let pid = owner, let top = ownerAt(target), top != pid {
        fail(id, "covered", "\(appName(top)) is on top of that element.")
        return
    }
    if let pid = owner { activate(pid) }
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
    if let pid = pidOf(element) { activate(pid) }
    // raise the window the element lives in
    if let window = attribute(element, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
        _ = AXUIElementPerformAction(window as! AXUIElement, kAXRaiseAction as CFString)
    }
    let err = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let now = flag(attribute(element, kAXFocusedAttribute)) ?? false
    if err != .success && !now {
        fail(id, "failed", "This element cannot take focus.")
        return
    }
    reply(id, ["ok": true, "focused": now])
}

func isSecureElement(_ element: AXUIElement) -> Bool {
    let v = fetch(element, [kAXRoleAttribute, kAXSubroleAttribute])
    return text(v[0]) == "AXSecureTextField" || text(v[1]) == "AXSecureTextField"
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
    let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
    if err != .success {
        fail(id, "failed", "Setting the value failed (code \(err.rawValue)).")
        return
    }
    let secure = isSecureElement(element)
    let after = text(attribute(element, kAXValueAttribute)) ?? ""
    reply(id, ["ok": true, "matches": after == value, "value": secure ? "" : clip(after, 300), "secure": secure])
}

/// Keys for characters that are not text.
let specialKeys: [Character: CGKeyCode] = ["\n": 36, "\r": 36, "\t": 48]

func typeText(_ id: Any?, _ request: [String: Any]) {
    guard let content = request["text"] as? String else {
        fail(id, "bad_request", "Missing text.")
        return
    }
    if let pid = request["pid"] as? Int { activate(pid_t(pid)) }
    let source = CGEventSource(stateID: .hidSystemState)
    var pending: [UniChar] = []
    func flush() {
        guard !pending.isEmpty else { return }
        var units = pending
        if let d = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
           let u = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
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
            if let d = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
               let u = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) {
                d.post(tap: .cghidEventTap)
                u.post(tap: .cghidEventTap)
            }
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
    guard let element = liveElement(id, request) else { return }
    guard let frame = frameOf(element) else {
        fail(id, "no_frame", "This element has no position on screen.")
        return
    }
    let dy = Int32(max(-200, min(200, (request["dy"] as? Int) ?? 0)))
    let dx = Int32(max(-200, min(200, (request["dx"] as? Int) ?? 0)))
    let target = CGPoint(x: frame.midX, y: frame.midY)
    if let pid = pidOf(element), let top = ownerAt(target), top != pid {
        fail(id, "covered", "\(appName(top)) is on top of that element.")
        return
    }
    if let pid = pidOf(element) { activate(pid) }
    let before = scrollPosition(element)

    func post() {
        let source = CGEventSource(stateID: .hidSystemState)
        if let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            event.location = target
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
    func end(_ key: String) -> (CGPoint, pid_t?)? {
        guard let spec = request[key] as? [String: Any] else { return nil }
        if spec["h"] != nil {
            guard let h = spec["h"] as? Int, let el = handles.element(h), let f = frameOf(el) else { return nil }
            return (CGPoint(x: f.midX, y: f.midY), pidOf(el))
        }
        if let x = spec["x"] as? Double, let y = spec["y"] as? Double { return (CGPoint(x: x, y: y), nil) }
        return nil
    }
    guard let (from, fromPid) = end("from"), let (to, _) = end("to") else {
        fail(id, "stale", "Could not find both ends of the drag: take a new snapshot.")
        return
    }
    if let pid = fromPid, let top = ownerAt(from), top != pid {
        fail(id, "covered", "\(appName(top)) is on top of that element.")
        return
    }
    if let pid = fromPid { activate(pid) }
    // A drag needs a real pointer: move it, drag, and put it back where it was.
    let saved = CGEvent(source: nil)?.location ?? from
    CGWarpMouseCursorPosition(from)
    usleep(40_000)
    mouseEvent(.leftMouseDown, from, .left, clickState: 1)?.post(tap: .cghidEventTap)
    usleep(60_000)
    let steps = 14
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        mouseEvent(.leftMouseDragged, p, .left, clickState: 1)?.post(tap: .cghidEventTap)
        usleep(18_000)
    }
    usleep(80_000)
    mouseEvent(.leftMouseUp, to, .left, clickState: 1)?.post(tap: .cghidEventTap)
    usleep(80_000)
    CGWarpMouseCursorPosition(saved)
    reply(id, ["ok": true, "method": "cursor"])
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
