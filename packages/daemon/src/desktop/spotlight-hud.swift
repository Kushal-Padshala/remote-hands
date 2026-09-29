import AppKit
import Foundation
import Carbon

class HudActionButton: NSButton {
    override var mouseDownCanMoveWindow: Bool { false }
}

class ContextTableRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        if isSelected {
            let selectionRect = bounds.insetBy(dx: 4, dy: 2)
            let path = NSBezierPath(roundedRect: selectionRect, xRadius: 8, yRadius: 8)
            NSColor(red: 0.15, green: 0.38, blue: 0.95, alpha: 0.90).setFill()
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
        titleField.textColor = .white
        titleField.lineBreakMode = .byTruncatingTail
        titleField.frame = NSRect(x: 38, y: 17, width: bounds.width - 90, height: 18)
        titleField.autoresizingMask = [.width]
        addSubview(titleField)

        subtitleField = NSTextField(labelWithString: "")
        subtitleField.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        subtitleField.textColor = NSColor(white: 0.60, alpha: 1.0)
        subtitleField.lineBreakMode = .byTruncatingTail
        subtitleField.frame = NSRect(x: 38, y: 3, width: bounds.width - 90, height: 15)
        subtitleField.autoresizingMask = [.width]
        addSubview(subtitleField)

        badgeField = NSTextField(labelWithString: "")
        badgeField.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        badgeField.textColor = NSColor(white: 0.50, alpha: 1.0)
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
                if delegate.isExpanded {
                    if delegate.isWorking {
                        delegate.onStopClicked()
                    }
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
            if delegate.isExpanded {
                if delegate.isWorking {
                    delegate.onStopClicked()
                }
                return
            }
            delegate.onCancelClicked()
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    var panel: SpotlightPanel!
    var visualEffect: NSVisualEffectView!
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
    var targetApp: String = "Desktop"
    var targetWindowTitle: String = ""
    var isWorking: Bool = false
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
    }

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
        let x = (screenRect.width - width) / 2
        let y = screenRect.height * 0.65

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
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        visualEffect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        visualEffect.material = .hudWindow
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.wantsLayer = true
        visualEffect.layer?.backgroundColor = NSColor(red: 0.05, green: 0.05, blue: 0.07, alpha: 0.98).cgColor
        visualEffect.layer?.cornerRadius = 16
        visualEffect.layer?.masksToBounds = true
        visualEffect.layer?.borderWidth = 1
        visualEffect.layer?.borderColor = NSColor(white: 1.0, alpha: 0.12).cgColor

