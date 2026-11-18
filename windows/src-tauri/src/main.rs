// Sherit Mail for Windows: one window holding the web client at mail.yourdomain.example, in Microsoft's own
// WebView2 (the Edge engine Windows already ships), plus what a page cannot do there: notifications, the taskbar badge, the tray,
// mailto:, Google sign-in in the real browser, and updating itself. The same shape as the Mac app (mac/) and the Android app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod applog;
mod badge;
mod core;
mod notifier;
mod updates;
mod win;

use crate::applog::log;
use crate::core::{Cmd, HUB, HUB_HOST};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const TRAY_PNG: &[u8] = include_bytes!("../icons/32x32.png");
const ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

/// What survives a restart: the feed cursor, this install's link key, the login-item choice, the update hand-over, the tray hint.
#[derive(Serialize, Deserialize, Default)]
pub struct Persist {
    pub cursor: Option<i64>,
    #[serde(default)]
    pub link_key: String,
    pub login: Option<bool>,
    /// Set just before the updater replaces the app (Unix seconds) and whether the window was hidden then. Honoured only by a
    /// start within five minutes: an installer that died must not leave the next Start-menu launch invisible.
    #[serde(default)]
    pub update_at: u64,
    #[serde(default)]
    pub update_hidden: bool,
    #[serde(default)]
    pub tray_hint: bool,
}

