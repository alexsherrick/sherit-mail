import AppKit
import UserNotifications
import WebKit

/// Native notifications without Web Push. Apple gives WKWebView no Push API, so the app reads the hub's notification feed
/// (GET /api/notify/feed, migration 0026) with the same session cookie the web view carries: every 20 seconds while running,
/// and at once on wake. Each mail notification uses the web client's tag, `t-<account>|<thread>`, so a follow-up replaces
/// rather than stacks, and a dismissal from another device removes exactly that one.
/// ~/Library/Logs/SheritMail.log: NSLog from this app does not reach `log show`, and notification delivery is the one thing
/// that cannot be checked from outside the app. Kept small: rotated at 256 KB.
func appLog(_ msg: String) {
    let url = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs/SheritMail.log")
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(msg)\n"
    if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path), (attrs[.size] as? Int ?? 0) > 262_144 { try? FileManager.default.removeItem(at: url) }
    if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
    else { try? line.data(using: .utf8)!.write(to: url) }
}

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private weak var main: MainWindowController?
    private var timer: Timer?
    private var polling = false
    private let center = UNUserNotificationCenter.current()
    private var cursor: Int? {
        get { UserDefaults.standard.object(forKey: "feedCursor") as? Int }
        set { UserDefaults.standard.set(newValue, forKey: "feedCursor") }
    }

    init(main: MainWindowController) { self.main = main; super.init() }

    func start() {
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, err in appLog("notifications \(granted ? "allowed" : "NOT allowed") \(err.map { "\($0)" } ?? "")") }
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.poll() }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self?.poll() }   // the network comes back a moment after the lid opens
        }
        poll()
    }

    func poll() {
        guard !polling, let main else { return }
        polling = true
        main.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            guard let mh = cookies.first(where: { $0.name == "mh" && $0.domain.hasSuffix(HUB.host!) }) else { self.polling = false; return }
            var c = URLComponents(url: HUB.appendingPathComponent("api/notify/feed"), resolvingAgainstBaseURL: false)!
            if let cur = self.cursor { c.queryItems = [URLQueryItem(name: "since", value: String(cur))] }   // none yet: the hub answers "now"
            var req = URLRequest(url: c.url!)
            req.setValue("mh=\(mh.value)", forHTTPHeaderField: "Cookie")
            req.timeoutInterval = 15
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                defer { DispatchQueue.main.async { self.polling = false } }
                guard (resp as? HTTPURLResponse)?.statusCode == 200, let data,
                      let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                let items = j["items"] as? [[String: Any]] ?? []
                NSLog("SheritMail: feed cursor %@, %d item(s)", String(describing: j["cursor"] ?? "-"), items.count)
                DispatchQueue.main.async {
                    for it in items { self.apply(it) }
                    if let next = j["cursor"] as? Int { self.cursor = next }
                }
            }.resume()
        }
    }

    private func apply(_ it: [String: Any]) {
        let kind = it["kind"] as? String ?? ""
        if kind == "dismiss" {
            let ids = (it["dismiss"] as? [[String: Any]] ?? []).compactMap { $0["k"] as? String }.map { "t-" + $0 }
            center.getDeliveredNotifications { before in
                appLog("dismiss \(ids); delivered before: \(before.map { $0.request.identifier })")
                self.center.removeDeliveredNotifications(withIdentifiers: ids)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.center.getDeliveredNotifications { after in appLog("delivered after: \(after.map { $0.request.identifier })") }
                }
            }
            return
        }
        guard let title = it["title"] as? String, !title.isEmpty else { return }
        let account = it["account"] as? String ?? kind
        let id: String
        if let thread = it["thread"] as? String { id = "t-\(account)|\(thread)" } else { id = "\(kind)-\(account)" }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = it["body"] as? String ?? ""
        content.sound = .default
        content.threadIdentifier = account
        content.userInfo = ["url": it["url"] as? String ?? "/"]
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { err in appLog("posted \(id)\(err.map { " ERROR \($0)" } ?? "")") }
        if let thread = it["thread"] as? String, ["gmail", "hub", "imap"].contains(kind) { prefetch(kind: kind, account: account, thread: thread) }
    }

    /// The conversation behind a notification, downloaded now (the same fetch sw.js and the Android app make) and handed to
    /// the page, which adopts and prerenders it. By the time the banner is clicked there is nothing left to load.
    /// keep_unread=1: a background fetch must not mark the mail read.
    private func prefetch(kind: String, account: String, thread: String) {
        main?.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self, let mh = cookies.first(where: { $0.name == "mh" && $0.domain.hasSuffix(HUB.host!) }) else { return }
            func req(_ url: URL, post: Bool = false, bearer: String? = nil) -> URLRequest {
                var r = URLRequest(url: url); r.timeoutInterval = 20
                if post { r.httpMethod = "POST" }
                if let bearer { r.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
                else { r.setValue("mh=\(mh.value)", forHTTPHeaderField: "Cookie"); r.setValue(HUB.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin") }
                return r
            }
            let enc = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/@"))) ?? s }
            let hand = { (data: Data?) in
                guard let data, let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { appLog("prefetch \(account)|\(thread) failed"); return }
                DispatchQueue.main.async { self.main?.acceptStash(["kind": kind, "account": account, "id": thread, "raw": raw, "at": Date().timeIntervalSince1970 * 1000]) }
            }
            if kind == "gmail" {
                URLSession.shared.dataTask(with: req(HUB.appendingPathComponent("api/gmail/accounts/\(account)/token"), post: true)) { data, resp, _ in
                    guard (resp as? HTTPURLResponse)?.statusCode == 200, let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let at = j["access_token"] as? String, let u = URL(string: "https://gmail.googleapis.com/gmail/v1/users/me/threads/\(enc(thread))?format=full") else { hand(nil); return }
                    URLSession.shared.dataTask(with: req(u, bearer: at)) { d, r, _ in hand((r as? HTTPURLResponse)?.statusCode == 200 ? d : nil) }.resume()
                }.resume()
            } else if let u = URL(string: "\(HUB.absoluteString)/api/threads/\(enc(thread))?keep_unread=1") {
                URLSession.shared.dataTask(with: req(u)) { d, r, _ in hand((r as? HTTPURLResponse)?.statusCode == 200 ? d : nil) }.resume()
            }
        }
    }

    // While the window is in front the list is already updating itself; a banner on top of it is noise.
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        let inFront = NSApp.isActive && (main?.window?.isVisible ?? false)
        done(inFront ? [.list] : [.banner, .list, .sound])
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let path = r.notification.request.content.userInfo["url"] as? String ?? "/"
        DispatchQueue.main.async { self.main?.open(path: path) }
        done()
    }
}
