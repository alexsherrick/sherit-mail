import AppKit
import AuthenticationServices
import CryptoKit
import WebKit

/// One window holding the web client. Everything the page cannot do inside WKWebView is done here:
/// - Google sign-in: Google refuses OAuth in embedded web views, so /auth/google runs in ASWebAuthenticationSession and the hub
///  hands back a one-time code, exchanged (with a PKCE-style secret) for the session cookie this web view then carries.
/// - Links out of the app open in the default browser; Gmail account connection too (its tokens live on the hub).
/// - The unread badge: the page calls navigator.setAppBadge, which is bridged to the Dock and the menu bar.
/// - File pickers and downloads, which WKWebView leaves to the host app.
final class MainWindowController: NSWindowController, NSWindowDelegate {
    let webView: WKWebView
    var onBadge: ((Int) -> Void)?
    private var authSession: ASWebAuthenticationSession?
    private var loaded = false
    private var queuedPath: String?
    /// Downloads in flight (where each is being written, or why it was refused) and the files written this session, keyed by an
    /// opaque handle the page holds for "Show in Finder". The page never names a path.
    fileprivate var inFlight: [ObjectIdentifier: (name: String, dest: URL?, refused: String?)] = [:]
    fileprivate var saved: [String: URL] = [:]
    fileprivate var savedOrder: [String] = []

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "SheritMac/1.0"   // app.js reads this (NATIVE_MAC) and leaves notifications to us
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: """
            (() => {
              const post = (n) => { try { window.webkit.messageHandlers.badge.postMessage(Number(n) || 0); } catch (_) {} };
              const def = (k, v) => { try { Object.defineProperty(Navigator.prototype, k, { value: v, configurable: true, writable: true }); } catch (_) {} };
              def("setAppBadge", function (n) { post(n); return Promise.resolve(); });
              def("clearAppBadge", function () { post(0); return Promise.resolve(); });
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        webView = WKWebView(frame: .zero, configuration: config)
        #if DEBUG   // Safari's Web Inspector on the app's page: debug builds only
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        #endif
        webView.allowsBackForwardNavigationGestures = false

        // A real title bar above the page, not content running under it. With.fullSizeContentView the web view covered the
        // title bar, so the window could not be dragged (WKWebView takes every mouse-down; it has no app-region:drag) and the
        // traffic lights sat on top of the app's own header . The bar is painted in the page's own
        // background colour (app.html --bg, light and dark) so it reads as part of the app rather than a grey strip.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Sherit Mail"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        let pageBg = NSColor(name: nil) { ap in
            ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0x12 / 255.0, green: 0x13 / 255.0, blue: 0x16 / 255.0, alpha: 1) : .white
        }
        window.backgroundColor = pageBg
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = pageBg }
        window.minSize = NSSize(width: 520, height: 420)
        window.contentView = webView
        window.setFrameAutosaveName("SheritMailMain")
        if !window.setFrameUsingName("SheritMailMain") { window.center() }
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        ucc.add(BadgeBridge(self), name: "badge")
        ucc.add(RevealBridge(self), name: "reveal")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.load(URLRequest(url: HUB))
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: window

    func reveal() { showWindow(nil); window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }   // hide; keep running for notifications
    func reload() { webView.reload() }
    func run(js: String) { webView.evaluateJavaScript(js, completionHandler: nil) }
    func zoom(by d: CGFloat) { webView.pageZoom = max(0.5, min(2.0, webView.pageZoom + d)) }
    func zoom(to z: CGFloat) { webView.pageZoom = z }

    /// Open a path inside the client (a notification's conversation, a pre-filled composer) without reloading the page.
    /// The page opens it FIRST and the window comes forward after, so what appears is the conversation: never the inbox
    /// that was on screen a moment before . The conversation is normally already primed (acceptStash),
    /// so this is milliseconds; a cap keeps a slow fallback from leaving the click looking ignored.
    func open(path: String) {
        guard loaded else { queuedPath = path; reveal(); return }
        var shown = false
        let show = { if !shown { shown = true; self.reveal() } }
        webView.callAsyncJavaScript("if (window.mh && window.mh.openUrl) { await window.mh.openUrl(p); } else { location.href = p; }",
                                    arguments: ["p": path], in: nil, in: .page) { _ in DispatchQueue.main.async(execute: show) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: show)
    }

    /// A conversation downloaded when its notification arrived: into the page's store, its list and its prerender cache.
    func acceptStash(_ stash: [String: Any]) {
        guard loaded else { return }
        webView.callAsyncJavaScript("return (window.mh && window.mh.acceptStash) ? await window.mh.acceptStash(v) : 0",
                                    arguments: ["v": stash], in: nil, in: .page) { r in
            if case .failure(let e) = r { appLog("prime failed: \(e)") } else { appLog("primed \(stash["account"] ?? "")|\(stash["id"] ?? "")") }
        }
    }

    func signOut() {
        let store = webView.configuration.websiteDataStore.httpCookieStore
        store.getAllCookies { cookies in
            let mine = cookies.filter { $0.domain.hasSuffix(HUB.host!) && $0.name == "mh" }
            let group = DispatchGroup()
            for c in mine { group.enter(); store.delete(c) { group.leave() } }
            group.notify(queue: .main) { self.webView.load(URLRequest(url: HUB)) }
        }
    }

    // MARK: sign-in (ASWebAuthenticationSession + one-time code)

    func signIn() {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = b64url(Data(bytes))
        let challenge = b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        var c = URLComponents(url: HUB.appendingPathComponent("auth/google"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "app", value: "1"), URLQueryItem(name: "challenge", value: challenge)]
        let session = ASWebAuthenticationSession(url: c.url!, callbackURLScheme: "sheritmail") { [weak self] callback, error in
            guard let self, let callback, error == nil,
                  let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value
            else { return }
            self.exchange(code: code, verifier: verifier)
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        session.start()
    }

    private func exchange(code: String, verifier: String) {
        var req = URLRequest(url: HUB.appendingPathComponent("auth/app/exchange"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let session = j["session"] as? String else {
                DispatchQueue.main.async { let a = NSAlert(); a.messageText = "Sign-in didn't complete. Try again."; a.runModal() }
                return
            }
            let maxAge = (j["max_age"] as? Double) ?? 30 * 86400
            let cookie = HTTPCookie(properties: [
                .name: "mh", .value: session, .domain: HUB.host!, .path: "/", .secure: "TRUE",
                .expires: Date().addingTimeInterval(maxAge), HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            ])!
            DispatchQueue.main.async {
                self.webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { self.webView.load(URLRequest(url: HUB)) }
            }
        }.resume()
    }

    // MARK: helpers

    fileprivate func badge(_ n: Int) { onBadge?(n) }
    private func jsString(_ s: String) -> String {
        let d = try! JSONSerialization.data(withJSONObject: [s]); let a = String(data: d, encoding: .utf8)!
        return String(a.dropFirst().dropLast())
    }
    private func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func openOutside(_ url: URL) { NSWorkspace.shared.open(url) }
}

extension MainWindowController: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window ?? NSWindow() }
}

extension MainWindowController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "blob", "data", "javascript"].contains(scheme) { return decisionHandler(.allow) }
        // A file dropped where the page does not claim it can be loaded in place of the app (browsers open a dropped file that way).
        // The page takes drops into a draft; this makes sure no other drop replaces it. The app never shows a local file.
        if scheme == "file" { return decisionHandler(.cancel) }
        if scheme == "mailto" { (NSApp.delegate as? AppDelegate)?.application(NSApp, open: [url]); return decisionHandler(.cancel) }
        if url.host == HUB.host {
            if url.path == "/auth/google" { signIn(); return decisionHandler(.cancel) }              // Google refuses embedded web views
            if url.path.hasPrefix("/auth/gmail") { openOutside(url); return decisionHandler(.cancel) } // connect Gmail in the browser
            return decisionHandler(.allow)
        }
        // A web address that is not the hub's never loads in the app, in any frame: the main frame's opens in the
        // browser, and so does a message frame's when it is a click. A message frame used to load it in place: a link with
        // target="_self", which WebKit follows because it runs no page listener inside the mail's frame: the sender's page shown
        // inside the message, in the app's own window. Any other scheme (another app's) is not followed from the page either.
        if ["http", "https"].contains(scheme) {
            if action.targetFrame?.isMainFrame ?? true || action.navigationType == .linkActivated { openOutside(url) }
            return decisionHandler(.cancel)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        NSLog("SheritMail: loaded %@", webView.url?.absoluteString ?? "-")
        if let p = queuedPath { queuedPath = nil; open(path: p) }
        // Diagnostics: SHERIT_DEBUG_SNAPSHOT=/path.png writes what the page shows once it has settled (no screen-recording permission needed).
        if let out = ProcessInfo.processInfo.environment["SHERIT_DEBUG_SNAPSHOT"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                webView.takeSnapshot(with: nil) { img, _ in
                    guard let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return }
                    try? png.write(to: URL(fileURLWithPath: out))
                    NSLog("SheritMail: snapshot written to %@", out)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { NSLog("SheritMail: load failed %@", error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { NSLog("SheritMail: load failed %@", error.localizedDescription) }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

extension MainWindowController: WKUIDelegate {
    /// window.open / target=_blank (every link inside a message body): the default browser, never a second web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            if url.scheme?.lowercased() == "mailto" { (NSApp.delegate as? AppDelegate)?.application(NSApp, open: [url]) } else { openOutside(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = false
        p.beginSheetModal(for: window!) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.beginSheetModal(for: window!) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window!) { r in completionHandler(r == .alertFirstButtonReturn) }
    }
}

extension MainWindowController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        // An error page is not the file: a hub that answers 4xx/5xx is cancelled here, so its JSON is never saved under the file's name.
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            inFlight[ObjectIdentifier(download)] = (suggestedFilename, nil, "the hub answered \(http.statusCode)")
            return completionHandler(nil)
        }
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var dest = dir.appendingPathComponent(suggestedFilename)
        let base = dest.deletingPathExtension().lastPathComponent, ext = dest.pathExtension
        var n = 1
        // A name already taken on disk, or reserved by a download still in flight: two same-name downloads must not share a file.
        let reserved = Set(inFlight.values.compactMap { $0.dest?.path })
        while FileManager.default.fileExists(atPath: dest.path) || reserved.contains(dest.path) { n += 1; dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)") }
        inFlight[ObjectIdentifier(download)] = (suggestedFilename, dest, nil)
        completionHandler(dest)
    }
    // WebKit writes the file from its sandboxed network process and marks it com.apple.quarantine itself (DownloadProxy.cpp keeps the
    // mark and drops only the "hard" flag), so Gatekeeper checks a downloaded program before it first runs. Nothing here opens the file.
    func downloadDidFinish(_ download: WKDownload) {
        guard let f = inFlight.removeValue(forKey: ObjectIdentifier(download)), let dest = f.dest else { return }
        let handle = UUID().uuidString
        saved[handle] = dest; savedOrder.append(handle)
        while savedOrder.count > 50 { saved.removeValue(forKey: savedOrder.removeFirst()) }
        tellPage(["ok": true, "name": dest.lastPathComponent, "id": handle])
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let f = inFlight.removeValue(forKey: ObjectIdentifier(download))
        tellPage(["ok": false, "name": f?.name ?? "the file", "error": f?.refused ?? error.localizedDescription])
    }
    /// window.mhDownloaded(r) in app.js: "Saved to Downloads" with Show in Finder, or the failure. Before this, a save left no sign.
    fileprivate func tellPage(_ r: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: r), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.mhDownloaded && window.mhDownloaded(\(json))", completionHandler: nil)
    }
    /// Show in Finder for a file this app saved this session, named only by the handle the page was given.
    fileprivate func reveal(_ handle: String) {
        guard let url = saved[handle], FileManager.default.fileExists(atPath: url.path) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}

/// Show in Finder. Only the hub's own top-level page may ask, and only by a handle this app gave it.
private final class RevealBridge: NSObject, WKScriptMessageHandler {
    weak var owner: MainWindowController?
    init(_ o: MainWindowController) { owner = o }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        // The whole origin, not just the host: scheme, host and port must all be the hub's.
        let o = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, o.protocol == HUB.scheme, o.host == HUB.host, o.port == (HUB.port ?? 0), let handle = message.body as? String else { return }
        DispatchQueue.main.async { self.owner?.reveal(handle) }
    }
}

/// Held weakly by nothing: WKUserContentController retains its handlers, so this small object breaks the cycle to the window.
private final class BadgeBridge: NSObject, WKScriptMessageHandler {
    weak var owner: MainWindowController?
    init(_ o: MainWindowController) { owner = o }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        let n = (message.body as? NSNumber)?.intValue ?? 0
        DispatchQueue.main.async { self.owner?.badge(n) }
    }
}
