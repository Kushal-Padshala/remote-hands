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
