import AppKit
import ServiceManagement
import UserNotifications

let HUB = URL(string: "https://mail.yourdomain.example")!

/// The app's spine: menus, the menu-bar item, open-at-login, default-mail-app, and URL handling (mailto:, sheritmail:).
/// Closing the window hides it; the app keeps running so notifications keep arriving: the way Mail behaves.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var main: MainWindowController!
    var notifier: Notifier!
    var statusItem: NSStatusItem!
    private var unread = 0
    private var pendingURLs: [URL] = []

    func applicationDidFinishLaunching(_ note: Notification) {
        main = MainWindowController()
        notifier = Notifier(main: main)
        NSApp.mainMenu = buildMainMenu()
        buildStatusItem()
        main.onBadge = { [weak self] n in self?.setUnread(n) }
        main.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        notifier.start()
        // Notifications only keep arriving while the app runs, so it opens at login unless the user turns that off. Registered
        // again on every launch while wanted, so the login item follows the copy actually being run (build folder vs /Applications).
        if UserDefaults.standard.object(forKey: "loginItemWanted") == nil { UserDefaults.standard.set(true, forKey: "loginItemWanted") }
        if UserDefaults.standard.bool(forKey: "loginItemWanted") { try? SMAppService.mainApp.register() }
        for url in pendingURLs { handle(url) }
        pendingURLs = []
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        main.reveal()
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard main != nil else { pendingURLs.append(contentsOf: urls); return }
        for url in urls { handle(url) }
    }

    /// mailto:a@b.com,c@d.com?subject=…&body=…&cc=… → the web client's composer, pre-filled.
    private func handle(_ url: URL) {
        guard url.scheme?.lowercased() == "mailto" else { return }
        let raw = url.absoluteString.dropFirst("mailto:".count)
        let parts = raw.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var q = URLComponents()
        var items = [URLQueryItem(name: "compose", value: "1")]
        let to = String(parts.first ?? "").removingPercentEncoding ?? ""
        if !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if parts.count > 1, let extra = URLComponents(string: "x:?" + parts[1])?.queryItems {
            for it in extra {
                let k = it.name.lowercased()
                if ["subject", "body", "cc", "bcc"].contains(k), let v = it.value { items.append(URLQueryItem(name: k, value: v)) }
                if k == "to", let v = it.value { items.append(URLQueryItem(name: "to", value: to.isEmpty ? v : to + ", " + v)) }
            }
        }
        q.path = "/"
        q.queryItems = items
        main.open(path: q.string ?? "/?compose=1")
    }

    // MARK: unread count; Dock badge and menu bar

    func setUnread(_ n: Int) {
        unread = n
        NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        statusItem.button?.title = n > 0 ? " \(n)" : ""
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let b = statusItem.button {
            b.image = NSImage(systemSymbolName: "envelope", accessibilityDescription: "Sherit Mail")
            b.imagePosition = .imageLeading
        }
        let m = NSMenu()
        m.addItem(withTitle: "Open Sherit Mail", action: #selector(openMain), keyEquivalent: "")
        m.addItem(withTitle: "New Message", action: #selector(newMessage), keyEquivalent: "")
        m.addItem(.separator())
        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
        m.addItem(login)
        m.addItem(.separator())
        m.addItem(withTitle: "Quit Sherit Mail", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        m.delegate = self
        statusItem.menu = m
    }

    @objc func openMain() { main.reveal() }
    @objc func newMessage() { main.reveal(); main.open(path: "/?compose=1") }
    @objc func reload() { main.reload() }
    // Find: the page's own bar. The page claims ⌘F itself when its top document has the focus; these reach it when
    // the focus sits inside a message frame, where WebKit runs none of the page's listeners.
    @objc func findInPage() { main.run(js: "window.mh && window.mh.openFind && window.mh.openFind()") }
    @objc func findNext() { main.run(js: "window.mh && window.mh.findStep && window.mh.findStep(1)") }
    @objc func findPrevious() { main.run(js: "window.mh && window.mh.findStep && window.mh.findStep(-1)") }
    @objc func zoomIn() { main.zoom(by: 0.1) }
    @objc func zoomOut() { main.zoom(by: -0.1) }
    @objc func zoomReset() { main.zoom(to: 1.0) }
    @objc func signOutHere() { main.signOut() }

    @objc func toggleLogin(_ sender: NSMenuItem) {
        let on = SMAppService.mainApp.status != .enabled
        UserDefaults.standard.set(on, forKey: "loginItemWanted")
        if on { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
    }

    @objc func makeDefaultMailApp() {
        NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpenURLsWithScheme: "mailto") { error in
            DispatchQueue.main.async {
                let a = NSAlert()
                a.messageText = error == nil ? "Sherit Mail is now your default mail app." : "Couldn't set the default mail app."
                if let error { a.informativeText = error.localizedDescription }
                a.runModal()
            }
        }
    }

    // MARK: menus

    private func buildMainMenu() -> NSMenu {
        let bar = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) { let i = NSMenuItem(); let m = NSMenu(title: title); items.forEach { m.addItem($0) }; i.submenu = m; bar.addItem(i) }
        func item(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i
        }
        let loginItem = item("Open at Login", #selector(toggleLogin(_:)))
        sub("Sherit Mail", [
            item("About Sherit Mail", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            loginItem,
            item("Make Sherit Mail the Default Mail App", #selector(makeDefaultMailApp)),
            item("Sign Out on This Mac", #selector(signOutHere)),
            .separator(),
            item("Hide Sherit Mail", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Sherit Mail", #selector(NSApplication.terminate(_:)), "q"),
        ])
        sub("File", [
            item("New Message", #selector(newMessage), "n"),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        sub("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            item("Find…", #selector(findInPage), "f"),
            item("Find Next", #selector(findNext), "g"),
            item("Find Previous", #selector(findPrevious), "g", [.command, .shift]),
        ])
        sub("View", [
            item("Reload", #selector(reload), "r"),
            .separator(),
            item("Actual Size", #selector(zoomReset), "0"),
            item("Zoom In", #selector(zoomIn), "="),
            item("Zoom Out", #selector(zoomOut), "-"),
        ])
        let win = [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ]
        sub("Window", win)
        NSApp.windowsMenu = bar.items.last?.submenu
        bar.items.first?.submenu?.delegate = self
        return bar
    }
}

extension AppDelegate: NSMenuDelegate {
    /// Keep the "Open at Login" checkmark truthful wherever it appears.
    func menuNeedsUpdate(_ menu: NSMenu) {
        for i in menu.items where i.action == #selector(toggleLogin(_:)) {
            i.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
    }
}
