//! Everything the shell decides without touching Windows: launch arguments, mailto: links, notification tags and toast XML,
//! the sign-in secret, the scripts handed to the page. Platform-free, so `cargo test` checks it on any machine.

use base64::Engine;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};

pub const HUB: &str = "https://mail.yourdomain.example";
pub const HUB_HOST: &str = "mail.yourdomain.example";
/// The AppUserModelID. Tauri's installer stamps it on the Start-menu shortcut (`SetLnkAppUserModelId` with the bundle
/// identifier), and Windows only shows toasts from an unpackaged app whose ID a shortcut carries.
pub const AUMID: &str = "com.sheritlabs.mail";
/// HKCU\Software\RegisteredApplications value name, and what `ms-settings:defaultapps?registeredAppUser=` is given.
pub const REG_APP: &str = "Sherit Mail";

/// Path segments: everything but unreserved characters is escaped, `/` and `@` included (an account id is an address).
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

pub fn enc(s: &str) -> String {
    utf8_percent_encode(s, SEGMENT).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn strip_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// mailto:a@b.com,c@d.com?subject=…&body=…&cc=… → the web client's composer, pre-filled: "/?compose=1&to=…&subject=…".
/// RFC 6068 percent-encodes the address list and every value, and a `+` there is a literal plus, so values are
/// percent-decoded only (never form-decoded) and re-encoded for URLSearchParams, which the client reads them with.
pub fn mailto_path(raw: &str) -> String {
    let rest = strip_ci(raw, "mailto:").unwrap_or(raw);
    let (head, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut to = dec(head).trim().to_string();
    let mut extra: Vec<(String, String)> = Vec::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (k, v) = (dec(k).to_ascii_lowercase(), dec(v));
        match k.as_str() {
            "to" if !v.trim().is_empty() => to = if to.is_empty() { v.trim().to_string() } else { format!("{to}, {}", v.trim()) },
            "subject" | "body" | "cc" | "bcc" => extra.push((k, v)),
            _ => {}
        }
    }
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("compose", "1");
    if !to.is_empty() {
        q.append_pair("to", &to);
    }
    for (k, v) in &extra {
        q.append_pair(k, v);
    }
    format!("/?{}", q.finish())
}

/// A path inside the client, or None. Only same-origin paths: a launch argument can come from any program or web page.
pub fn safe_path(p: &str) -> Option<String> {
    if !p.starts_with('/') || p.starts_with("//") || p.contains('\\') || p.chars().any(|c| c.is_control()) {
        return None;
    }
    let u = url::Url::parse(HUB).ok()?.join(p).ok()?;
    if u.scheme() != "https" || u.host_str() != Some(HUB_HOST) {
        return None;
    }
    let mut out = u.path().to_string();
    if let Some(q) = u.query() {
        out.push('?');
        out.push_str(q);
    }
    if let Some(f) = u.fragment() {
        out.push('#');
        out.push_str(f);
    }
    Some(out)
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Cmd {
    /// Started at login: stay in the tray.
    Hidden,
    /// Bring the window forward (a plain second launch, the jump list's parent entry).
    Reveal,
    /// A client path to open: a composer from mailto: or the jump list, a conversation from a toast.
    Open(String),
    /// The end of browser sign-in: the hub's one-time code.
    Auth(String),
    /// A toast button: Done, Mark read, Trash, Stop these or Snooze (TOAST_ACTS).
    Act { action: String, account: String, thread: String, key: String },
    /// A finished download: open it, or show it in its folder.
    File { path: String, reveal: bool },
}

fn valid_code(s: &str) -> bool {
    (20..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// One launch argument → what to do. `link_key` is this install's random token: every sheritmail:// link the app writes into
/// a toast carries it, so a web page or another program that fires sheritmail://act or sheritmail://open is ignored. The
/// sign-in code needs no token: it is worthless without the verifier only this process holds.
pub fn parse_arg(arg: &str, link_key: &str) -> Option<Cmd> {
    let arg = arg.trim();
    match arg {
        "--hidden" => return Some(Cmd::Hidden),
        "--compose" => return Some(Cmd::Open("/?compose=1".into())),
        _ => {}
    }
    if strip_ci(arg, "mailto:").is_some() {
        return Some(Cmd::Open(mailto_path(arg)));
    }
    strip_ci(arg, "sheritmail:")?;
    let u = url::Url::parse(arg).ok()?;
    // sheritmail://auth?… has the verb as its host; sheritmail:auth?… as its path.
    let verb = u.host_str().map(str::to_string).unwrap_or_else(|| u.path().trim_matches('/').to_string());
    let q = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    if verb == "auth" {
        return q("code").filter(|c| valid_code(c)).map(Cmd::Auth);
    }
    if link_key.is_empty() || q("s").as_deref() != Some(link_key) {
        return None;
    }
    match verb.as_str() {
        "reveal" => Some(Cmd::Reveal),
        "open" => q("u").and_then(|p| safe_path(&p)).map(Cmd::Open),
        "act" => {
            let action = q("a").filter(|a| TOAST_ACTS.iter().any(|(k, _)| k == a))?;
            let account = q("acct").filter(|a| !a.is_empty() && a.len() <= 254 && !a.chars().any(|c| c.is_control()))?;
            let thread = q("t").filter(|t| (6..=40).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))?;
            Some(Cmd::Act { action, account, thread, key: q("k").unwrap_or_default() })
        }
        // Quoted into Explorer's /select,"…" argument, so a quote or a control character is refused outright.
        "file" => q("p")
            .filter(|p| !p.is_empty() && !p.contains('"') && !p.chars().any(|c| c.is_control()))
            .map(|path| Cmd::File { path, reveal: q("r").as_deref() == Some("1") }),
        _ => None,
    }
}

/// What every launch path reduces to, in order: the first that is not Hidden decides; nothing at all means Reveal.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I, link_key: &str) -> Vec<Cmd> {
    args.into_iter().filter_map(|a| parse_arg(&a, link_key)).collect()
}

/// The buttons a toast can carry, with the labels the Android app gives them (Notify.kt BUTTONS). Each is one POST
/// /api/notify/act. Reply is not here: it is typed into the notification, and every button of this app's toasts is a protocol
/// link, which launches the fixed `arguments` string written when the toast was made (toast schema, <action>), so there is
/// nowhere for typed text to go.
pub const TOAST_ACTS: [(&str, &str); 5] = [("done", "Done"), ("read", "Mark read"), ("trash", "Trash"), ("quiet", "Stop these"), ("snooze", "Snooze")];

/// The user's buttons from the feed (`acts`, Settings → Buttons on notifications), in that order: the ones a toast can carry,
/// each once, at most three, as on the phone. A hub that names none (older than this app): Done and Mark read, as before.
pub fn toast_buttons(acts: Option<&[String]>) -> Vec<(&'static str, &'static str)> {
    let Some(acts) = acts else { return TOAST_ACTS[..2].to_vec() };
    let mut out: Vec<(&'static str, &'static str)> = Vec::new();
    for a in acts {
        if let Some(b) = TOAST_ACTS.iter().find(|(k, _)| k == a) {
            if !out.contains(b) && out.len() < 3 {
                out.push(*b);
            }
        }
    }
    out
}

/// No keyboard or mouse input for this long and the user is away: new mail joins one summary toast instead of a toast each.
pub const AWAY_IDLE_SECS: u64 = 5 * 60;
/// A poll this long after the last good one follows a sleep (or a network outage): what it brings is a backlog.
pub const BACKLOG_GAP_SECS: u64 = 120;

/// Whether this poll's new mail goes into the summary toast: the user is away, the PC just woke up (the first poll after a
/// sleep brings everything that came in meanwhile, and the key pressed to wake it says nothing about who is there), or more
/// than three arrived at once. A PC left on overnight posted a toast a conversation for two hours, and Windows kept every one
/// (Many messages at once each raised a notification; they are now stacked into one).
pub fn batch_poll(fresh: usize, idle_secs: u64, gap_secs: u64) -> bool {
    fresh > 0 && (idle_secs >= AWAY_IDLE_SECS || gap_secs > BACKLOG_GAP_SECS || fresh > 3)
}

/// The summary toast for (sender, subject) pairs, newest first: "3 new messages", the newest one, then who else wrote.
pub fn summary_text(entries: &[(String, String)]) -> (String, String, String) {
    let title = format!("{} new message{}", entries.len(), if entries.len() == 1 { "" } else { "s" });
    let Some((sender, subject)) = entries.first() else { return (title, String::new(), String::new()) };
    let newest = if subject.is_empty() { sender.clone() } else { format!("{sender}: {subject}") };
    let mut others: Vec<&str> = Vec::new();
    for (s, _) in &entries[1..] {
        if !others.contains(&s.as_str()) {
            others.push(s);
        }
    }
    let also = match others.len() {
        0 => String::new(),
        1..=3 => format!("Also from {}", join_and(&others)),
        n => format!("Also from {}, {}, {} and {} others", others[0], others[1], others[2], n - 3),
    };
    (title, newest, also)
}

fn join_and(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [a] => a.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The day after (y, m, d) in the proleptic Gregorian calendar: Snooze is until 8 in the morning tomorrow, as on the phone.
pub fn next_day(y: i64, m: u32, d: u32) -> (i64, u32, u32) {
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let len = match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if d < len {
        (y, m, d + 1)
    } else if m < 12 {
        (y, m + 1, 1)
    } else {
        (y + 1, 1, 1)
    }
}

/// The web client's notification key: `<account>|<thread>` for mail, `<kind>-<account>` otherwise (sw.js, Notify.kt).
pub fn notif_key(kind: &str, account: &str, thread: &str) -> String {
    if thread.is_empty() { format!("{kind}-{account}") } else { format!("{account}|{thread}") }
}

/// The toast tag for a key. Windows caps a tag at 64 characters and a key can be longer (an IMAP address plus a thread id),
/// so the tag is a hash of it: the same on show and on dismiss.
pub fn toast_tag(key: &str) -> String {
    hex(&Sha256::digest(key.as_bytes()))[..32].to_string()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn xml_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            // XML 1.0 has no representation for most control characters; a stray one would make LoadXml refuse the toast.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => o.push(' '),
            c => o.push(c),
        }
    }
    o
}

/// A sheritmail:// link the app writes into its own toasts.
pub fn link(verb: &str, link_key: &str, params: &[(&str, &str)]) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("s", link_key);
    for (k, v) in params {
        q.append_pair(k, v);
    }
    format!("sheritmail://{verb}?{}", q.finish())
}