impl Persist {
    fn load(dir: &Path) -> Self {
        std::fs::read(dir.join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save(&self, dir: &Path) {
        let _ = std::fs::create_dir_all(dir);
        let tmp = dir.join("state.json.tmp");
        if serde_json::to_vec_pretty(self).ok().and_then(|b| std::fs::write(&tmp, b).ok()).is_some() {
            let _ = std::fs::rename(&tmp, dir.join("state.json"));
        }
    }
}

pub struct Shared {
    pub persist: Mutex<Persist>,
    pub data_dir: PathBuf,
    /// The page has finished loading on the hub: it can take scripts (openUrl, acceptStash).
    pub loaded: AtomicBool,
    /// A path that arrived before the page was ready.
    queued: Mutex<Option<String>>,
    /// The window comes forward once the page says the conversation is open (or after 600 ms).
    reveal_pending: AtomicBool,
    /// The sign-in secret while a browser sign-in is under way.
    verifier: Mutex<Option<(String, Instant)>>,
    unread: AtomicU32,
    quitting: AtomicBool,
    pub kick: Arc<tokio::sync::Notify>,
    pub ready: Mutex<Option<updates::Ready>>,
    pub update_item: Mutex<Option<MenuItem<Wry>>>,
    login_item: Mutex<Option<CheckMenuItem<Wry>>>,
    exe: PathBuf,
}

fn main() {
    win::early_init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let app = tauri::Builder::default()
        // First: a second launch (a toast click, a mailto: link, the Start menu) hands its arguments to this one and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| handle_launch(app, argv.into_iter().skip(1).collect(), false)))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![badge, opened])
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .on_window_event(window_event)
        .build(tauri::generate_context!())
        .expect("Sherit Mail could not start");
    app.run(|app, ev| {
        // Closing the window hides it; the app keeps running in the tray so mail keeps arriving: the way Mail behaves on the Mac.
        if let RunEvent::ExitRequested { api, code, .. } = ev {
            if code.is_none() && !app.state::<Shared>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    applog::init(app.path().app_log_dir()?);
    let mut p = Persist::load(&data_dir);
    if p.link_key.is_empty() {
        p.link_key = core::random_token(24);
    }
    let after_update = p.update_at != 0 && applog::now_secs().saturating_sub(p.update_at) < 300;
    let relaunch_hidden = after_update && p.update_hidden;
    (p.update_at, p.update_hidden) = (0, false);
    let login = p.login.unwrap_or(true);
    p.save(&data_dir);

    // The updater restarts the app with the arguments the OLD process was started with. Those were already handled (a toast
    // click that opened a conversation hours ago), so a start that follows an update replays none of them.
    let args: Vec<String> = if after_update { vec![] } else { std::env::args().skip(1).collect() };
    // A toast button (Done / Mark read) or a "Show in folder" that had to start the app does its work in the tray, and a
    // launch argument that means nothing (a page firing a bare sheritmail: link) starts it there too: neither is the user
    // opening the app.
    let quiet_cmds = {
        let cmds = core::parse_args(args.clone(), &p.link_key);
        !args.is_empty() && cmds.iter().all(|c| matches!(c, Cmd::Act { .. } | Cmd::File { .. } | Cmd::Hidden))
    };
    let hidden = relaunch_hidden || quiet_cmds;
    log(format!("start {VERSION} hidden={hidden}{} args={:?} {} webview {}", if after_update { " (after update)" } else { "" }, redact(&args), win::os_version(), win::webview_version()));

    let exe = std::env::current_exe()?;
    app.manage(Shared {
        persist: Mutex::new(p),
        data_dir: data_dir.clone(),
        loaded: AtomicBool::new(false),
        queued: Mutex::new(None),
        reveal_pending: AtomicBool::new(false),
        verifier: Mutex::new(None),
        unread: AtomicU32::new(0),
        quitting: AtomicBool::new(false),
        kick: Arc::new(tokio::sync::Notify::new()),
        ready: Mutex::new(None),
        update_item: Mutex::new(None),
        login_item: Mutex::new(None),
        exe: exe.clone(),
    });

    // The toast icon Windows reads from the AppUserModelId registration is a file, so it is written next to the state.
    let icon_png = data_dir.join("icon.png");
    if std::fs::read(&icon_png).map(|b| b != ICON_PNG).unwrap_or(true) {
        let _ = std::fs::write(&icon_png, ICON_PNG);
    }
    win::register(&exe, &icon_png);
    win::set_login_item(&exe, login);

    build_tray(app, login)?;
    build_window(app, hidden)?;
    win::jump_list(&exe);
    handle_launch(app, args, true);
    notifier::start(app.clone());
    notifier::start_reports(app.clone());
    updates::start(app.clone());
    #[cfg(debug_assertions)]
    self_test(app);
    Ok(())
}

/// Debug builds only, SHERIT_SELFTEST=1: drive the real window against the live hub and log what the native side saw, the
/// page-to-app bridge on the hub's origin (badge, opened), new windows, mailto: navigations, then quit. Platform-free, so it
/// runs on the Mac where the build is made; the log says what passed.
#[cfg(debug_assertions)]
fn self_test(app: &AppHandle) {
    if std::env::var_os("SHERIT_SELFTEST").is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let sh = || app.state::<Shared>();
        let wait = |ms| tokio::time::sleep(Duration::from_millis(ms));
        for _ in 0..80 {
            if sh().loaded.load(Ordering::SeqCst) {
                break;
            }
            wait(250).await;
        }
        let w = app.get_webview_window("main").expect("window");
        let mut ok = vec![];
        ok.push(("page loaded on the hub", sh().loaded.load(Ordering::SeqCst)));
        let _ = w.eval("navigator.setAppBadge(7)");
        wait(1500).await;
        ok.push(("badge 7 reached the app", sh().unread.load(Ordering::SeqCst) == 7));
        let _ = w.eval("navigator.clearAppBadge()");
        wait(1500).await;
        ok.push(("clearAppBadge reached the app", sh().unread.load(Ordering::SeqCst) == 0));
        let _ = w.eval("window.open('https://example.com/selftest', '_blank', 'noopener')");
        wait(1000).await;
        ok.push(("window.open stayed out of the app", app.webview_windows().len() == 1));
        sh().reveal_pending.store(true, Ordering::SeqCst);
        let _ = w.eval(core::open_js("/?selftest=1"));
        wait(2500).await;
        ok.push(("open_js answered opened", !sh().reveal_pending.load(Ordering::SeqCst)));
        let _ = w.eval("location.href = 'mailto:selftest@example.com?subject=Self%20test'");
        wait(2500).await;
        let url = w.url().map(|u| u.to_string()).unwrap_or_default();
        ok.push(("mailto: became the composer", url.contains("compose=1") && url.contains("selftest%40example.com")));
        for (what, pass) in &ok {
            log(format!("selftest {} {what}", if *pass { "PASS" } else { "FAIL" }));
        }
        log(format!("selftest done: {}/{} passed", ok.iter().filter(|(_, p)| *p).count(), ok.len()));
        sh().quitting.store(true, Ordering::SeqCst);
        app.exit(if ok.iter().all(|(_, p)| *p) { 0 } else { 1 });
    });
}

/// Never log a sign-in code or a toast link's key.
fn redact(args: &[String]) -> Vec<String> {
    args.iter().map(|a| if a.to_ascii_lowercase().starts_with("sheritmail:") { a.split('?').next().unwrap_or("").to_string() + "?…" } else { a.clone() }).collect()
}

fn page_bg(dark: bool) -> tauri::window::Color {
    if dark { tauri::window::Color(0x12, 0x13, 0x16, 0xFF) } else { tauri::window::Color(0xFF, 0xFF, 0xFF, 0xFF) }
}

fn build_window(app: &AppHandle, hidden: bool) -> tauri::Result<WebviewWindow> {
    let devtools = cfg!(debug_assertions) || std::env::var_os("SHERIT_DEVTOOLS").is_some();
    // The self-test gets a throwaway store: a debug build on the Mac can carry the Mac app's bundle id, and must never open
    // that app's WebKit storage (its IndexedDB) from a second process.
    let selftest = cfg!(debug_assertions) && std::env::var_os("SHERIT_SELFTEST").is_some();
    let ua = core::user_agent(&win::webview_version(), VERSION);
    let (a1, a2, a3, a4) = (app.clone(), app.clone(), app.clone(), app.clone());
    let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(HUB.parse().expect("hub url")))
        .title("Sherit Mail")
        .inner_size(1280.0, 820.0)
        .min_inner_size(520.0, 420.0)
        .center()
        .visible(false)
        .background_color(page_bg(win::system_dark()))
        .user_agent(&ua)
        .initialization_script(core::PAGE_SCRIPT)
        // The page takes its own drops (attachments into a draft); Tauri's file-drop interception would swallow them.
        .disable_drag_drop_handler()
        .devtools(devtools)
        .incognito(selftest)
        .on_navigation(move |url| navigate(&a1, url))
        .on_new_window(move |url, _| {
            // window.open and target=_blank; every link inside a message: the default browser, never a second web view.
            outside(&a2, &url);
            NewWindowResponse::Deny
        })
        .on_download(move |_, ev| {
            match ev {
                // Saved where WebView2 chose (Downloads, named as the page asked, made unique) without Edge's download flyout.
                DownloadEvent::Requested { .. } => {}
                DownloadEvent::Finished { url, path, success } => downloaded(&a3, &url, path, success),
                _ => {}
            }
            true
        })
        .on_page_load(move |_, p| {
            let sh = a4.state::<Shared>();
            match p.event() {
                PageLoadEvent::Started => sh.loaded.store(false, Ordering::SeqCst),
                PageLoadEvent::Finished => {
                    let on_hub = p.url().host_str() == Some(HUB_HOST);
                    sh.loaded.store(on_hub, Ordering::SeqCst);
                    log(format!("loaded {}{}", p.url().path(), if on_hub { "" } else { " (not the hub)" }));
                    let queued = sh.queued.lock().unwrap().take();
                    if let Some(q) = queued.filter(|_| on_hub) {
                        open_path(&a4, q);
                    }
                }
            }
        })
        .build()?;
    #[cfg(windows)]
    {
        if let Ok(h) = w.hwnd() {
            win::paint_titlebar(h, win::system_dark());
        }
        let _ = w.with_webview(move |wv| win::tune_webview(wv.controller(), devtools));
    }
    if !hidden {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(w)
}

/// Main-frame navigations. The hub's own pages stay; Google sign-in goes to the real browser (Google refuses embedded web
/// views: disallowed_useragent); connecting a Gmail account too (its tokens live on the hub); everything else leaves the app.
fn navigate(app: &AppHandle, url: &url::Url) -> bool {
    match url.scheme() {
        "about" | "blob" | "data" => true,
        "http" | "https" if url.host_str() == Some(HUB_HOST) => {
            if url.path() == "/auth/google" {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || sign_in(&app2));
                false
            } else if url.path().starts_with("/auth/gmail") {
                shell(app, url.as_str());
                false
            } else {
                true
            }
        }
        _ => {
            outside(app, url);
            false
        }
    }
}

/// ShellExecute on the UI thread, where COM is initialised (Microsoft asks for it, since a handler may be a shell extension),
/// and after the WebView2 event that asked for it has returned.
fn shell(app: &AppHandle, target: &str) {
    let target = target.to_string();
    let _ = app.run_on_main_thread(move || win::shell_open(&target));
}

fn outside(app: &AppHandle, url: &url::Url) {
    // The host only: a link's path and query can carry a sender's tokens.
    log(format!("outside {}:{}", url.scheme(), url.host_str().unwrap_or("")));
    match url.scheme() {
        "http" | "https" => shell(app, url.as_str()),
        "mailto" => {
            let (app, p) = (app.clone(), core::mailto_path(url.as_str()));
            tauri::async_runtime::spawn(async move { open_path(&app, p) });
        }
        other => log(format!("blocked a {other}: link")),
    }
}

/// The Mark of the Web on a saved attachment, written here when it has none, so SmartScreen and Office's Protected View treat it as
/// from the internet whatever WebView2 does. The same
/// stream Chromium's quarantine_win.cc writes when Windows' own attachment service fails: ZoneId=3 (Internet) and where it came from.
#[cfg(windows)]
fn mark_of_the_web(path: &std::path::Path) {
    let ads = format!("{}:Zone.Identifier", path.display());
    if std::fs::metadata(&ads).is_ok() { return log("download already marked as from the internet"); }
    match std::fs::write(&ads, format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://{HUB_HOST}/\r\n")) {
        Ok(()) => log("download marked as from the internet"),
        Err(e) => log(format!("could not mark the download as from the internet: {e}")),
    }
}
#[cfg(not(windows))]
fn mark_of_the_web(_path: &std::path::Path) {}

fn downloaded(app: &AppHandle, url: &tauri::Url, path: Option<PathBuf>, success: bool) {
    // A failed download used to be only a log line: nothing on screen said the file never arrived. WebView2 does not
    // pass the reason (a SmartScreen block, a full disk, the hub refusing); the toast names the file, from the link's ?name=.
    let Some(path) = path.filter(|_| success) else {
        let name = url.query_pairs().find(|(k, _)| k == "name").map(|(_, v)| v.into_owned())
            .or_else(|| url.path_segments().and_then(|mut s| s.next_back().map(str::to_owned))).unwrap_or_else(|| "A download".into());
        log(format!("download failed {name}"));
        let link_key = app.state::<Shared>().persist.lock().unwrap().link_key.clone();
        let xml = core::toast_xml(&core::Toast { title: &name, lines: vec!["Couldn't be saved."], launch: core::link("open", &link_key, &[("u", "/")]), actions: vec![], sound: false });
        let tag = core::toast_tag(&format!("dlfail|{name}"));
        let _ = app.run_on_main_thread(move || { let _ = win::toast_show(&tag, &xml, false); });
        return;
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    mark_of_the_web(&path);
    log(format!("downloaded {name}"));
    let link_key = app.state::<Shared>().persist.lock().unwrap().link_key.clone();
    let p = path.display().to_string();
    let xml = core::toast_xml(&core::Toast {
        title: &name,
        lines: vec!["Saved to Downloads"],
        launch: core::link("file", &link_key, &[("p", &p), ("r", "1")]),
        actions: vec![("Show in folder", core::link("file", &link_key, &[("p", &p), ("r", "1")]))],
        sound: false,
    });
    let tag = core::toast_tag(&format!("dl|{p}"));
    let _ = app.run_on_main_thread(move || {
        let _ = win::toast_show(&tag, &xml, false);
    });
}

/// A plain notice from the app itself (the tray hint, "up to date").
pub fn notice(app: &AppHandle, title: &str, line: &str) {
    let link_key = app.state::<Shared>().persist.lock().unwrap().link_key.clone();
    let xml = core::toast_xml(&core::Toast { title, lines: vec![line], launch: core::link("reveal", &link_key, &[]), actions: vec![], sound: false });
    let tag = core::toast_tag(&format!("notice|{title}"));
    let _ = app.run_on_main_thread(move || {
        let _ = win::toast_show(&tag, &xml, false);
    });
}

/// The window is on screen or minimized to the taskbar: anything but closed to the tray. A minimized window can hold a
/// half-written reply, so the updater treats it as in use.
pub fn window_open(app: &AppHandle) -> bool {
    app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)
}

/// (window visible, window in front).
pub fn reveal_state(app: &AppHandle) -> (bool, bool) {
    let Some(w) = app.get_webview_window("main") else { return (false, false) };
    let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    (visible, visible && w.is_focused().unwrap_or(false))
}

pub fn reveal(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Open a path inside the client without reloading the page. The page opens it FIRST and the window comes forward after
/// (`opened`), so what appears is the conversation: never the inbox that was on screen a moment before; a 600 ms cap keeps
/// a slow page from leaving the click looking ignored.
fn open_path(app: &AppHandle, path: String) {
    let sh = app.state::<Shared>();
    let Some(w) = app.get_webview_window("main") else { return };
    if !sh.loaded.load(Ordering::SeqCst) {
        *sh.queued.lock().unwrap() = Some(path);
        reveal(app);
        return;
    }
    sh.reveal_pending.store(true, Ordering::SeqCst);
    if w.eval(core::open_js(&path)).is_err() {
        let _ = w.navigate(format!("{HUB}{path}").parse().expect("hub path"));
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        if app.state::<Shared>().reveal_pending.swap(false, Ordering::SeqCst) {
            reveal(&app);
        }
    });
}

fn sign_in(app: &AppHandle) {
    let (verifier, challenge) = core::pkce();
    *app.state::<Shared>().verifier.lock().unwrap() = Some((verifier, Instant::now()));
    log("sign-in: opened in the browser");
    win::shell_open(&core::sign_in_url(&challenge));
}

/// sheritmail://auth?code=… from the browser: the code plus the secret this process kept make a session, set by the hub on
/// the web view's own origin.
fn finish_sign_in(app: &AppHandle, code: String) {
    // Kept, not taken: a page that fires a junk sheritmail://auth during a real sign-in must not spend the verifier the real
    // code needs. The hub's codes are single-use and bound to this verifier's challenge, so keeping it opens nothing.
    let pending = app.state::<Shared>().verifier.lock().unwrap().clone();
    let Some((verifier, _)) = pending.filter(|(_, at)| at.elapsed() < Duration::from_secs(900)) else {
        return log("sign-in code with no sign-in under way: ignored");
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(core::exchange_js(&code, &verifier));
    }
    reveal(app);
    log("sign-in: code exchanged in the page");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        app.state::<Shared>().kick.notify_one();
        notifier::report(&app).await;
    });
}

