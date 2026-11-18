//! Native notifications without Web Push. WebView2 gives the page no push service, so the app reads the hub's notification
//! feed (GET /api/notify/feed, migration 0026) with the session cookie the web view carries (every 20 seconds while running,
//! exactly as the Mac app does) and turns each item into a Windows toast tagged by the web client's key, so a follow-up
//! replaces rather than stacks and a dismissal from another device removes exactly that one. When a toast is posted, its
//! conversation is downloaded and handed to the page (acceptStash), so a click opens it already drawn. While the user is
//! away, new mail is summed up in one toast instead (Away).

use crate::applog::log;
use crate::core::{self, enc, link, notif_key, split_body, toast_tag, Toast, HUB};
use crate::{reveal_state, Shared, VERSION};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// New mail that came while the user was away (core:batch_poll), newest first. One shows as its own toast; from the second
/// on, that toast gives way to one summary toast, which each later one replaces, so the user comes back to one notification
/// instead of a toast a conversation. A conversation handled anywhere leaves it (the feed's dismissals), and it ends when the
/// window comes to the front.
struct Away {
    entries: Vec<Entry>,
    /// The entry shown as its own toast, while it is the only one.
    single: Option<String>,
    /// The summary toast is up.
    shown: bool,
}
struct Entry {
    key: String,
    sender: String,
    subject: String,
    item: Value,
}
// Never held while waiting on the main thread (reveal_state does): act() takes it there.
static AWAY: Mutex<Away> = Mutex::new(Away { entries: Vec::new(), single: None, shown: false });
/// When the hub last answered a poll (Unix seconds); 0 before the first answer of this run.
static LAST_OK: AtomicU64 = AtomicU64::new(0);
/// The buttons the hub named last (`acts`), for a toast posted again from the summary, which comes with no feed answer.
static BUTTONS: Mutex<Option<Vec<String>>> = Mutex::new(None);

fn summary_tag() -> String {
    toast_tag("summary|mail")
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(format!("SheritWindows/{VERSION}"))
        .build()
        .expect("http client")
}

/// The `mh` session cookie from the web view's own store (HttpOnly, so only native code can read it). Read on a blocking
/// thread: WebView2's cookie call deadlocks if it waits on the thread that runs the event loop.
pub async fn session(app: &AppHandle) -> Option<String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let w = app.get_webview_window("main")?;
        let cookies = w.cookies_for_url(url::Url::parse(HUB).ok()?).ok()?;
        cookies.into_iter().find(|c| c.name() == "mh").map(|c| c.value().to_string())
    })
    .await
    .ok()
    .flatten()
}

fn hub_req(http: &reqwest::Client, method: reqwest::Method, path: &str, mh: &str) -> reqwest::RequestBuilder {
    // The hub's CSRF guard refuses a state-changing request without its own Origin.
    http.request(method, format!("{HUB}{path}")).header("Cookie", format!("mh={mh}")).header("Origin", HUB)
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let http = http();
        let mut last = String::new();
        loop {
            let status = poll(&app, &http).await;
            if status != last {
                log(format!("feed: {status}"));
                last = status;
            }
            let kick = app.state::<Shared>().kick.clone();
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(20)) => {}
                _ = kick.notified() => {}
            }
        }
    });
}

