import AppKit
import Foundation
import Carbon

class HudActionButton: NSButton {
    override var mouseDownCanMoveWindow: Bool { false }
}

class SpotlightPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.keyCode == 53 {
            if let delegate = NSApp.delegate as? AppDelegate {
                if delegate.isWorking {
                    delegate.onStopClicked()
                } else {
                    delegate.onCancelClicked()
                }
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
                    delegate.onCancelClicked()
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
            if delegate.isWorking {
                delegate.onStopClicked()
            } else {
                delegate.onCancelClicked()
            }
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var panel: SpotlightPanel!
    var visualEffect: NSVisualEffectView!
    var textField: NSTextField!
    var badge: NSTextField!
    var statusPill: NSTextField!
    var stopButton: HudActionButton!
    var closeButton: HudActionButton!
    var topDividerLine: NSBox!
    var bottomDividerLine: NSBox!
    var historyScrollView: NSScrollView!
    var historyTextView: NSTextView!
    var targetApp: String = "Desktop"
    var isWorking: Bool = false
    var isExpanded: Bool = false

    init(targetApp: String) {
        self.targetApp = targetApp
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        setupUI()
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
        visualEffect.layer?.cornerRadius = 18
        visualEffect.layer?.masksToBounds = true
        visualEffect.layer?.borderWidth = 1
        visualEffect.layer?.borderColor = NSColor(white: 1.0, alpha: 0.15).cgColor

        badge = NSTextField(labelWithString: targetApp.uppercased())
        badge.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        badge.textColor = NSColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1.0)
        badge.frame = NSRect(x: 24, y: height - 26, width: width - 80, height: 16)
        visualEffect.addSubview(badge)

        closeButton = HudActionButton(frame: NSRect(x: width - 44, y: height - 30, width: 26, height: 24))
        closeButton.title = "✕"
        closeButton.bezelStyle = .regularSquare
        closeButton.isBordered = false
        closeButton.wantsLayer = true
        closeButton.layer?.cornerRadius = 12
        closeButton.layer?.masksToBounds = true
        closeButton.font = NSFont.systemFont(ofSize: 14, weight: .bold)
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
        textField.font = NSFont.systemFont(ofSize: 18, weight: .medium)
        textField.textColor = .white
        textField.placeholderString = "Ask anything or type a goal... (e.g. check open tabs, create campaign)"
        textField.isEditable = true
        textField.isSelectable = true
        textField.delegate = self
        visualEffect.addSubview(textField)

        panel.contentView = visualEffect
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(textField)
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
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let text = textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                textField.stringValue = ""
                let dict: [String: String] = ["event": "submit", "query": text, "app": targetApp]
                if let data = try? JSONSerialization.data(withJSONObject: dict),
                   let json = String(data: data, encoding: .utf8) {
                    print(json)
                    fflush(stdout)
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
            if isWorking {
                onStopClicked()
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

    func transitionToProgress(query: String) {
        isExpanded = true
        isWorking = true
        let newHeight: CGFloat = 440
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let width: CGFloat = 680
        let x = (screen.frame.width - width) / 2
        let y = screen.frame.height * 0.65 - (newHeight - 84)

        panel.setFrame(NSRect(x: x, y: y, width: width, height: newHeight), display: true, animate: true)
        visualEffect.frame = NSRect(x: 0, y: 0, width: width, height: newHeight)

        badge.stringValue = targetApp.uppercased()
        badge.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        badge.textColor = NSColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1.0)
        badge.frame = NSRect(x: 20, y: newHeight - 32, width: 200, height: 18)

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

        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                FileHandle.standardInput.readabilityHandler = nil
                return
            }
            guard let text = String(data: data, encoding: .utf8) else { return }
            let lines = text.split(separator: "\n")
            for line in lines {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty,
                      let jsonData = trimmed.data(using: .utf8),
                      let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    guard let self = self else { return }
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
                        self.isWorking = false
                        self.statusPill.stringValue = "⚠ FAILED"
                        self.statusPill.textColor = .systemYellow
                        self.stopButton.isHidden = true
                        self.appendHistory(role: role ?? "ERROR", text: text.isEmpty ? "Task failed." : text, color: .systemRed, icon: "⚠")
                        self.panel.makeFirstResponder(self.textField)
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
}

let args = CommandLine.arguments
var mode = "prompt"
var appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Desktop"

for arg in args {
    if arg == "listen" {
        mode = "listen"
    } else if arg.starts(with: "--app=") {
        appName = String(arg.dropFirst(6))
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
    print("{\"event\":\"hotkey\",\"app\":\"\(frontApp)\"}")
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
    let delegate = AppDelegate(targetApp: appName)
    app.delegate = delegate
    app.run()
}