fn handle_launch(app: &AppHandle, args: Vec<String>, first: bool) {
    let link_key = app.state::<Shared>().persist.lock().unwrap().link_key.clone();
    let cmds = core::parse_args(args.clone(), &link_key);
    if !first {
        log(format!("handed {:?}", redact(&args)));
    }
    if cmds.is_empty() {
        // A plain second launch (Start menu, taskbar: no arguments) brings the window forward. Arguments that parse to nothing
        // (a page firing a junk sheritmail: link) do nothing at all.
        if !first && args.is_empty() {
            reveal(app);
        }
        return;
    }
    for c in cmds {
        match c {
            Cmd::Hidden => {}
            Cmd::Reveal => reveal(app),
            Cmd::Open(p) => open_path(app, p),
            Cmd::Auth(code) => finish_sign_in(app, code),
            Cmd::Act { action, account, thread, key } => notifier::act(app, action, account, thread, key),
            // A downloaded file is shown in its folder, never run from a click on a toast, and only a file in Downloads.
            Cmd::File { path, .. } => {
                let inside = app.path().download_dir().map(|d| Path::new(&path).starts_with(d)).unwrap_or(false);
                if inside && Path::new(&path).exists() { win::reveal_file(&path) } else { log("file link outside Downloads: ignored") }
            }
        }
    }
}

