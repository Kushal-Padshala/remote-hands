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
        titleField.frame = NSRect(x: 38, y: 17, width: bounds.width - 90, height: 18)
        titleField.autoresizingMask = [.width]
        addSubview(titleField)

        subtitleField = NSTextField(labelWithString: "")
        subtitleField.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        subtitleField.textColor = Theme.secondary
        subtitleField.lineBreakMode = .byTruncatingTail
        subtitleField.frame = NSRect(x: 38, y: 3, width: bounds.width - 90, height: 15)
        subtitleField.autoresizingMask = [.width]
        addSubview(subtitleField)

        badgeField = NSTextField(labelWithString: "")
        badgeField.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        badgeField.textColor = Theme.tertiary
        badgeField.alignment = .right
        badgeField.frame = NSRect(x: bounds.width - 65, y: 10, width: 55, height: 18)
        badgeField.autoresizingMask = [.minXMargin]
        addSubview(badgeField)
    }
}

class SpotlightPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

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
    var badge: NSTextField!
    var attachmentChipsLabel: NSTextField!
    var statusPill: NSTextField!
    var stopButton: HudActionButton!
    var closeButton: HudActionButton!
    var topDividerLine: NSBox!
    var bottomDividerLine: NSBox!
    var historyScrollView: NSScrollView!
    var historyTextView: NSTextView!
    var spinner: NSProgressIndicator!
    var copyButton: HudActionButton!
    var inputBox: NSView!
    /// Which model the next task uses; nil when the daemon offered no choice.
    var modelButton: HudActionButton?
    var modelKey: String = hudModelKey
    let modelButtonWidth: CGFloat = 206
    var answerText: String = ""
    var answerStart: Int = -1
    var copyResetWork: DispatchWorkItem?
    var statusLeft: CGFloat = 0
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
        for line in text.split(separator: "\n") {
            guard let d = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            if let q = d["submit"] as? String {
                selectedAttachments = []
                transitionToProgress(query: q)
            } else if let t = d["type"] as? String {
                textField.stringValue = t
            } else if let q = d["picker"] as? String {
                showContextPanel(query: q)
            } else if let name = d["snap"] as? String {
                panel.displayIfNeeded()
                let view: NSView = (d["of"] as? String) == "picker" ? (contextPanel?.contentView ?? rootView) : rootView
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

    func setupUI() {
        guard let screen = NSScreen.main else { exit(1) }
        let screenRect = screen.frame
        let width: CGFloat = 680
        let height: CGFloat = 84
        let x = screenRect.origin.x + (screenRect.width - width) / 2
        let y = screenRect.origin.y + screenRect.height * 0.65

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
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // Solid black, no blur and no see-through: what is behind the window never shows.
        rootView = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        rootView.wantsLayer = true
        rootView.layer?.backgroundColor = Theme.background.cgColor
        rootView.layer?.cornerRadius = 18
        rootView.layer?.masksToBounds = true
        rootView.layer?.borderWidth = 1
        rootView.layer?.borderColor = Theme.border.cgColor

        badge = NSTextField(labelWithString: "")
        badge.attributedStringValue = badgeText(targetApp)
        badge.frame = NSRect(x: 24, y: height - 28, width: 220, height: 16)
        rootView.addSubview(badge)

        attachmentChipsLabel = NSTextField(labelWithString: "")
        attachmentChipsLabel.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        attachmentChipsLabel.textColor = Theme.accent
        attachmentChipsLabel.frame = NSRect(x: 250, y: height - 28, width: width - 330, height: 16)
        attachmentChipsLabel.lineBreakMode = .byTruncatingTail
        attachmentChipsLabel.isHidden = true
        rootView.addSubview(attachmentChipsLabel)

        closeButton = makePillButton(title: "✕", frame: NSRect(x: width - 44, y: height - 32, width: 26, height: 24), tint: Theme.secondary, fill: NSColor(white: 1.0, alpha: 0.10), action: #selector(onCancelClicked))
        closeButton.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        rootView.addSubview(closeButton)

        stopButton = makePillButton(title: "Stop", frame: NSRect(x: width - 118, y: height - 32, width: 64, height: 24), tint: Theme.danger, fill: NSColor(red: 1.0, green: 0.44, blue: 0.44, alpha: 0.16), action: #selector(onStopClicked))
        stopButton.isHidden = true
        rootView.addSubview(stopButton)

        copyButton = makePillButton(title: "Copy", frame: NSRect(x: width - 118, y: height - 32, width: 64, height: 24), tint: Theme.text, fill: NSColor(white: 1.0, alpha: 0.12), action: #selector(onCopyClicked))
        copyButton.isHidden = true
        rootView.addSubview(copyButton)

        spinner = NSProgressIndicator(frame: NSRect(x: width - 160, y: height - 30, width: 16, height: 16))
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isIndeterminate = true
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        rootView.addSubview(spinner)

        statusPill = NSTextField(labelWithString: "")
        statusPill.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        statusPill.textColor = Theme.accent
        statusPill.frame = NSRect(x: width - 330, y: height - 30, width: 164, height: 18)
        statusPill.alignment = .right
        statusPill.isHidden = true
        rootView.addSubview(statusPill)

        let pickerWidth: CGFloat = hudModels.isEmpty ? 0 : modelButtonWidth + 8
        textField = NSTextField(frame: NSRect(x: 24, y: 16, width: width - 48 - pickerWidth, height: 28))
        textField.isBordered = false
        textField.drawsBackground = false
        textField.focusRingType = .none
        textField.font = NSFont.systemFont(ofSize: 18, weight: .regular)
        textField.textColor = Theme.text
        setPlaceholder("Ask anything, or type @ to attach context…", size: 18)
        textField.isEditable = true
        textField.isSelectable = true
        textField.delegate = self
        rootView.addSubview(textField)

        if !hudModels.isEmpty {
            let button = makePillButton(title: "", frame: NSRect(x: width - 24 - modelButtonWidth, y: 18, width: modelButtonWidth, height: 26), tint: Theme.secondary, fill: NSColor(white: 1.0, alpha: 0.10), action: #selector(onModelClicked(_:)))
            modelButton = button
            rootView.addSubview(button)
            updateModelButton()
        }

        panel.contentView = rootView
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(textField)
    }

    /// The button shows the model the next task will use.
    func updateModelButton() {
        guard let button = modelButton else { return }
        let label = hudModels.first(where: { $0["key"] == modelKey })?["label"] ?? hudModels.first?["label"] ?? ""
        button.attributedTitle = NSAttributedString(string: "\(label)  ▾", attributes: [.foregroundColor: Theme.secondary, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)])
        button.toolTip = "Model used for your next task"
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

    /// One place that sets the status word and its colour.
    func setStatus(_ word: String, color: NSColor) {
        statusPill.stringValue = word
        statusPill.textColor = color
    }

    func updateWorkingChrome() {
        guard spinner != nil else { return }
        if isWorking && isExpanded {
            spinner.isHidden = false
            spinner.startAnimation(nil)
        } else {
            spinner.stopAnimation(nil)
            spinner.isHidden = true
        }
        // The status word sits right after the spinner while working, and takes its place when done.
        if isExpanded, statusLeft > 0 {
            statusPill.frame.origin.x = isWorking ? statusLeft + 22 : statusLeft
        }
        if isExpanded, textField != nil {
            setPlaceholder(isWorking ? "Type a follow-up, or press Esc to stop" : "Ask a follow-up, or press Esc to close", size: 14.5)
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

        if filteredContextItems.isEmpty {
            hideContextPanel()
            return
        }

        let rowCount = min(7, filteredContextItems.count)
        let targetHeight: CGFloat = CGFloat(rowCount * 38 + 14)
        let panelFrame = panel.frame
        let popoverRect = NSRect(x: panelFrame.origin.x, y: panelFrame.origin.y - targetHeight - 6, width: panelFrame.width, height: targetHeight)

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
        if let cp = contextPanel, cp.isVisible {
            panel.removeChildWindow(cp)
            cp.orderOut(nil)
        }
    }

    func attachItem(_ item: [String: Any]) {
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

    func controlTextDidChange(_ obj: Notification) {
        let current = textField.stringValue
        if let atIndex = current.lastIndex(of: "@") {
            let afterAt = String(current[current.index(after: atIndex)...])
            showContextPanel(query: afterAt)
        } else {
            hideContextPanel()
        }
    }

    @objc func onStopClicked() {
        isWorking = false
        print("{\"event\":\"stop\"}")
        fflush(stdout)
        setStatus("Stopped", color: Theme.warning)
        stopButton.isHidden = true
        appendEntry(.note, "Stopped.")
        if let tf = textField {
            panel.makeFirstResponder(tf)
        }
    }

    @objc func onCancelClicked() {
        print("{\"event\":\"cancel\"}")
        fflush(stdout)
        usleep(50000)
        exit(0)
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
            let text = textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                textField.stringValue = ""
                var dict: [String: Any] = ["event": "submit", "query": text, "app": targetApp]
                if !hudModels.isEmpty { dict["model"] = modelKey }
                if !targetWindowTitle.isEmpty {
                    dict["windowTitle"] = targetWindowTitle
                }
                if !selectedAttachments.isEmpty {
                    dict["attachments"] = selectedAttachments
                }
                if let data = try? JSONSerialization.data(withJSONObject: dict),
                   let json = String(data: data, encoding: .utf8) {
                    print(json)
                    fflush(stdout)
                    selectedAttachments = []
                    updateChipsDisplay()
                    if !isExpanded {
                        transitionToProgress(query: text)
                    } else {
                        appendEntry(.goal, text)
                        answerText = ""
                        isWorking = true
                        setStatus("Working", color: Theme.accent)
                        stopButton.isHidden = false
                        copyButton.isHidden = true
                    }
                    return true
                }
            }
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

    /// A small uppercase caption such as YOU or RESULT.
    func caption(_ text: String, color: NSColor, before: CGFloat) -> NSAttributedString {
        return NSAttributedString(string: text + "\n", attributes: [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .semibold),
            .foregroundColor: color,
            .kern: 1.2,
            .paragraphStyle: paragraphStyle(before: before, after: 5)
        ])
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

    /// One short line with a symbol in the margin, for steps, notes and problems.
    func marginLine(symbol: String, symbolColor: NSColor, text: String, color: NSColor, weight: NSFont.Weight, size: CGFloat, before: CGFloat, after: CGFloat) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let ps = paragraphStyle(before: before, after: after, lineSpacing: 2, first: 0, head: 20, tab: 20)
        out.append(NSAttributedString(string: symbol + "\t", attributes: [.font: NSFont.systemFont(ofSize: size, weight: .semibold), .foregroundColor: symbolColor, .paragraphStyle: ps]))
        out.append(NSAttributedString(string: text + "\n", attributes: [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .paragraphStyle: ps]))
        return out
    }

    func appendEntry(_ kind: EntryKind, _ rawText: String) {
        guard let storage = historyTextView?.textStorage else { return }
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        let isFirst = storage.length == 0
        let out = NSMutableAttributedString()
        let start = storage.length

        switch kind {
        case .goal:
            out.append(caption("YOU", color: Theme.tertiary, before: isFirst ? 0 : 20))
            out.append(body(text, font: NSFont.systemFont(ofSize: 15, weight: .medium), color: Theme.text, lineSpacing: 3, after: 10))
        case .step:
            out.append(marginLine(symbol: "✓", symbolColor: Theme.success, text: text, color: Theme.secondary, weight: .regular, size: 13, before: 0, after: 6))
        case .note:
            out.append(marginLine(symbol: "·", symbolColor: Theme.tertiary, text: text, color: Theme.tertiary, weight: .regular, size: 13, before: 0, after: 6))
        case .attention:
            out.append(marginLine(symbol: "!", symbolColor: Theme.warning, text: text, color: Theme.warning, weight: .medium, size: 13.5, before: 4, after: 8))
        case .error:
            out.append(marginLine(symbol: "✕", symbolColor: Theme.danger, text: text, color: Theme.danger, weight: .medium, size: 13.5, before: 4, after: 8))
        case .answer:
            out.append(caption("RESULT", color: Theme.success, before: isFirst ? 0 : 18))
            let answer = body(text, font: NSFont.systemFont(ofSize: 14.5, weight: .regular), color: Theme.text, lineSpacing: 4, after: 4)
            if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
                let whole = NSRange(location: 0, length: answer.length)
                for match in detector.matches(in: answer.string, options: [], range: whole) {
                    // Only web and mail links are clickable: a file: path in the agent's text must never open or launch anything.
                    if let url = match.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                        answer.addAttribute(.link, value: url, range: match.range)
                    }
                }
            }
            out.append(answer)
            answerStart = start
            answerText = text
        }

        storage.append(out)
        if kind == .answer {
            scrollFeed(toTopOf: start)
        } else {
            historyTextView?.scrollToEndOfDocument(nil)
        }
    }

    /// Puts the line at `location` at the top of the feed, so a long answer is read from its first line.
    func scrollFeed(toTopOf location: Int) {
        guard let tv = historyTextView, let lm = tv.layoutManager, let tc = tv.textContainer, let storage = tv.textStorage, storage.length > 0 else { return }
        lm.ensureLayout(for: tc)
        let glyph = lm.glyphIndexForCharacter(at: min(location, storage.length - 1))
        let rect = lm.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let clip = historyScrollView.contentView
        let target = NSRect(x: 0, y: max(0, rect.origin.y + tv.textContainerOrigin.y - 6), width: clip.bounds.width, height: clip.bounds.height)
        clip.scroll(to: clip.constrainBoundsRect(target).origin)
        historyScrollView.reflectScrolledClipView(clip)
    }

    @objc func onCopyClicked() {
        guard !answerText.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(answerText, forType: .string)
        copyButton.attributedTitle = NSAttributedString(string: "Copied", attributes: [.foregroundColor: Theme.success, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)])
        copyResetWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.copyButton.attributedTitle = NSAttributedString(string: "Copy", attributes: [.foregroundColor: Theme.text, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)])
        }
        copyResetWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
    }

    /// "READING" from the helper's protocol becomes "Reading" on screen.
    func displayStatus(_ raw: String) -> String {
        let lower = raw.lowercased()
        return lower.prefix(1).uppercased() + lower.dropFirst()
    }

    // MARK: - Updates from the daemon

    func setupInputReader() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            guard let text = String(data: data, encoding: .utf8) else { return }
            let lines = text.split(separator: "\n")
            for line in lines {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty,
                      let jsonData = trimmed.data(using: .utf8),
                      let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }
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

        let status = (dict["status"] as? String)?.uppercased() ?? "WORKING"
        let text = dict["text"] as? String ?? ""
        let role = dict["role"] as? String

        if status == "COMPLETE" || status == "DONE" {
            isWorking = false
            setStatus("Done", color: Theme.success)
            stopButton.isHidden = true
            answerText = ""
            let finalText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            appendEntry(.answer, finalText.isEmpty ? "Task completed successfully." : finalText)
            copyButton.isHidden = answerText.isEmpty
            copyButton.attributedTitle = NSAttributedString(string: "Copy", attributes: [.foregroundColor: Theme.text, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)])
            panel.makeFirstResponder(textField)
        } else if status == "STOPPED" || status == "CANCELLED" {
            if isWorking {
                appendEntry(.note, text.isEmpty ? "Stopped." : text)
            }
            isWorking = false
            setStatus("Stopped", color: Theme.warning)
            stopButton.isHidden = true
            panel.makeFirstResponder(textField)
        } else if status == "FAILED" {
            // The task is over: stop the spinner and give the input back.
            isWorking = false
            setStatus("Failed", color: Theme.danger)
            stopButton.isHidden = true
            appendEntry(.error, text.isEmpty ? "The task failed." : text)
            panel.makeFirstResponder(textField)
        } else if status == "ERROR" {
            appendEntry(.error, text.isEmpty ? "Something went wrong." : text)
        } else if text.isEmpty && !isWorking {
            // A status-word-only update that arrives after the task ended must not bring the spinner back.
            return
        } else {
            isWorking = true
            setStatus(displayStatus(status), color: Theme.accent)
            stopButton.isHidden = false
            copyButton.isHidden = true
            if !text.isEmpty {
                appendEntry(role == "ATTENTION" || role == "PROBLEM" ? .attention : .step, text)
            }
        }
    }

    func transitionToProgress(query: String) {
        isExpanded = true
        isWorking = true
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let width: CGFloat = 640
        let height = min(600, max(420, visible.height - 80))
        let x = visible.maxX - width - 24
        let y = visible.maxY - height - 24

        panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true, animate: true)
        panel.level = .floating
        rootView.frame = NSRect(x: 0, y: 0, width: width, height: height)

        // Header: where it works, what it is doing, and the one button that matters right now.
        let headerBottom = height - 52
        badge.attributedStringValue = badgeText(targetApp)
        let badgeWidth = min(200, ceil(badge.attributedStringValue.size().width) + 4)
        badge.frame = NSRect(x: 22, y: height - 34, width: badgeWidth, height: 16)
        let statusX = 22 + badgeWidth + 20
        statusLeft = statusX
        spinner.frame = NSRect(x: statusX, y: height - 35, width: 16, height: 16)
        statusPill.frame = NSRect(x: statusX, y: height - 35, width: 150, height: 18)
        statusPill.alignment = .left
        attachmentChipsLabel.frame = NSRect(x: statusX + 180, y: height - 34, width: max(40, width - 130 - (statusX + 180)), height: 16)
        statusPill.isHidden = false
        setStatus("Starting", color: Theme.accent)

        stopButton.frame = NSRect(x: width - 118, y: height - 38, width: 64, height: 24)
        stopButton.isHidden = false
        copyButton.frame = stopButton.frame
        closeButton.frame = NSRect(x: width - 44, y: height - 38, width: 26, height: 24)
        rootView.addSubview(copyButton, positioned: .above, relativeTo: nil)
        rootView.addSubview(stopButton, positioned: .above, relativeTo: nil)
        rootView.addSubview(closeButton, positioned: .above, relativeTo: nil)

        topDividerLine = NSBox(frame: NSRect(x: 0, y: headerBottom, width: width, height: 1))
        topDividerLine.boxType = .custom
        topDividerLine.borderWidth = 0
        topDividerLine.fillColor = Theme.divider
        rootView.addSubview(topDividerLine)

        // Footer: a rounded box to type a follow-up in.
        let boxHeight: CGFloat = 44
        inputBox = NSView(frame: NSRect(x: 16, y: 16, width: width - 32, height: boxHeight))
        inputBox.wantsLayer = true
        inputBox.layer?.backgroundColor = Theme.field.cgColor
        inputBox.layer?.cornerRadius = 12
        inputBox.layer?.borderWidth = 1
        inputBox.layer?.borderColor = Theme.divider.cgColor
        rootView.addSubview(inputBox)

        // The feed, between the header and the footer.
        let feedBottom: CGFloat = 16 + boxHeight + 12
        let scrollFrame = NSRect(x: 22, y: feedBottom, width: width - 44, height: headerBottom - feedBottom - 6)
        historyScrollView = NSScrollView(frame: scrollFrame)
        historyScrollView.drawsBackground = false
        historyScrollView.hasVerticalScroller = true
        historyScrollView.hasHorizontalScroller = false
        historyScrollView.autohidesScrollers = true
        historyScrollView.scrollerStyle = .overlay
        historyScrollView.scrollerKnobStyle = .light
        historyScrollView.borderType = .noBorder

        let contentSize = historyScrollView.contentSize
        historyTextView = NSTextView(frame: NSRect(origin: .zero, size: contentSize))
        historyTextView.minSize = NSSize(width: 0.0, height: contentSize.height)
        historyTextView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        historyTextView.isVerticallyResizable = true
        historyTextView.isHorizontallyResizable = false
        historyTextView.autoresizingMask = [.width]
        historyTextView.textContainerInset = NSSize(width: 0, height: 14)
        historyTextView.textContainer?.containerSize = NSSize(width: contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        historyTextView.textContainer?.widthTracksTextView = true
        historyTextView.textContainer?.lineFragmentPadding = 0
        historyTextView.drawsBackground = false
        historyTextView.backgroundColor = .clear
        historyTextView.isEditable = false
        historyTextView.isSelectable = true
        historyTextView.selectedTextAttributes = [.backgroundColor: NSColor(red: 0.38, green: 0.64, blue: 1.0, alpha: 0.35)]
        historyTextView.linkTextAttributes = [.foregroundColor: Theme.accent, .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand]
        historyScrollView.documentView = historyTextView
        rootView.addSubview(historyScrollView)

        textField.removeFromSuperview()
        let pickerWidth: CGFloat = modelButton == nil ? 0 : modelButtonWidth + 8
        textField.frame = NSRect(x: 14, y: 11, width: inputBox.bounds.width - 28 - pickerWidth, height: 22)
        if let button = modelButton {
            button.removeFromSuperview()
            button.frame = NSRect(x: inputBox.bounds.width - 10 - modelButtonWidth, y: 9, width: modelButtonWidth, height: 26)
            inputBox.addSubview(button)
        }
        textField.font = NSFont.systemFont(ofSize: 14.5, weight: .regular)
        textField.isHidden = false
        inputBox.addSubview(textField)
        updateWorkingChrome()
        panel.makeFirstResponder(textField)

        appendEntry(.goal, query)
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