/// One poll; returns a status line, logged only when it changes.
async fn poll(app: &AppHandle, http: &reqwest::Client) -> String {
    let Some(mh) = session(app).await else { return "signed out".into() };
    let cursor = app.state::<Shared>().persist.lock().unwrap().cursor;
    // Without `since` the hub answers only its current cursor, so a fresh install starts from now, not from three days back.
    let path = match cursor { Some(c) => format!("/api/notify/feed?since={c}"), None => "/api/notify/feed".into() };
    let r = match hub_req(http, reqwest::Method::GET, &path, &mh).timeout(Duration::from_secs(15)).send().await {
        Ok(r) => r,
        Err(e) => return format!("unreachable ({})", if e.is_timeout() { "timeout".into() } else { e.without_url().to_string() }),
    };
    if r.status() == reqwest::StatusCode::UNAUTHORIZED {
        return "session expired".into();
    }
    if !r.status().is_success() {
        return format!("HTTP {}", r.status().as_u16());
    }
    let Ok(j) = r.json::<Value>().await else { return "unreadable answer".into() };
    let items = j["items"].as_array().cloned().unwrap_or_default();
    if let Some(a) = j["acts"].as_array() {
        *BUTTONS.lock().unwrap() = Some(a.iter().filter_map(|x| x.as_str().map(String::from)).collect());
    }
    // The first answer of a run is a backlog too: what came while the app was not running (the PC was off, or it just started).
    let now = crate::applog::now_secs();
    let prev = LAST_OK.swap(now, Ordering::SeqCst);
    let gap = if prev == 0 { u64::MAX } else { now.saturating_sub(prev) };
    let front = reveal_state(app).1;
    if front {
        end_away(app);
    }
    let fresh = items.iter().filter(|it| summable(it)).count();
    let idle = crate::win::idle_secs();
    let away = !front && core::batch_poll(fresh, idle, gap);
    // In feed order, so a conversation handled after it came in (on the phone, while the PC slept) never reaches the summary.
    let mut later: Vec<&Value> = Vec::new();
    for it in &items {
        if away && summable(it) {
            later.push(it);
            continue;
        }
        if let Some(keys) = dismiss_keys(it) {
            later.retain(|x| !keys.contains(&ids(x).3));
        }
        apply(app, http, &mh, it, front);
    }
    if !later.is_empty() {
        log(format!("feed: {} new into the summary (idle {idle} s, {} since the last answer)", later.len(), if prev == 0 { "first answer".to_string() } else { format!("{gap} s") }));
        add_away(app, http, &mh, &later);
    }
    if let Some(next) = j["cursor"].as_i64() {
        let sh = app.state::<Shared>();
        let mut p = sh.persist.lock().unwrap();
        if p.cursor != Some(next) {
            p.cursor = Some(next);
            p.save(&sh.data_dir);
        }
    }
    if !items.is_empty() {
        log(format!("feed: {} item(s), cursor {}", items.len(), j["cursor"]));
    }
    "ok".into()
}

/// New mail that can be summed up: a conversation's own notification, not a snooze coming back, a reminder or a notice.
fn summable(it: &Value) -> bool {
    matches!(it["kind"].as_str(), Some("gmail" | "hub" | "imap")) && !it["thread"].as_str().unwrap_or("").is_empty() && !it["title"].as_str().unwrap_or("").is_empty()
}

/// (kind, account, thread, key) of a feed item.
fn ids(it: &Value) -> (String, String, String, String) {
    let kind = it["kind"].as_str().unwrap_or("").to_string();
    let account = it["account"].as_str().filter(|a| !a.is_empty()).unwrap_or(&kind).to_string();
    let thread = it["thread"].as_str().unwrap_or("").to_string();
    let key = notif_key(&kind, &account, &thread);
    (kind, account, thread, key)
}

/// The keys a dismissal names, or None for anything else.
fn dismiss_keys(it: &Value) -> Option<Vec<String>> {
    (it["kind"].as_str() == Some("dismiss")).then(|| it["dismiss"].as_array().map(|a| a.iter().filter_map(|d| d["k"].as_str().map(String::from)).collect()).unwrap_or_default())
}

/// `front`: the window is in front, and its list is already updating itself; a banner on top of it is noise.
fn apply(app: &AppHandle, http: &reqwest::Client, mh: &str, it: &Value, front: bool) {
    if let Some(keys) = dismiss_keys(it) {
        log(format!("dismiss {keys:?}"));
        dismiss(app, keys);
        return;
    }
    if it["title"].as_str().unwrap_or("").is_empty() {
        return;
    }
    show(app, it, front, true);
    prefetch_soon(app, http, mh, it);
}

/// The toast for one feed item. `quiet`: straight into Notification Center, no banner; `sound` off for a toast posted once more
/// from the summary after a dismissal.
fn show(app: &AppHandle, it: &Value, quiet: bool, sound: bool) {
    let (kind, account, thread, key) = ids(it);
    let title = it["title"].as_str().unwrap_or("");
    let tag = toast_tag(&key);
    let url = it["url"].as_str().and_then(core::safe_path).unwrap_or_else(|| "/".into());
    let (subject, rest) = split_body(it["body"].as_str().unwrap_or(""));
    let link_key = app.state::<Shared>().persist.lock().unwrap().link_key.clone();
    let mail = !thread.is_empty() && matches!(kind.as_str(), "gmail" | "hub" | "imap");
    // The user's buttons (core:toast_buttons), only where /api/notify/act can carry them out: hub threads and Gmail accounts.
    // A work (IMAP) account is neither, so its buttons would close the toast and change nothing.
    let actions = if mail && kind != "imap" {
        let a = |act: &str| link("act", &link_key, &[("a", act), ("acct", &account), ("t", &thread), ("k", &key)]);
        core::toast_buttons(BUTTONS.lock().unwrap().as_deref()).into_iter().map(|(act, label)| (label, a(act))).collect()
    } else {
        vec![]
    };
    let xml = core::toast_xml(&Toast { title, lines: vec![&subject, &rest], launch: link("open", &link_key, &[("u", &url)]), actions, sound });
    let id = key.clone();
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || match crate::win::toast_show(&tag, &xml, quiet) {
        Ok(()) => {
            log(format!("posted {id}{}", if quiet { " (quiet)" } else { "" }));
            report_soon(&app2, "first toast");
        }
        Err(e) => {
            log(format!("posted {id} ERROR {e}"));
            report_soon(&app2, "toast error");
        }
    });
}