fn window_event(w: &tauri::Window, ev: &WindowEvent) {
    let app = w.app_handle();
    match ev {
        WindowEvent::CloseRequested { api, .. } if w.label() == "main" => {
            api.prevent_close();
            let _ = w.hide();
            let sh = app.state::<Shared>();
            let first = {
                let mut p = sh.persist.lock().unwrap();
                let first = !p.tray_hint;
                p.tray_hint = true;
                p.save(&sh.data_dir);
                first
            };
            if first {
                notice(app, "Sherit Mail is still running", "New mail keeps arriving. Quit from the envelope in the taskbar corner.");
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(20)).await;
                updates::install_if_idle(&app);
            });
        }
        WindowEvent::ThemeChanged(theme) => {
            let dark = *theme == Theme::Dark;
            let _ = w.set_background_color(Some(page_bg(dark)));
            #[cfg(windows)]
            if let Ok(h) = w.hwnd() {
                win::paint_titlebar(h, dark);
            }
        }
        _ => {}
    }
}

// MARK: unread count; taskbar overlay and tray

#[tauri::command]
fn badge(app: AppHandle, n: u32) {
    let sh = app.state::<Shared>();
    if sh.unread.swap(n, Ordering::SeqCst) == n {
        return;
    }
    log(format!("badge {n}"));
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let icon = (n > 0).then(|| {
            let b = badge::overlay(n, 32);
            Image::new_owned(b.px, b.w, b.h)
        });
        let _ = w.set_overlay_icon(icon);
    }
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_tooltip(Some(if n > 0 { format!("Sherit Mail — {n} unread") } else { "Sherit Mail".into() }));
        let _ = t.set_icon(Some(tray_icon(n > 0)));
    }
}

