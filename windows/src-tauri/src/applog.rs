//! %LOCALAPPDATA%\com.sheritlabs.mail\logs\SheritMail.log: what the app did with notifications, sign-in and updates, the one
//! thing that cannot be checked from outside the app. Rotated at 256 KB (one previous file kept), and its tail is what the
//! app reports to the hub (notifier:report), since nobody can read this file on my PC from here.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());
const MAX: u64 = 262_144;

pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = FILE.set(dir.join("SheritMail.log"));
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn log(msg: impl AsRef<str>) {
    let line = format!("{} {}\n", crate::core::iso_utc(now_secs()), msg.as_ref());
    #[cfg(debug_assertions)]
    eprint!("{line}");
    let Some(path) = FILE.get() else { return };
    let _g = LOCK.lock();
    if fs::metadata(path).map(|m| m.len() > MAX).unwrap_or(false) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// The last `max` bytes of the log, starting at a line boundary.
pub fn tail(max: u64) -> String {
    let Some(path) = FILE.get() else { return String::new() };
    let _g = LOCK.lock();
    let Ok(mut f) = fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(max)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    if len > max {
        s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or(s)
    } else {
        s
    }
}