        badge = NSTextField(labelWithString: targetApp.uppercased())
        badge.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        badge.textColor = NSColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 1.0)
        badge.frame = NSRect(x: 24, y: height - 26, width: 130, height: 16)
        visualEffect.addSubview(badge)

        attachmentChipsLabel = NSTextField(labelWithString: "")
        attachmentChipsLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        attachmentChipsLabel.textColor = NSColor(red: 0.35, green: 0.75, blue: 1.0, alpha: 1.0)
        attachmentChipsLabel.frame = NSRect(x: 160, y: height - 26, width: width - 300, height: 16)
        attachmentChipsLabel.lineBreakMode = .byTruncatingTail
        attachmentChipsLabel.isHidden = true
        visualEffect.addSubview(attachmentChipsLabel)

        closeButton = HudActionButton(frame: NSRect(x: width - 44, y: height - 30, width: 26, height: 24))
        closeButton.title = "✕"
        closeButton.bezelStyle = .regularSquare
        closeButton.isBordered = false
        closeButton.wantsLayer = true
        closeButton.layer?.cornerRadius = 12
        closeButton.layer?.masksToBounds = true
        closeButton.layer?.backgroundColor = NSColor(white: 0.20, alpha: 0.8).cgColor
        closeButton.font = NSFont.systemFont(ofSize: 12, weight: .bold)
        closeButton.contentTintColor = NSColor(white: 0.75, alpha: 1.0)
        closeButton.target = self
        closeButton.action = #selector(onCancelClicked)
        visualEffect.addSubview(closeButton)

        stopButton = HudActionButton(frame: NSRect(x: width - 130, y: height - 32, width: 78, height: 24))
        stopButton.title = "⏹ Stop"
        stopButton.bezelStyle = .regularSquare
        stopButton.isBordered = false
        stopButton.wantsLayer = true
        stopButton.layer?.cornerRadius = 12
        stopButton.layer?.masksToBounds = true
        stopButton.layer?.backgroundColor = NSColor(red: 0.85, green: 0.25, blue: 0.25, alpha: 0.25).cgColor
        stopButton.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        stopButton.contentTintColor = NSColor(red: 1.0, green: 0.45, blue: 0.45, alpha: 1.0)
        stopButton.target = self
        stopButton.action = #selector(onStopClicked)
        stopButton.isHidden = true
        visualEffect.addSubview(stopButton)

        statusPill = NSTextField(labelWithString: "● THINKING")
        statusPill.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
        statusPill.textColor = NSColor.systemCyan
        statusPill.frame = NSRect(x: width - 265, y: height - 32, width: 125, height: 18)
        statusPill.alignment = .right
        statusPill.isHidden = true
        visualEffect.addSubview(statusPill)

        textField = NSTextField(frame: NSRect(x: 22, y: 14, width: width - 44, height: 40))
        textField.isBordered = false
        textField.drawsBackground = false
        textField.focusRingType = .none
        textField.font = NSFont.systemFont(ofSize: 17, weight: .regular)
        textField.textColor = .white
        let pAttr: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor(white: 0.45, alpha: 1.0),
            .font: NSFont.systemFont(ofSize: 17, weight: .regular)
        ]
        textField.placeholderAttributedString = NSAttributedString(string: "Ask anything or type @ to attach context...", attributes: pAttr)
        textField.isEditable = true
        textField.isSelectable = true
        textField.delegate = self
        visualEffect.addSubview(textField)

        panel.contentView = visualEffect
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(textField)
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

            let effect = NSView(frame: NSRect(origin: .zero, size: popoverRect.size))
            effect.wantsLayer = true
            effect.layer?.backgroundColor = NSColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 0.98).cgColor
            effect.layer?.cornerRadius = 14
            effect.layer?.masksToBounds = true
            effect.layer?.borderWidth = 1
            effect.layer?.borderColor = NSColor(white: 1.0, alpha: 0.14).cgColor

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
        statusPill.stringValue = "⏹ STOPPED"
        statusPill.textColor = .systemOrange
        stopButton.isHidden = true
        appendHistory(role: "SYSTEM", text: "Task stopped by user.", color: .systemOrange, icon: "⏹")
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
                        appendHistory(role: "YOU", text: text, color: NSColor(red: 0.35, green: 0.75, blue: 1.0, alpha: 1.0), icon: "💬")
                        isWorking = true
                        statusPill.stringValue = "● WORKING"
                        statusPill.textColor = .systemCyan
                        stopButton.isHidden = false
                    }
                    return true
                }
            }
            return true
        } else if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            if isExpanded {
                if isWorking {
                    onStopClicked()
                }
            } else {
                onCancelClicked()
            }
            return true
        }
        return false
    }

    func appendHistory(role: String, text: String, color: NSColor, icon: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let timestamp = formatter.string(from: Date())

        let fullString = NSMutableAttributedString()

        let timeAttr: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor(white: 0.45, alpha: 1.0)
        ]
        fullString.append(NSAttributedString(string: "[\(timestamp)] ", attributes: timeAttr))

        let roleAttr: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold),
            .foregroundColor: color
        ]
        fullString.append(NSAttributedString(string: "\(icon) \(role.uppercased()): ", attributes: roleAttr))

        let textAttr: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor(white: 0.94, alpha: 1.0)
        ]
        fullString.append(NSAttributedString(string: "\(text)\n\n", attributes: textAttr))

        if let storage = historyTextView?.textStorage {
            storage.append(fullString)
            historyTextView?.scrollToEndOfDocument(nil)
        }
    }

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
                    guard let self = self else { return }
                    if dict["event"] as? String == "context", let h = dict["hierarchy"] as? [String: Any] {
                        self.loadHierarchy(h)
                        return
                    }

                    let status = (dict["status"] as? String)?.uppercased() ?? "WORKING"
                    let text = dict["text"] as? String ?? ""
                    let role = dict["role"] as? String

                    if status == "COMPLETE" || status == "DONE" {
                        self.isWorking = false
                        self.statusPill.stringValue = "✔ COMPLETE"
                        self.statusPill.textColor = .systemGreen
                        self.stopButton.isHidden = true
                        self.appendHistory(role: role ?? "DONE", text: text.isEmpty ? "Task completed successfully." : text, color: .systemGreen, icon: "✔")
                        self.panel.makeFirstResponder(self.textField)
                    } else if status == "STOPPED" || status == "CANCELLED" {
                        if self.isWorking {
                            self.appendHistory(role: role ?? "STATUS", text: text.isEmpty ? "Task stopped." : text, color: .systemOrange, icon: "⏹")
                        }
                        self.isWorking = false
                        self.statusPill.stringValue = "⏹ STOPPED"
                        self.statusPill.textColor = .systemOrange
                        self.stopButton.isHidden = true
                        self.panel.makeFirstResponder(self.textField)
                    } else if status == "FAILED" || status == "ERROR" {
                        self.appendHistory(role: role ?? "ERROR", text: text.isEmpty ? "Action error occurred." : text, color: .systemRed, icon: "⚠")
                    } else {
                        self.isWorking = true
                        self.statusPill.stringValue = "● " + status
                        self.statusPill.textColor = .systemCyan
                        self.stopButton.isHidden = false
                        if !text.isEmpty {
                            var color = NSColor.systemCyan
                            var icon = "🧠"
                            let r = role ?? status
                            if status == "EXECUTING" || status == "ACTION" {
                                color = NSColor(red: 1.0, green: 0.78, blue: 0.28, alpha: 1.0)
                                icon = "⚡"
                            } else if status == "FOCUS" {
                                color = NSColor(red: 0.6, green: 0.6, blue: 1.0, alpha: 1.0)
                                icon = "🎯"
                            } else if status == "OUTPUT" {
                                color = NSColor(red: 0.4, green: 0.85, blue: 0.5, alpha: 1.0)
                                icon = "✔"
                            }
                            self.appendHistory(role: r, text: text, color: color, icon: icon)
                        }
                    }
                }
            }
        }
    }

    func transitionToProgress(query: String) {
        isExpanded = true
        isWorking = true
        let newHeight: CGFloat = 420
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let width: CGFloat = 580
        let x = screen.frame.width - width - 24
        let y = screen.frame.height - newHeight - 48

        panel.setFrame(NSRect(x: x, y: y, width: width, height: newHeight), display: true, animate: true)
        panel.level = .floating
        visualEffect.frame = NSRect(x: 0, y: 0, width: width, height: newHeight)

        badge.stringValue = targetApp.uppercased()
        badge.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        badge.textColor = NSColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 1.0)
        badge.frame = NSRect(x: 20, y: newHeight - 32, width: 130, height: 18)

        attachmentChipsLabel.frame = NSRect(x: 160, y: newHeight - 32, width: width - 440, height: 18)

        statusPill.frame = NSRect(x: width - 265, y: newHeight - 32, width: 125, height: 18)
        statusPill.stringValue = "● WORKING"
        statusPill.textColor = .systemCyan
        statusPill.alignment = .right
        statusPill.isHidden = false

        stopButton.frame = NSRect(x: width - 130, y: newHeight - 34, width: 78, height: 24)
        stopButton.isHidden = false
        visualEffect.addSubview(stopButton, positioned: .above, relativeTo: nil)

        closeButton.frame = NSRect(x: width - 44, y: newHeight - 34, width: 26, height: 24)
        visualEffect.addSubview(closeButton, positioned: .above, relativeTo: nil)

        topDividerLine = NSBox(frame: NSRect(x: 20, y: newHeight - 44, width: width - 40, height: 1))
        topDividerLine.boxType = .custom
        topDividerLine.borderWidth = 0
        topDividerLine.fillColor = NSColor(white: 1.0, alpha: 0.12)
        visualEffect.addSubview(topDividerLine)

        let scrollFrame = NSRect(x: 20, y: 56, width: width - 40, height: newHeight - 110)
        historyScrollView = NSScrollView(frame: scrollFrame)
        historyScrollView.drawsBackground = false
        historyScrollView.hasVerticalScroller = true
        historyScrollView.hasHorizontalScroller = false
        historyScrollView.autohidesScrollers = true
        historyScrollView.borderType = .noBorder

        let contentSize = historyScrollView.contentSize
        historyTextView = NSTextView(frame: NSRect(origin: .zero, size: contentSize))
        historyTextView.minSize = NSSize(width: 0.0, height: contentSize.height)
        historyTextView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        historyTextView.isVerticallyResizable = true
        historyTextView.isHorizontallyResizable = false
        historyTextView.autoresizingMask = [.width]
        historyTextView.textContainer?.containerSize = NSSize(width: contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        historyTextView.textContainer?.widthTracksTextView = true
        historyTextView.drawsBackground = false
        historyTextView.backgroundColor = .clear
        historyTextView.isEditable = false
        historyTextView.isSelectable = true
        historyScrollView.documentView = historyTextView
        visualEffect.addSubview(historyScrollView)

        bottomDividerLine = NSBox(frame: NSRect(x: 20, y: 50, width: width - 40, height: 1))
        bottomDividerLine.boxType = .custom
        bottomDividerLine.borderWidth = 0
        bottomDividerLine.fillColor = NSColor(white: 1.0, alpha: 0.12)
        visualEffect.addSubview(bottomDividerLine)

        textField.frame = NSRect(x: 20, y: 10, width: width - 40, height: 32)
        textField.font = NSFont.systemFont(ofSize: 14, weight: .regular)
        textField.placeholderString = "Type follow-up instruction... (or press Esc to stop)"
        textField.isHidden = false
        visualEffect.addSubview(textField, positioned: .above, relativeTo: nil)
        panel.makeFirstResponder(textField)

        appendHistory(role: "GOAL", text: query, color: .white, icon: "💬")
        appendHistory(role: "SYSTEM", text: "Task initialized. Preparing execution environment...", color: NSColor(white: 0.6, alpha: 1.0), icon: "⚡")
    }
}

let args = CommandLine.arguments
var mode = "prompt"
var appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Desktop"
var windowTitle = ""
var initialContext: [String: Any]? = nil

for arg in args {
    if arg == "listen" {
        mode = "listen"
    } else if arg.starts(with: "--app=") {
        appName = String(arg.dropFirst(6))
    } else if arg.starts(with: "--window-title=") {
        windowTitle = String(arg.dropFirst(15))
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

    RegisterEventHotKey(
        UInt32(kVK_Space),
        UInt32(cmdKey | shiftKey),
        hotKeyID,
        GetApplicationEventTarget(),
        0,
        &hotKeyRef
    )

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
