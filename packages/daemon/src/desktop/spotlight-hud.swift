import AppKit
import Foundation

class SpotlightPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var panel: SpotlightPanel!
    var textField: NSTextField!
    var targetApp: String = "Desktop"

    init(targetApp: String) {
        self.targetApp = targetApp
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupUI()
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

        let visualEffect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        visualEffect.material = .hudWindow
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.wantsLayer = true
        visualEffect.layer?.cornerRadius = 18
        visualEffect.layer?.masksToBounds = true
        visualEffect.layer?.borderWidth = 1
        visualEffect.layer?.borderColor = NSColor(white: 1.0, alpha: 0.15).cgColor

        let badge = NSTextField(labelWithString: targetApp.uppercased())
        badge.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        badge.textColor = NSColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1.0)
        badge.frame = NSRect(x: 24, y: height - 26, width: 260, height: 16)
        visualEffect.addSubview(badge)

        textField = NSTextField(frame: NSRect(x: 22, y: 14, width: width - 44, height: 40))
        textField.isBordered = false
        textField.drawsBackground = false
        textField.focusRingType = .none
        textField.font = NSFont.systemFont(ofSize: 18, weight: .medium)
        textField.textColor = .white
        textField.placeholderString = "Ask anything or type a goal... (e.g. how to upload a file)"
        textField.delegate = self
        visualEffect.addSubview(textField)

        panel.contentView = visualEffect
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(textField)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let text = textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                let dict: [String: String] = ["query": text, "app": targetApp]
                if let data = try? JSONSerialization.data(withJSONObject: dict),
                   let json = String(data: data, encoding: .utf8) {
                    print(json)
                    exit(0)
                }
            }
            exit(1)
        } else if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            exit(1)
        }
        return false
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

if mode == "listen" {
    var isPromptOpen = false
    NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 49 && flags.contains(.command) && flags.contains(.shift) {
            if isPromptOpen { return }
            isPromptOpen = true
            let frontApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Desktop"
            let pipe = Pipe()
            let process = Process()
            var execURL = URL(fileURLWithPath: CommandLine.arguments[0])
            var execArgs = ["prompt", "--app=\(frontApp)"]
            if CommandLine.arguments[0].hasSuffix("swift") && CommandLine.arguments.count > 1 {
                execURL = URL(fileURLWithPath: CommandLine.arguments[0])
                execArgs = [CommandLine.arguments[1], "prompt", "--app=\(frontApp)"]
            }
            process.executableURL = execURL
            process.arguments = execArgs
            process.standardOutput = pipe
            try? process.run()
            process.waitUntilExit()
            isPromptOpen = false
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !output.isEmpty {
                print(output)
                fflush(stdout)
            }
        }
    }
    app.run()
} else {
    let delegate = AppDelegate(targetApp: appName)
    app.delegate = delegate
    app.run()
}