fn prefetch_soon(app: &AppHandle, http: &reqwest::Client, mh: &str, it: &Value) {
    let (kind, account, thread, _) = ids(it);
    if !thread.is_empty() && matches!(kind.as_str(), "gmail" | "hub" | "imap") {
        let (app, http, mh) = (app.clone(), http.clone(), mh.to_string());
        tauri::async_runtime::spawn(async move { prefetch(&app, &http, &mh, &kind, &account, &thread).await });
    }
}

/// This poll's new mail into the summary, newest first; a newer message of a conversation already in it moves it to the front.
fn add_away(app: &AppHandle, http: &reqwest::Client, mh: &str, fresh: &[&Value]) {
    let mut away = AWAY.lock().unwrap();
    let mut gone: Vec<String> = Vec::new();
    for it in fresh {
        let (_, _, _, key) = ids(it);
        away.entries.retain(|e| e.key != key);
        let (subject, _) = split_body(it["body"].as_str().unwrap_or(""));
        away.entries.insert(0, Entry { key: key.clone(), sender: it["title"].as_str().unwrap_or("").trim().to_string(), subject, item: (*it).clone() });
        gone.push(key);
    }
    // The newest few are downloaded for a click to open at once, as a toast's own are; a backlog can hold 200.
    for it in fresh.iter().rev().take(5) {
        prefetch_soon(app, http, mh, it);
    }
    if away.entries.len() >= 2 {
        // An older toast of these conversations, and the toast the first one had on its own, give way to the summary.
        gone.extend(away.single.take());
        let _ = app.run_on_main_thread(move || {
            for k in gone {
                crate::win::toast_remove(&toast_tag(&k));
            }
        });
    }
    post_away(app, &mut away, false);
}

/// Post what the summary holds now: nothing, one entry's own toast, or the summary. `again`: after a dismissal, quietly.
fn post_away(app: &AppHandle, away: &mut Away, again: bool) {
    let tag = summary_tag();
    if away.entries.len() < 2 && std::mem::take(&mut away.shown) {
        let _ = app.run_on_main_thread(move || crate::win::toast_remove(&tag));
    }
    match away.entries.len() {
        0 => away.single = None,
        1 => {
            away.single = Some(away.entries[0].key.clone());
            show(app, &away.entries[0].item, again, !again);
        }
        n => {
            away.single = None;
            away.shown = true;
            let tag = summary_tag();
            let pairs: Vec<(String, String)> = away.entries.iter().map(|e| (e.sender.clone(), e.subject.clone())).collect();
            let (title, newest, also) = core::summary_text(&pairs);
            let link_key = app.state::<Shared>().persist.lock().unwrap().link_key.clone();
            let xml = core::toast_xml(&Toast { title: &title, lines: vec![&newest, &also], launch: link("reveal", &link_key, &[]), actions: vec![], sound: !again });
            let newest_key = away.entries[0].key.clone();
            let _ = app.run_on_main_thread(move || match crate::win::toast_show(&tag, &xml, again) {
                Ok(()) => log(format!("summary {n}, newest {newest_key}{}", if again { " (quiet)" } else { "" })),
                Err(e) => log(format!("summary {n} ERROR {e}")),
            });
        }
    }
}

/// Conversations handled somewhere: their toasts go, and so do they from the summary, which says what is left.
fn dismiss(app: &AppHandle, keys: Vec<String>) {
    {
        let mut away = AWAY.lock().unwrap();
        let before = away.entries.len();
        away.entries.retain(|e| !keys.contains(&e.key));
        if away.entries.len() != before {
            if before >= 2 {
                post_away(app, &mut away, true);
            } else {
                away.single = None;
            }
        }
    }
    let _ = app.run_on_main_thread(move || {
        for k in keys {
            crate::win::toast_remove(&toast_tag(&k));
        }
    });
}

/// The window came to the front: the summary has done its job, the list shows the same mail.
fn end_away(app: &AppHandle) {
    let mut away = AWAY.lock().unwrap();
    if std::mem::take(&mut away.shown) {
        let tag = summary_tag();
        let _ = app.run_on_main_thread(move || crate::win::toast_remove(&tag));
        log(format!("summary of {} closed: the window is in front", away.entries.len()));
    }
    away.entries.clear();
    away.single = None;
}

