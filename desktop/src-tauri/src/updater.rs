//! Auto-update: checks the Companion daemon's update feed (tauri.conf.json
//! `plugins.updater.endpoints`) at startup and every 6 hours, downloads and
//! verifies (minisign) a newer build in the background, then offers
//! "Restart to update" in the tray and the web layer (`updater-status` event).
//! With "install on quit" on (default), a ready update is installed when the
//! app quits, without relaunching.
//!
//! Quiet by design: no network, a 404 or a bad signature only log and surface
//! as `error` in the status (shown in Settings, never as a prompt).

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    AppHandle, Emitter, Manager, Wry,
};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const STATUS_EVENT: &str = "updater-status";
pub const TRAY_INSTALL_ID: &str = "update-install";
pub const TRAY_CHECK_ID: &str = "update-check";

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Wake-up granularity of the scheduler. Wall-clock based, so a laptop that
/// slept through the 6 hours checks soon after it wakes.
const TICK: Duration = Duration::from_secs(10 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const SETTINGS_FILE: &str = "updater.json";

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Running version.
    pub current_version: String,
    /// disabled | idle | checking | up-to-date | downloading | ready | installing | error
    pub state: String,
    /// Version of the available / ready update.
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
    pub auto_install_on_quit: bool,
    /// Unix ms of the last completed check.
    pub last_check: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    auto_install_on_quit: Option<bool>,
}

pub struct UpdaterState {
    status: Mutex<UpdateStatus>,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    busy: AtomicBool,
    tray: Mutex<Option<TrayItems>>,
}

struct TrayItems {
    menu: Menu<Wry>,
    check: MenuItem<Wry>,
    install: Option<(MenuItem<Wry>, PredefinedMenuItem<Wry>)>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether this build should self-update. Dev builds never do; on Linux only
/// the AppImage can replace itself (deb installs are managed by the user).
pub fn enabled() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if cfg!(target_os = "linux") {
        return std::env::var_os("APPIMAGE").is_some();
    }
    true
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

fn load_auto_install(app: &AppHandle) -> bool {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .and_then(|s| s.auto_install_on_quit)
        .unwrap_or(true)
}

fn save_auto_install(app: &AppHandle, value: bool) -> Result<(), String> {
    let path = settings_path(app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string(&Settings {
        auto_install_on_quit: Some(value),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

/// Register state and start the background checker. Call from setup().
pub fn init(app: &AppHandle) {
    let status = UpdateStatus {
        current_version: app.package_info().version.to_string(),
        state: if enabled() { "idle" } else { "disabled" }.into(),
        version: None,
        notes: None,
        error: None,
        auto_install_on_quit: load_auto_install(app),
        last_check: None,
    };
    app.manage(UpdaterState {
        status: Mutex::new(status),
        ready: Mutex::new(None),
        busy: AtomicBool::new(false),
        tray: Mutex::new(None),
    });
    if !enabled() {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("companion-updater".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            let mut last = SystemTime::UNIX_EPOCH;
            loop {
                let due = SystemTime::now()
                    .duration_since(last)
                    .map(|d| d >= CHECK_INTERVAL)
                    .unwrap_or(true);
                if due {
                    tauri::async_runtime::block_on(check(&app, false));
                    last = SystemTime::now();
                }
                std::thread::sleep(TICK);
            }
        })
        .ok();
}

/// Hand the tray menu and its "Check for updates" item to the updater so it
/// can add "Restart to update" when a build is ready.
pub fn attach_tray(app: &AppHandle, menu: Menu<Wry>, check: MenuItem<Wry>) {
    if let Some(state) = app.try_state::<UpdaterState>() {
        if !enabled() {
            let _ = check.set_enabled(false);
        }
        *state.tray.lock().unwrap() = Some(TrayItems {
            menu,
            check,
            install: None,
        });
        refresh_tray(app);
    }
}

fn snapshot(app: &AppHandle) -> Option<UpdateStatus> {
    app.try_state::<UpdaterState>()
        .map(|s| s.status.lock().unwrap().clone())
}

fn update_status(app: &AppHandle, f: impl FnOnce(&mut UpdateStatus)) {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return;
    };
    let status = {
        let mut st = state.status.lock().unwrap();
        f(&mut st);
        st.clone()
    };
    let _ = app.emit(STATUS_EVENT, status);
    refresh_tray(app);
}

fn refresh_tray(app: &AppHandle) {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return;
    };
    let status = state.status.lock().unwrap().clone();
    let mut guard = state.tray.lock().unwrap();
    let Some(tray) = guard.as_mut() else {
        return;
    };
    let check_text = match status.state.as_str() {
        "disabled" => "Updates: not available for this build".to_string(),
        "checking" => "Checking for updates...".to_string(),
        "downloading" => "Downloading update...".to_string(),
        "up-to-date" => format!("Up to date ({})", status.current_version),
        _ => "Check for updates".to_string(),
    };
    let _ = tray.check.set_text(check_text);
    let ready_version = if status.state == "ready" {
        status.version.clone()
    } else {
        None
    };
    match (ready_version, tray.install.as_ref()) {
        (Some(v), Some((item, _))) => {
            let _ = item.set_text(format!("Restart to update ({v})"));
        }
        (Some(v), None) => {
            let item = MenuItemBuilder::with_id(TRAY_INSTALL_ID, format!("Restart to update ({v})"))
                .build(app);
            let sep = PredefinedMenuItem::separator(app);
            if let (Ok(item), Ok(sep)) = (item, sep) {
                if tray.menu.insert_items(&[&item, &sep], 0).is_ok() {
                    tray.install = Some((item, sep));
                }
            }
            if let Some(t) = app.tray_by_id("main-tray") {
                let _ = t.set_tooltip(Some(format!("Companion: update {v} ready")));
            }
        }
        (None, Some(_)) => {
            if let Some((item, sep)) = tray.install.take() {
                let _ = tray.menu.remove(&item);
                let _ = tray.menu.remove(&sep);
            }
        }
        (None, None) => {}
    }
}

/// Check the feed; if a newer build exists, download + verify it so a later
/// "Restart to update" is instant. Concurrent calls are dropped.
pub async fn check(app: &AppHandle, manual: bool) -> Option<UpdateStatus> {
    if !enabled() {
        return snapshot(app);
    }
    let state = app.try_state::<UpdaterState>()?;
    if state.busy.swap(true, Ordering::SeqCst) {
        return snapshot(app);
    }
    struct Busy<'a>(&'a AtomicBool);
    impl Drop for Busy<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _busy = Busy(&state.busy);

    let had_ready = state.ready.lock().unwrap().is_some();
    if manual || !had_ready {
        update_status(app, |s| {
            s.state = "checking".into();
            s.error = None;
        });
    }
    let result = match app.updater_builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    match result {
        Ok(Some(update)) => {
            let ready_version = state
                .ready
                .lock()
                .unwrap()
                .as_ref()
                .map(|(u, _)| u.version.clone());
            if ready_version.as_deref() == Some(update.version.as_str()) {
                update_status(app, |s| {
                    s.state = "ready".into();
                    s.last_check = Some(now_ms());
                });
                return snapshot(app);
            }
            let version = update.version.clone();
            let notes = update.body.clone();
            update_status(app, |s| {
                s.state = "downloading".into();
                s.version = Some(version.clone());
                s.notes = notes.clone();
            });
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    log::info!("updater: {version} downloaded and verified");
                    *state.ready.lock().unwrap() = Some((update, bytes));
                    update_status(app, |s| {
                        s.state = "ready".into();
                        s.last_check = Some(now_ms());
                    });
                }
                Err(e) => {
                    log::warn!("updater: download of {version} failed: {e}");
                    update_status(app, |s| {
                        s.state = if had_ready { "ready" } else { "error" }.into();
                        s.error = Some(format!("Download failed: {e}"));
                        s.last_check = Some(now_ms());
                    });
                }
            }
        }
        Ok(None) => update_status(app, |s| {
            if !had_ready {
                s.state = "up-to-date".into();
                s.version = None;
                s.notes = None;
            } else {
                s.state = "ready".into();
            }
            s.error = None;
            s.last_check = Some(now_ms());
        }),
        Err(e) => {
            log::info!("updater: check failed: {e}");
            update_status(app, |s| {
                s.state = if had_ready { "ready" } else { "error" }.into();
                s.error = Some(friendly_error(&e.to_string()));
                s.last_check = Some(now_ms());
            });
        }
    }
    snapshot(app)
}