#[tauri::command]
fn opened(app: AppHandle) {
    log("page: opened");
    if app.state::<Shared>().reveal_pending.swap(false, Ordering::SeqCst) {
        reveal(&app);
    }
}

fn tray_icon(dot: bool) -> Image<'static> {
    let base = Image::from_bytes(TRAY_PNG).expect("tray icon").to_owned();
    if !dot {
        return base;
    }
    let d = badge::with_dot(&badge::Rgba { px: base.rgba().to_vec(), w: base.width(), h: base.height() });
    Image::new_owned(d.px, d.w, d.h)
}

fn build_tray(app: &AppHandle, login: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Sherit Mail", true, None::<&str>)?;
    let compose = MenuItem::with_id(app, "compose", "New Message", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Open at Login", true, login, None::<&str>)?;
    let default = MenuItem::with_id(app, "default", "Make Sherit Mail the Default Mail App…", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for Updates and Restart", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Sherit Mail", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &compose, &PredefinedMenuItem::separator(app)?, &login, &default, &update, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let sh = app.state::<Shared>();
    *sh.update_item.lock().unwrap() = Some(update);
    *sh.login_item.lock().unwrap() = Some(login);
    TrayIconBuilder::with_id("main")
        .icon(tray_icon(false))
        .tooltip("Sherit Mail")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => reveal(app),
            "compose" => open_path(app, "/?compose=1".into()),
            "login" => {
                let sh = app.state::<Shared>();
                let on = !win::login_item_set();
                win::set_login_item(&sh.exe, on);
                {
                    let mut p = sh.persist.lock().unwrap();
                    p.login = Some(on);
                    p.save(&sh.data_dir);
                }
                if let Some(i) = sh.login_item.lock().unwrap().as_ref() {
                    let _ = i.set_checked(win::login_item_set());
                };
            }
            "default" => win::open_default_apps(),
            "update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { updates::check(&app, true).await });
            }
            "quit" => {
                app.state::<Shared>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                reveal(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
