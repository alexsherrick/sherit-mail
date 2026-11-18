//! The app keeps itself current from the hub (GET /dl/windows/latest.json, every artifact signed with the updater key kept in
//! ~/.config/mailhub). A new version is downloaded in the background and installed only while the window is closed to the
//! tray (quietly, no installer window) and the app comes back as it was (hidden stays hidden). With the window open (or
//! minimized) it waits. The tray's "Check for Updates and Restart" (or "Restart to Update" once one is waiting) installs at once:
//! the label says it restarts, so the click is the consent (A check-and-restart item was asked for).

use crate::applog::log;
use crate::{window_open, Shared};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

pub struct Ready {
    pub update: tauri_plugin_updater::Update,
    pub bytes: Vec<u8>,
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        loop {
            check(&app, false).await;
            // A downloaded update waits for the window to be closed; look again often, check the server rarely.
            for _ in 0..72 {
                tokio::time::sleep(Duration::from_secs(300)).await;
                install_if_idle(&app);
            }
        }
    });
}

pub async fn check(app: &AppHandle, by_hand: bool) {
    // The tray item reads "Restart to Update" once a download is ready, so a click then is the user asking for the restart.
    if app.state::<Shared>().ready.lock().unwrap().is_some() {
        if by_hand {
            install_now(app);
        }
        return;
    }
    let found = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => return log(format!("updater unavailable {e}")),
    };
    match found {
        Ok(Some(update)) => {
            log(format!("update {} -> {}: downloading", update.current_version, update.version));
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    let v = update.version.clone();
                    *app.state::<Shared>().ready.lock().unwrap() = Some(Ready { update, bytes });
                    if let Some(item) = app.state::<Shared>().update_item.lock().unwrap().as_ref() {
                        let _ = item.set_text(format!("Restart to Update ({v})"));
                    }
                    log(format!("update {v} ready"));
                    if by_hand { install_now(app) } else { install_if_idle(app) }
                }
                Err(e) => log(format!("update download failed {e}")),
            }
        }
        Ok(None) => {
            if by_hand {
                crate::notice(app, "Sherit Mail is up to date", &format!("Version {}", crate::VERSION));
            }
        }
        Err(e) => {
            log(format!("update check failed {e}"));
            crate::notifier::report_soon(app, "update check failed");
        }
    }
}

/// Only while closed to the tray: nobody is mid-sentence in a window that is not there (a minimized one may well be).
pub fn install_if_idle(app: &AppHandle) {
    if !window_open(app) && app.state::<Shared>().ready.lock().unwrap().is_some() {
        install_now(app);
    }
}

pub fn install_now(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let sh = app2.state::<Shared>();
        let Some(r) = sh.ready.lock().unwrap().take() else { return };
        let visible = window_open(&app2);
        {
            let mut p = sh.persist.lock().unwrap();
            (p.update_at, p.update_hidden) = (crate::applog::now_secs(), !visible);
            p.save(&sh.data_dir);
        }
        log(format!("installing {} (relaunch {})", r.update.version, if visible { "shown" } else { "hidden" }));
        // The installer replaces this process; take the tray icon down first so no dead icon lingers until hovered.
        if let Some(t) = app2.tray_by_id("main") {
            let _ = t.set_visible(false);
        }
        if let Err(e) = r.update.install(&r.bytes) {
            log(format!("install failed {e}"));
            crate::notifier::report_soon(&app2, "install failed");
            if let Some(t) = app2.tray_by_id("main") {
                let _ = t.set_visible(true);
            }
            let mut p = sh.persist.lock().unwrap();
            (p.update_at, p.update_hidden) = (0, false);
            p.save(&sh.data_dir);
        }
    });
}