fn friendly_error(e: &str) -> String {
    let lower = e.to_lowercase();
    if lower.contains("404") || lower.contains("could not fetch a valid release json") {
        "No update feed published yet".into()
    } else if lower.contains("dns")
        || lower.contains("connect")
        || lower.contains("timed out")
        || lower.contains("network")
    {
        "Update server unreachable".into()
    } else {
        e.to_string()
    }
}

/// Install the downloaded update. `relaunch`: restart into the new version
/// (Windows: the installer relaunches; it also exits this process itself).
fn install_ready(app: &AppHandle, relaunch: bool) -> Result<bool, String> {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return Ok(false);
    };
    let Some((update, bytes)) = state.ready.lock().unwrap().take() else {
        return Ok(false);
    };
    update_status(app, |s| s.state = "installing".into());
    let version = update.version.clone();
    match update.restart_after_install(relaunch).install(&bytes) {
        Ok(()) => {
            log::info!("updater: installed {version}");
            Ok(true)
        }
        Err(e) => {
            log::warn!("updater: install of {version} failed: {e}");
            update_status(app, |s| {
                s.state = "error".into();
                s.error = Some(format!("Install failed: {e}"));
            });
            Err(e.to_string())
        }
    }
}

/// Tray "Restart to update" / the in-app button.
pub fn install_and_restart(app: &AppHandle) -> Result<(), String> {
    if install_ready(app, true)? {
        app.restart();
    }
    Ok(())
}

/// RunEvent::ExitRequested: apply a ready update on the way out.
pub fn on_exit(app: &AppHandle) {
    let auto = snapshot(app).map(|s| s.auto_install_on_quit).unwrap_or(false);
    if auto {
        let _ = install_ready(app, false);
    }
}

pub fn spawn_check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        check(&app, true).await;
    });
}

#[tauri::command]
pub fn updater_status(app: AppHandle) -> Option<UpdateStatus> {
    snapshot(&app)
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Option<UpdateStatus> {
    check(&app, true).await
}

#[tauri::command]
pub fn updater_install(app: AppHandle) -> Result<(), String> {
    install_and_restart(&app)
}

#[tauri::command]
pub fn updater_set_auto_install(app: AppHandle, enabled: bool) -> Result<Option<UpdateStatus>, String> {
    save_auto_install(&app, enabled)?;
    update_status(&app, |s| s.auto_install_on_quit = enabled);
    Ok(snapshot(&app))
}

#[cfg(test)]
mod tests {
    use super::friendly_error;

    #[test]
    fn friendly_errors() {
        assert_eq!(
            friendly_error("Could not fetch a valid release JSON from the remote"),
            "No update feed published yet"
        );
        assert_eq!(
            friendly_error("error sending request: dns error"),
            "Update server unreachable"
        );
        assert_eq!(friendly_error("weird"), "weird");
    }
}