/// The conversation behind a notification, downloaded now (the same fetch sw.js, the Mac and the Android app make) and handed
/// to the page, which adopts and prerenders it. keep_unread=1: a background fetch must not mark the mail read.
async fn prefetch(app: &AppHandle, http: &reqwest::Client, mh: &str, kind: &str, account: &str, thread: &str) {
    let raw: Option<Value> = async {
        if kind == "gmail" {
            let t: Value = hub_req(http, reqwest::Method::POST, &format!("/api/gmail/accounts/{}/token", enc(account)), mh).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
            let at = t["access_token"].as_str()?;
            http.get(format!("https://gmail.googleapis.com/gmail/v1/users/me/threads/{}?format=full", enc(thread))).bearer_auth(at).send().await.ok()?.error_for_status().ok()?.json().await.ok()
        } else {
            hub_req(http, reqwest::Method::GET, &format!("/api/threads/{}?keep_unread=1", enc(thread)), mh).send().await.ok()?.error_for_status().ok()?.json().await.ok()
        }
    }
    .await;
    let Some(raw) = raw else {
        log(format!("prefetch {account}|{thread} failed"));
        return;
    };
    let sh = app.state::<Shared>();
    if !sh.loaded.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let stash = json!({ "kind": kind, "account": account, "id": thread, "raw": raw, "at": crate::applog::now_secs() * 1000 });
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.mh && window.mh.acceptStash && window.mh.acceptStash({stash})");
        match w.eval(js) {
            Ok(()) => log(format!("primed {account}|{thread}")),
            Err(e) => log(format!("prime {account}|{thread} failed {e}")),
        }
    }
}

/// A button on a toast (core:TOAST_ACTS): the toast goes at once, then the hub is told. Done, Mark read, Trash and Snooze
/// dismiss the conversation everywhere; Stop these adds a rule and leaves the mail as it is.
pub fn act(app: &AppHandle, action: String, account: String, thread: String, key: String) {
    let tag = toast_tag(if key.is_empty() { &thread } else { &key });
    // Not from here: a click arrives inside Windows' input-synchronous hand-off, where the removal is refused (field log 2026-10-22,
    // "An outgoing call cannot be made since the application is dispatching an input-synchronous call. (0x8001010D)"). Posted from
    // another thread it runs once that call has returned, as the feed's dismissals do.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app2.run_on_main_thread(move || crate::win::toast_remove(&tag));
    });
    {
        // Its toast was the summary's only entry, shown on its own; it is dealt with.
        let mut away = AWAY.lock().unwrap();
        if away.entries.len() == 1 && away.single.as_deref() == Some(key.as_str()) {
            away.entries.clear();
            away.single = None;
        }
    }
    // Snooze is until 8 in the morning tomorrow, on this PC's clock, as the phone does it.
    let until = if action == "snooze" {
        match crate::win::snooze_until() {
            Some(u) => Some(u),
            None => return log(format!("act snooze {account}|{thread}: no local time from Windows, not sent")),
        }
    } else {
        None
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(mh) = session(&app).await else { return log("act: signed out") };
        let mut body = json!({ "account": account, "thread": thread, "action": action });
        if let Some(u) = until {
            body["until"] = json!(u);
        }
        let r = hub_req(&http(), reqwest::Method::POST, "/api/notify/act", &mh).json(&body).send().await;
        match r {
            Ok(r) => {
                log(format!("act {action} {account}|{thread}: HTTP {}", r.status().as_u16()));
                // Done: the open window shows it at once, instead of keeping the mail (open, if it was) until its next poll.
                if r.status().is_success() && !key.is_empty() {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval(core::acted_js(&key, &action));
                    }
                }
            }
            Err(e) => log(format!("act {action} {account}|{thread} failed {}", e.without_url())),
        }
    });
}

/// The log's tail and the machine's facts, to the hub (POST /api/applog): nobody can open this PC's log file from where the
/// app is maintained, so this is how a toast that never showed or an update that never landed gets seen.
pub fn start_reports(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(90)).await;
        loop {
            report(&app).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

/// One extra report a minute after something worth seeing (the first toast of this run, or a failure) at most once an hour,
/// so whether toasts work on the PC is known in minutes instead of at the next six-hourly report.
pub fn report_soon(app: &AppHandle, why: &'static str) {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(3600)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    log(format!("report soon: {why}"));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        report(&app).await;
    });
}

pub async fn report(app: &AppHandle) {
    let Some(mh) = session(app).await else { return };
    let body = json!({
        "device": "windows",
        "version": VERSION,
        "os": crate::win::os_version(),
        "webview": crate::win::webview_version(),
        "log": crate::applog::tail(48_000),
    });
    if let Err(e) = hub_req(&http(), reqwest::Method::POST, "/api/applog", &mh).json(&body).send().await.and_then(|r| r.error_for_status()) {
        log(format!("report failed {}", e.without_url()));
    }
}
