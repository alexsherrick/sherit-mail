//! Everything that talks to Windows itself. Each function is a no-op elsewhere, so the crate builds and its tests run on any
//! host; the real work is behind cfg(windows).

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
pub use stub::*;

#[cfg(windows)]
mod imp {
    use crate::applog::log;
    use crate::core::{AUMID, REG_APP};
    use std::path::Path;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, ContextMenuRequestedEventHandler, DOMContentLoadedEventHandler, ProcessFailedEventHandler};
    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::Win32::Foundation::{COLORREF, HWND, SYSTEMTIME};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::SystemInformation::{GetLocalTime, GetTickCount};
    use windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellExecuteW, ShellLink,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const CLIENT: &str = r"Software\Clients\Mail\Sherit Mail";
    const GROUP: &str = "mail";

    /// Before any window: the taskbar button, the jump list and the toasts all belong to the Start-menu shortcut's ID. (A second
    /// instance's right to take the foreground goes to the running one alone: tauri-plugin-single-instance calls
    /// AllowSetForegroundWindow with that process's id.)
    pub fn early_init() {
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID));
        }
    }

    fn set(k: &RegKey, name: &str, v: &str) -> std::io::Result<()> {
        k.set_value(name, &v.to_string())
    }

    /// Per-user registration, rewritten on every launch so it follows the copy actually running (an update, a move):
    /// sheritmail: (sign-in and toast clicks), mailto: as a candidate default mail app, and the toast identity.
    pub fn register(exe: &Path, icon_png: &Path) {
        let exe = exe.display().to_string();
        let open = format!("\"{exe}\" \"%1\"");
        let icon = format!("\"{exe}\",0");
        let r = (|| -> std::io::Result<()> {
            let cu = RegKey::predef(HKEY_CURRENT_USER);
            for (key, label) in [(r"Software\Classes\sheritmail", "URL:Sherit Mail"), (r"Software\Classes\SheritMail.mailto", "Sherit Mail mailto")] {
                let (k, _) = cu.create_subkey(key)?;
                set(&k, "", label)?;
                set(&k, "URL Protocol", "")?;
                set(&cu.create_subkey(format!(r"{key}\DefaultIcon"))?.0, "", &icon)?;
                set(&cu.create_subkey(format!(r"{key}\shell\open\command"))?.0, "", &open)?;
            }
            let (c, _) = cu.create_subkey(CLIENT)?;
            set(&c, "", REG_APP)?;
            set(&cu.create_subkey(format!(r"{CLIENT}\DefaultIcon"))?.0, "", &icon)?;
            set(&cu.create_subkey(format!(r"{CLIENT}\shell\open\command"))?.0, "", &format!("\"{exe}\""))?;
            let (cap, _) = cu.create_subkey(format!(r"{CLIENT}\Capabilities"))?;
            set(&cap, "ApplicationName", REG_APP)?;
            set(&cap, "ApplicationDescription", "Every address you own, in one fast inbox.")?;
            set(&cap, "ApplicationIcon", &icon)?;
            set(&cu.create_subkey(format!(r"{CLIENT}\Capabilities\URLAssociations"))?.0, "mailto", "SheritMail.mailto")?;
            set(&cu.create_subkey(r"Software\RegisteredApplications")?.0, REG_APP, &format!(r"{CLIENT}\Capabilities"))?;
            // The name and icon Windows shows on a toast. The installer's Start-menu shortcut carries the same ID.
            let (a, _) = cu.create_subkey(format!(r"Software\Classes\AppUserModelId\{AUMID}"))?;
            set(&a, "DisplayName", REG_APP)?;
            set(&a, "IconUri", &icon_png.display().to_string())?;
            Ok(())
        })();
        if let Err(e) = r {
            log(format!("register FAILED {e}"));
        }
    }

    /// Windows' app theme (Settings → Personalization → Colors), which is what prefers-color-scheme follows in the page.
    pub fn system_dark() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", KEY_READ)
            .and_then(|k| k.get_value::<u32, _>("AppsUseLightTheme"))
            .map(|v| v == 0)
            .unwrap_or(false)
    }

    pub fn set_login_item(exe: &Path, on: bool) {
        let cu = RegKey::predef(HKEY_CURRENT_USER);
        let r = match cu.create_subkey(RUN) {
            Ok((k, _)) if on => set(&k, REG_APP, &format!("\"{}\" --hidden", exe.display())),
            Ok((k, _)) => k.delete_value(REG_APP).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
            Err(e) => Err(e),
        };
        if let Err(e) = r {
            log(format!("login item {on} FAILED {e}"));
        }
    }

    pub fn login_item_set() -> bool {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN, KEY_READ).and_then(|k| k.get_value::<String, _>(REG_APP)).is_ok()
    }

    /// The title bar in the page's own background (app.html --bg: #fff / #121316), so it reads as part of the app, as on
    /// the Mac. Windows 11 honours the caption colour; Windows 10 keeps its own and only takes the dark-mode flag.
    pub fn paint_titlebar(hwnd: HWND, dark: bool) {
        let (bg, fg): (u32, u32) = if dark { (0x0016_1312, 0x00F1_ECEC) } else { (0x00FF_FFFF, 0x001A_1615) };
        let on: i32 = dark.into();
        unsafe {
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &on as *const _ as _, 4);
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &COLORREF(bg) as *const _ as _, 4);
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &COLORREF(fg) as *const _ as _, 4);
        }
    }

    pub fn toast_show(tag: &str, xml: &str, quiet: bool) -> Result<(), String> {
        let go = || -> windows::core::Result<()> {
            let doc = XmlDocument::new()?;
            doc.LoadXml(&HSTRING::from(xml))?;
            let t = ToastNotification::CreateToastNotification(&doc)?;
            t.SetTag(&HSTRING::from(tag))?;
            t.SetGroup(&HSTRING::from(GROUP))?;
            // The window is in front and its list is already updating: into Notification Center, no banner, no sound.
            if quiet {
                t.SetSuppressPopup(true)?;
            }
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&t)
        };
        go().map_err(|e| format!("{e}"))
    }

    pub fn toast_remove(tag: &str) {
        let r = ToastNotificationManager::History().and_then(|h| h.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(GROUP), &HSTRING::from(AUMID)));
        if let Err(e) = r {
            log(format!("toast remove {tag} failed {e}"));
        }
    }

    /// Seconds since the last keyboard or mouse input in this session, on GetTickCount's clock (time since the system started;
    /// Windows names QueryUnbiasedInterruptTime for time awake only). A wake from sleep is caught by the gap between polls
    /// anyway (core:BACKLOG_GAP_SECS). 0 when Windows will not say: the user is taken to be there.
    pub fn idle_secs() -> u64 {
        let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe {
            if !GetLastInputInfo(&mut li).as_bool() {
                return 0;
            }
            u64::from(GetTickCount().wrapping_sub(li.dwTime) / 1000)
        }
    }

    /// 8:00 tomorrow on this PC's clock, as a UTC instant for the hub (Snooze from a toast; the phone sends the same). Windows
    /// converts it with the time zone's rules for that date, so a change to or from daylight saving overnight is accounted for.
    pub fn snooze_until() -> Option<String> {
        let now = unsafe { GetLocalTime() };
        let (y, m, d) = crate::core::next_day(i64::from(now.wYear), u32::from(now.wMonth), u32::from(now.wDay));
        let local = SYSTEMTIME { wYear: y as u16, wMonth: m as u16, wDay: d as u16, wHour: 8, ..Default::default() };
        let mut utc = SYSTEMTIME::default();
        unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc) }.ok()?;
        Some(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond))
    }

    /// "New Message" on the taskbar button's jump list: it launches the app with --compose, which the running copy receives.
    pub fn jump_list(exe: &Path) {
        let exe = HSTRING::from(exe.as_os_str());
        let r = unsafe {
            // COM on this thread first. Called from setup(), it ran before WebView2 had initialised COM and failed with
            // "CoInitialize has not been called. (0x800401F0)" on my PC. Apartment-threaded, as WebView2
            // needs on the UI thread; a second call on an initialised thread is a harmless S_FALSE.
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            (|| -> windows::core::Result<()> {
                let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
                list.SetAppID(&HSTRING::from(AUMID))?;
                let mut slots = 0u32;
                let _removed: IObjectArray = list.BeginList(&mut slots)?;
                let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&exe)?;
                link.SetArguments(&HSTRING::from("--compose"))?;
                link.SetIconLocation(&exe, 0)?;
                link.SetDescription(&HSTRING::from("Write a new message"))?;
                let store: IPropertyStore = link.cast()?;
                store.SetValue(&PKEY_Title, &lpwstr("New Message"))?;
                store.Commit()?;
                tasks.AddObject(&link)?;
                list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
                list.CommitList()
            })()
        };
        if let Err(e) = r {
            log(format!("jump list FAILED {e}"));
        }
    }

    /// A VT_LPWSTR PROPVARIANT (InitPropVariantFromString is an inline header function, not an export). The string is
    /// CoTaskMem-allocated because PROPVARIANT's Drop is PropVariantClear, which frees it.
    fn lpwstr(s: &str) -> PROPVARIANT {
        let w: Vec<u16> = s.encode_utf16().chain(Some(0)).collect();
        let mut pv = PROPVARIANT::default();
        unsafe {
            let p = CoTaskMemAlloc(w.len() * 2) as *mut u16;
            if !p.is_null() {
                std::ptr::copy_nonoverlapping(w.as_ptr(), p, w.len());
                (*pv.Anonymous.Anonymous).vt = VT_LPWSTR;
                (*pv.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(p);
            }
        }
        pv
    }

    /// The default browser, Explorer or Settings: whatever the system has registered for this target.
    pub fn shell_open(target: &str) {
        unsafe {
            ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(target), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
        }
    }

    pub fn reveal_file(path: &str) {
        unsafe {
            ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from("explorer.exe"), &HSTRING::from(format!("/select,\"{path}\"")), PCWSTR::null(), SW_SHOWNORMAL);
        }
    }

    /// Settings opens on this app's own default-apps page (Windows 11 with the 2023-04 update or later), where one click
    /// makes it the mail handler; Windows does not let an app take a default itself.
    pub fn open_default_apps() {
        shell_open(&format!("ms-settings:defaultapps?registeredAppUser={}", REG_APP.replace(' ', "%20")));
    }

    pub fn webview_version() -> String {
        unsafe {
            let mut v = PWSTR::null();
            match GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut v) {
                Ok(()) if !v.is_null() => take_pwstr(v),
                _ => String::new(),
            }
        }
    }

    pub fn os_version() -> String {
        let k = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", KEY_READ);
        let Ok(k) = k else { return "Windows".into() };
        let build: String = k.get_value("CurrentBuild").unwrap_or_default();
        let ubr: u32 = k.get_value("UBR").unwrap_or(0);
        let disp: String = k.get_value("DisplayVersion").unwrap_or_default();
        let name = if build.parse::<u32>().unwrap_or(0) >= 22_000 { "Windows 11" } else { "Windows 10" };
        format!("{name} {disp} (build {build}.{ubr}) {}", std::env::consts::ARCH)
    }

    /// Browser chrome the shell does not want: the context menu loses navigation, save, print, share and capture (copy,
    /// paste, spelling and the page's own menus stay); the password manager stays out of the login form; and a crashed
    /// renderer reloads instead of leaving a grey window (WKWebView's webViewWebContentProcessDidTerminate, on the Mac).
    pub fn tune_webview(controller: ICoreWebView2Controller, devtools: bool) {
        unsafe {
            let Ok(core) = controller.CoreWebView2() else { return };
            if let Ok(s) = core.Settings().and_then(|s| s.cast::<ICoreWebView2Settings4>()) {
                let _ = s.SetIsPasswordAutosaveEnabled(false);
            }
            crate::launch_mark("webview tuned");
            // The page's DOMContentLoaded, as WebView2 sees it, in the navigation's own clock.
            if let Ok(c2) = core.cast::<ICoreWebView2_2>() {
                let mut token = 0i64;
                let _ = c2.add_DOMContentLoaded(
                    &DOMContentLoadedEventHandler::create(Box::new(|_, _| {
                        crate::nav_mark("DOMContentLoaded", false);
                        Ok(())
                    })),
                    &mut token,
                );
            }
            if let Ok(c11) = core.cast::<ICoreWebView2_11>() {
                let mut token = 0i64;
                let _ = c11.add_ContextMenuRequested(
                    &ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let _ = trim_menu(&args.MenuItems()?, devtools);
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }
            let mut token = 0i64;
            let _ = core.add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(|wv, args| {
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    if let Some(args) = args {
                        args.ProcessFailedKind(&mut kind)?;
                    }
                    log(format!("webview process failed kind={}", kind.0));
                    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                        if let Some(wv) = wv {
                            wv.Reload()?;
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    }

    const DROP: &[&str] = &[
        "back", "forward", "reload", "saveAs", "print", "createQrCode", "share", "webCapture", "openLinkInNewWindow", "saveLinkAs", "saveImageAs",
        "copyLinkToHighlight", "saveFrameAs",
    ];

    unsafe fn trim_menu(items: &ICoreWebView2ContextMenuItemCollection, devtools: bool) -> windows::core::Result<()> {
        let mut n = 0u32;
        items.Count(&mut n)?;
        for i in (0..n).rev() {
            let item = items.GetValueAtIndex(i)?;
            let mut name = PWSTR::null();
            item.Name(&mut name)?;
            let name = take_pwstr(name);
            if DROP.contains(&name.as_str()) || (!devtools && name == "inspectElement") {
                items.RemoveValueAtIndex(i)?;
            }
        }
        // Then no separator first, last, or twice in a row.
        let mut prev_sep = true;
        let mut i = 0u32;
        loop {
            let mut n = 0u32;
            items.Count(&mut n)?;
            if i >= n {
                break;
            }
            let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
            items.GetValueAtIndex(i)?.Kind(&mut kind)?;
            let sep = kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
            if sep && (prev_sep || i + 1 == n) {
                items.RemoveValueAtIndex(i)?;
                continue;
            }
            prev_sep = sep;
            i += 1;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
mod stub {
    use std::path::Path;
    pub fn early_init() {}
    pub fn register(_exe: &Path, _icon_png: &Path) {}
    pub fn set_login_item(_exe: &Path, _on: bool) {}
    pub fn login_item_set() -> bool {
        false
    }
    pub fn system_dark() -> bool {
        false
    }
    pub fn toast_show(_tag: &str, _xml: &str, _quiet: bool) -> Result<(), String> {
        Ok(())
    }
    pub fn toast_remove(_tag: &str) {}
    pub fn idle_secs() -> u64 {
        0
    }
    pub fn snooze_until() -> Option<String> {
        None
    }
    pub fn jump_list(_exe: &Path) {}
    pub fn shell_open(_target: &str) {}
    pub fn reveal_file(_path: &str) {}
    pub fn open_default_apps() {}
    pub fn webview_version() -> String {
        String::new()
    }
    pub fn os_version() -> String {
        std::env::consts::OS.into()
    }
}