pub struct Toast<'a> {
    pub title: &'a str,
    pub lines: Vec<&'a str>,
    pub launch: String,
    pub actions: Vec<(&'a str, String)>,
    pub sound: bool,
}

/// Toast XML. Every click is protocol-activated, so it reaches the running app through the single-instance hand-off with no
/// COM activator to register, and it still works from Notification Center after the app has restarted.
pub fn toast_xml(t: &Toast) -> String {
    let mut x = format!(r#"<toast launch="{}" activationType="protocol"><visual><binding template="ToastGeneric">"#, xml_escape(&t.launch));
    x.push_str(&format!(r#"<text hint-maxLines="1">{}</text>"#, xml_escape(t.title)));
    for l in t.lines.iter().filter(|l| !l.trim().is_empty()).take(2) {
        x.push_str(&format!("<text>{}</text>", xml_escape(l.trim())));
    }
    x.push_str("</binding></visual>");
    if !t.actions.is_empty() {
        x.push_str("<actions>");
        for (label, arg) in &t.actions {
            x.push_str(&format!(r#"<action content="{}" activationType="protocol" arguments="{}"/>"#, xml_escape(label), xml_escape(arg)));
        }
        x.push_str("</actions>");
    }
    x.push_str(if t.sound { r#"<audio src="ms-winsoundevent:Notification.Mail"/>"# } else { r#"<audio silent="true"/>"# });
    x.push_str("</toast>");
    x
}

/// A feed item's body is "subject\nsnippet…" (the hub's notification payload): the subject, then the rest on one line.
pub fn split_body(body: &str) -> (String, String) {
    let mut it = body.split('\n');
    let subject = it.next().unwrap_or("").trim().to_string();
    let rest = it.map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    (subject, rest)
}

pub fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

pub fn random_token(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("OS random source");
    b64url(&b)
}

/// The sign-in secret and its challenge: base64url SHA-256, 43 characters; what the hub's /auth/google?app=1 accepts.
pub fn pkce() -> (String, String) {
    let verifier = random_token(32);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn sign_in_url(challenge: &str) -> String {
    format!("{HUB}/auth/google?app=1&challenge={challenge}")
}

/// A JS string literal for any Rust string (JSON is valid JS, U+2028/9 included since ES2019).
pub fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// The exchange runs inside the page, on the hub's own origin: the hub answers with the `mh` cookie, so the web view stores
/// it with exactly the attributes the hub chose and nothing native has to copy a session around.
pub fn exchange_js(code: &str, verifier: &str) -> String {
    format!(
        r#"(async () => {{ try {{ const r = await fetch("/auth/app/exchange", {{ method: "POST", credentials: "same-origin", headers: {{ "content-type": "application/json" }}, body: JSON.stringify({{ code: {}, verifier: {} }}) }}); if (!r.ok) throw new Error(String(r.status)); location.replace("/"); }} catch (e) {{ alert("Sign-in didn't complete. Try again."); }} }})()"#,
        js(code),
        js(verifier)
    )
}

/// Open a client path without reloading, then tell the app (`opened`) so the window comes forward on the conversation itself,
/// never on the inbox that was showing a moment before (the Mac app's order).
pub fn open_js(path: &str) -> String {
    format!(
        r#"(async () => {{ const p = {}; try {{ if (window.mh && window.mh.openUrl) await window.mh.openUrl(p); else location.href = p; }} catch (_) {{ location.href = p; }} finally {{ try {{ window.__TAURI_INTERNALS__.invoke("opened"); }} catch (_) {{}} }} }})()"#,
        js(path)
    )
}

/// A toast button's action, done by the hub, shown in the page as if done there (app.js actedElsewhere): it is not sent again.
pub fn acted_js(key: &str, action: &str) -> String {
    format!("window.mh && window.mh.actedElsewhere && window.mh.actedElsewhere({}, {})", js(key), js(action))
}

/// Main frame only, at document start, on the hub's origin only: the page's badge calls reach the taskbar.
pub const PAGE_SCRIPT: &str = r#"(() => {
  if (location.origin !== "https://mail.yourdomain.example") return;
  const inv = (c, a) => { try { return window.__TAURI_INTERNALS__.invoke(c, a); } catch (_) { return Promise.resolve(); } };
  const def = (k, v) => { try { Object.defineProperty(Navigator.prototype, k, { value: v, configurable: true, writable: true }); } catch (_) {} };
  def("setAppBadge", function (n) { inv("badge", { n: Math.max(0, Math.floor(Number(n) || 0)) }); return Promise.resolve(); });
  def("clearAppBadge", function () { inv("badge", { n: 0 }); return Promise.resolve(); });
})();"#;

/// WebView2's own user agent with the app's token appended. app.js reads `SheritWindows/` (NATIVE_WINDOWS) and leaves
/// notifications to the app; the hub's speed reports file it under "windows".
pub fn user_agent(webview_version: &str, app_version: &str) -> String {
    let major = webview_version.split('.').next().filter(|m| !m.is_empty() && m.bytes().all(|b| b.is_ascii_digit())).unwrap_or("140");
    format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0 SheritWindows/{app_version}")
}

/// UTC "2026-10-05T21:52:00Z" from Unix seconds (Howard Hinnant's civil_from_days), for the log without a date crate.
pub fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailto_simple_and_rich() {
        assert_eq!(mailto_path("mailto:a@b.com"), "/?compose=1&to=a%40b.com");
        assert_eq!(
            mailto_path("MAILTO:a@b.com,c@d.com?subject=Hi%20there&body=1%2B1%3D2&cc=x@y.z&foo=bar"),
            "/?compose=1&to=a%40b.com%2Cc%40d.com&subject=Hi+there&body=1%2B1%3D2&cc=x%40y.z"
        );
        // RFC 6068: a literal + in a value stays a plus.
        assert_eq!(mailto_path("mailto:?to=a@b.com&subject=C++"), "/?compose=1&to=a%40b.com&subject=C%2B%2B");
        assert_eq!(mailto_path("mailto:a@b.com?to=c@d.com"), "/?compose=1&to=a%40b.com%2C+c%40d.com");
        assert_eq!(mailto_path("mailto:"), "/?compose=1");
    }

    #[test]
    fn paths_stay_on_the_hub() {
        assert_eq!(safe_path("/?account=hub&thread=abc").as_deref(), Some("/?account=hub&thread=abc"));
        assert_eq!(safe_path("/").as_deref(), Some("/"));
        for bad in ["//evil.com/x", "https://evil.com/", "javascript:alert(1)", "/\\evil.com", "x", "", "/a\nb"] {
            assert_eq!(safe_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn launch_arguments() {
        let s = "LINKKEY";
        assert_eq!(parse_arg("--hidden", s), Some(Cmd::Hidden));
        assert_eq!(parse_arg("--compose", s), Some(Cmd::Open("/?compose=1".into())));
        assert_eq!(parse_arg("mailto:a@b.com", s), Some(Cmd::Open("/?compose=1&to=a%40b.com".into())));
        let code = "A".repeat(43);
        assert_eq!(parse_arg(&format!("sheritmail://auth?code={code}"), s), Some(Cmd::Auth(code.clone())));
        assert_eq!(parse_arg(&format!("sheritmail:auth?code={code}"), s), Some(Cmd::Auth(code)));
        assert_eq!(parse_arg("sheritmail://auth?code=short", s), None);
        // Bringing the window forward needs the key too: a web page cannot pull the app in front of the user.
        assert_eq!(parse_arg("sheritmail://reveal", s), None);
        assert_eq!(parse_arg(&link("reveal", s, &[]), s), Some(Cmd::Reveal));
        // A path for Explorer never carries a quote.
        assert_eq!(parse_arg(&link("file", s, &[("p", r#"C:\Users\x\Downloads\a" /root,"C:\"#)]), s), None);
        assert_eq!(
            parse_arg(&link("file", s, &[("p", r"C:\Users\x\Downloads\a.pdf"), ("r", "1")]), s),
            Some(Cmd::File { path: r"C:\Users\x\Downloads\a.pdf".into(), reveal: true })
        );
        // Toast links carry the link key; without it nothing happens.
        let open = link("open", s, &[("u", "/?account=hub&thread=1")]);
        assert_eq!(parse_arg(&open, s), Some(Cmd::Open("/?account=hub&thread=1".into())));
        assert_eq!(parse_arg(&open, "OTHER"), None);
        assert_eq!(parse_arg("sheritmail://open?u=/", s), None);
        assert_eq!(parse_arg(&link("open", s, &[("u", "//evil.com")]), s), None);
        let act = link("act", s, &[("a", "done"), ("acct", "sam@gmail.com"), ("t", "18f2a3b4c5d6e7f8"), ("k", "sam@gmail.com|18f2a3b4c5d6e7f8")]);
        assert_eq!(
            parse_arg(&act, s),
            Some(Cmd::Act { action: "done".into(), account: "sam@gmail.com".into(), thread: "18f2a3b4c5d6e7f8".into(), key: "sam@gmail.com|18f2a3b4c5d6e7f8".into() })
        );
        assert_eq!(parse_arg(&link("act", s, &[("a", "delete"), ("acct", "x"), ("t", "abcdef")]), s), None);
        assert_eq!(parse_arg(&link("act", s, &[("a", "reply"), ("acct", "x"), ("t", "abcdef")]), s), None);
        for a in ["trash", "quiet", "snooze"] {
            assert!(matches!(parse_arg(&link("act", s, &[("a", a), ("acct", "hub"), ("t", "0123456789abcdef")]), s), Some(Cmd::Act { action, .. }) if action == a));
        }
        assert_eq!(parse_arg(&link("act", s, &[("a", "done"), ("acct", "x"), ("t", "../../x")]), s), None);
        assert_eq!(parse_arg("C:\\Program Files\\x.exe", s), None);
        assert_eq!(parse_arg("http://evil.com", s), None);
        assert_eq!(parse_arg(&link("open", "", &[("u", "/")]), ""), None);
    }

    #[test]
    fn tags_fit_and_match() {
        let k = notif_key("imap", "someone.with.a.long.name@a-very-long-company-domain.example.com", "0123456789abcdef0123456789abcdef");
        assert_eq!(toast_tag(&k).len(), 32);
        assert_eq!(toast_tag(&k), toast_tag(&k.clone()));
        assert_ne!(toast_tag("a|1"), toast_tag("a|2"));
        assert_eq!(notif_key("test", "hub", ""), "test-hub");
    }

    #[test]
    fn toast_xml_is_escaped() {
        let t = Toast {
            title: "Tom & \"Jerry\" <tj@x.com>",
            lines: vec!["Re: 1 < 2", "", "body\u{1}text"],
            launch: "sheritmail://open?s=a&u=%2F".into(),
            actions: vec![("Done", "sheritmail://act?s=a&a=done".into())],
            sound: true,
        };
        let x = toast_xml(&t);
        assert!(x.contains(r#"launch="sheritmail://open?s=a&amp;u=%2F""#));
        assert!(x.contains("Tom &amp; &quot;Jerry&quot; &lt;tj@x.com&gt;"));
        assert!(x.contains("<text>Re: 1 &lt; 2</text><text>body text</text>"));
        assert!(x.contains(r#"arguments="sheritmail://act?s=a&amp;a=done""#));
        assert!(x.contains("Notification.Mail"));
    }

    #[test]
    fn when_mail_is_summed_up() {
        // At the PC, a few at a time: a toast each.
        assert!(!batch_poll(1, 10, 20));
        assert!(!batch_poll(3, 299, 40));
        // Away five minutes, the first poll after a sleep, or more than three at once: the summary.
        assert!(batch_poll(1, 300, 20));
        assert!(batch_poll(1, 0, 121));
        assert!(batch_poll(4, 0, 20));
        // Nothing new is never a summary.
        assert!(!batch_poll(0, 10_000, 10_000));
    }

    #[test]
    fn summary_wording() {
        let e = |s: &str, j: &str| (s.to_string(), j.to_string());
        assert_eq!(summary_text(&[e("Uber", "Your trip"), e("Delta", "")]), ("2 new messages".into(), "Uber: Your trip".into(), "Also from Delta".into()));
        let many = [e("A", "1"), e("B", "2"), e("A", "3"), e("C", "4"), e("D", "5"), e("E", "6"), e("F", "7")];
        assert_eq!(summary_text(&many), ("7 new messages".into(), "A: 1".into(), "Also from B, A, C and 3 others".into()));
        assert_eq!(summary_text(&[e("A", "1"), e("B", "2"), e("C", "3"), e("D", "4")]).2, "Also from B, C and D");
        assert_eq!(summary_text(&[e("Newsletter", "")]), ("1 new message".into(), "Newsletter".into(), "".into()));
    }

    #[test]
    fn buttons_follow_the_setting() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(toast_buttons(None), vec![("done", "Done"), ("read", "Mark read")]);
        assert_eq!(toast_buttons(Some(&v(&["trash", "done", "quiet"]))), vec![("trash", "Trash"), ("done", "Done"), ("quiet", "Stop these")]);
        // Reply cannot be carried by a toast; unknown names and repeats are dropped; never more than three.
        assert_eq!(toast_buttons(Some(&v(&["reply", "trash", "trash", "x", "snooze", "read", "done"]))), vec![("trash", "Trash"), ("snooze", "Snooze"), ("read", "Mark read")]);
        assert_eq!(toast_buttons(Some(&v(&[]))), vec![]);
    }

    #[test]
    fn tomorrow() {
        assert_eq!(next_day(2026, 10, 22), (2026, 10, 23));
        assert_eq!(next_day(2026, 10, 31), (2026, 11, 1));
        assert_eq!(next_day(2026, 12, 31), (2027, 1, 1));
        assert_eq!(next_day(2028, 2, 28), (2028, 2, 29));
        assert_eq!(next_day(2026, 2, 28), (2026, 3, 1));
        assert_eq!(next_day(2100, 2, 28), (2100, 3, 1));
    }

    #[test]
    fn body_split() {
        assert_eq!(split_body("Subject\nline one\n\nline two"), ("Subject".into(), "line one line two".into()));
        assert_eq!(split_body(""), ("".into(), "".into()));
    }

    #[test]
    fn pkce_shape() {
        let (v, c) = pkce();
        assert_eq!(v.len(), 43);
        assert_eq!(c.len(), 43);
        assert!(c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(c, b64url(&Sha256::digest(v.as_bytes())));
    }

    #[test]
    fn scripts_embed_safely() {
        let j = open_js("/?q=\"</script>\u{2028}");
        assert!(j.contains(r#"const p = "/?q=\"</script>"#));
        assert!(exchange_js("abc", "x\"y").contains(r#"verifier: "x\"y""#));
        assert_eq!(acted_js("hub|5155f0c7-e849", "trash"), r#"window.mh && window.mh.actedElsewhere && window.mh.actedElsewhere("hub|5155f0c7-e849", "trash")"#);
        assert!(acted_js("a\"); alert(1); (\"|x", "done").contains(r#"actedElsewhere("a\"); alert(1); (\"|x", "done")"#));
    }

    #[test]
    fn ua_and_time() {
        assert!(user_agent("141.0.3537.71", "1.0.0").ends_with("Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0 SheritWindows/1.0.0"));
        assert!(user_agent("", "1.0.0").contains("Chrome/140.0.0.0"));
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_791_237_120), "2026-10-05T21:52:00Z");
        assert_eq!(enc("a@b.com/x y"), "a%40b.com%2Fx%20y");
    }
}
