//! Native desktop Herald: system-wide shortcuts (true hold-to-talk), tray
//! actions, and the WebView microphone permission.
//!
//! Everything here only *delivers* input to the web layer as a `herald-native`
//! event `{ action }`. The web layer owns the behaviour (push-to-talk, the
//! remote-trigger `toggle` / `brief` logic, tones), so nothing is duplicated.
//!
//! Actions: `talk_down`, `talk_up` (hold-to-talk), `toggle`, `brief`, `stop`,
//! `mute_tones`, and from the tray `volume_up`, `volume_down`, `volume_set`
//! (with a `value`, 0..1.5).
//!
//! A shortcut is registered one of two ways. Exclusive (the global-shortcut
//! plugin): the OS hands the chord to us and nobody else. Passthrough
//! (`passthrough.rs`): observed with a low-level hook / listen-only tap, so
//! another app bound to the same chord (Discord push-to-mute) still gets it.
//! A passthrough chord is never also registered exclusively; if it cannot be
//! observed (Linux, macOS without Input Monitoring) it falls back to
//! exclusive and the result says why.
//!
//! TODO(plan.md "Voice Front Layer" Phase 2 / "Native desktop Herald"): Discord
//! mic hiding and ducking other audio need native OS audio control (PipeWire,
//! Windows audio sessions, CoreAudio). They belong here, driven by the same
//! `herald_set_audio_focus`-style seam the mobile plugin exposes
//! (`plugin:herald-native|set_audio_focus`), which is a no-op on desktop today.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, MenuItem},
    AppHandle, Emitter, Manager, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const EVENT: &str = "herald-native";

#[derive(Clone, Serialize)]
struct NativeEvent {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<f64>,
}

pub fn emit(app: &AppHandle, action: &'static str) {
    let _ = app.emit(EVENT, NativeEvent { action, value: None });
}

pub fn emit_value(app: &AppHandle, action: &'static str, value: f64) {
    let _ = app.emit(
        EVENT,
        NativeEvent {
            action,
            value: Some(value),
        },
    );
}

/// Shortcuts this module registered (so a reconfigure removes exactly those).
#[derive(Default)]
pub struct Registered(Mutex<Vec<Shortcut>>);

/// Tray items kept in sync with the web preferences: "Mute tones" and the
/// volume levels (percent, item).
pub struct TrayState {
    pub tones: Mutex<Option<CheckMenuItem<Wry>>>,
    pub volumes: Mutex<Vec<(u32, CheckMenuItem<Wry>)>>,
    /// "Hide floating orb" / "Show floating orb" (text follows the setting).
    pub orb: Mutex<Option<MenuItem<Wry>>>,
    /// The orb setting as last reported (the tray item toggles it).
    pub orb_enabled: Mutex<bool>,
}

/// Tray id of the floating orb toggle.
pub const TRAY_ORB_ID: &str = "herald-orb";

/// The tray item's text for the current orb setting.
pub fn orb_tray_label(enabled: bool) -> &'static str {
    if enabled {
        "Hide floating orb"
    } else {
        "Show floating orb"
    }
}

/// Mirror the orb setting in the tray item.
pub fn set_orb_tray(app: &AppHandle, enabled: bool) {
    let Some(tray) = app.try_state::<TrayState>() else {
        return;
    };
    *tray.orb_enabled.lock().unwrap_or_else(|e| e.into_inner()) = enabled;
    let item = tray.orb.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(item) = item {
        let _ = item.set_text(orb_tray_label(enabled));
    }
}

/// Tray "Hide floating orb" / "Show floating orb": flip it natively at once
/// (hidden immediately, even before the web layer answers) and tell the web
/// layer, which saves it as the "Show floating orb" setting of the profile.
pub fn toggle_orb_from_tray(app: &AppHandle) {
    let enabled = app
        .try_state::<TrayState>()
        .map(|t| *t.orb_enabled.lock().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or(true);
    let next = !enabled;
    emit_value(app, "orb", if next { 1.0 } else { 0.0 });
    // Off the main thread: it may create or hide the overlay window.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::overlay::set_enabled(&app, next) {
            log::warn!("herald overlay: {e}");
        }
    });
}

/// The tray's volume levels (percent).
pub const TRAY_VOLUMES: [u32; 6] = [25, 50, 80, 100, 125, 150];

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PassthroughConfig {
    pub talk: bool,
    pub toggle: bool,
    pub brief: bool,
    pub stop: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutConfig {
    /// Hold to talk (pressed and released).
    pub talk: Option<String>,
    /// Tap: stop speaking / cancel listening / start listening.
    pub toggle: Option<String>,
    /// Tap: brief me.
    pub brief: Option<String>,
    /// Tap: stop Herald speaking (on any device).
    #[serde(default)]
    pub stop: Option<String>,
    /// Per shortcut: observe without taking the keys (other apps still get them).
    #[serde(default)]
    pub passthrough: PassthroughConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutResult {
    pub name: &'static str,
    pub accelerator: String,
    pub ok: bool,
    pub error: Option<String>,
    /// "exclusive" (only Companion gets the keys) or "passthrough" (observed).
    pub mode: &'static str,
    /// Passthrough was asked for but is not possible: "unsupported" (Linux),
    /// "needs_permission" (macOS Input Monitoring), "key_unsupported", "hook_failed...".
    pub passthrough_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInfo {
    pub os: &'static str,
    /// Running under a Wayland session (system-wide shortcuts are limited).
    pub wayland: bool,
    /// Passthrough shortcuts work on this OS (Windows, macOS).
    pub passthrough: bool,
}

fn on_shortcut(app: &AppHandle, name: &'static str, state: ShortcutState) {
    match (name, state) {
        ("talk", ShortcutState::Pressed) => emit(app, "talk_down"),
        ("talk", ShortcutState::Released) => emit(app, "talk_up"),
        ("toggle", ShortcutState::Pressed) => emit(app, "toggle"),
        ("brief", ShortcutState::Pressed) => emit(app, "brief"),
        ("stop", ShortcutState::Pressed) => emit(app, "stop"),
        _ => {}
    }
}

/// A passthrough chord was pressed (true) or released (false).
pub fn on_observed(app: &AppHandle, name: &'static str, pressed: bool) {
    on_shortcut(
        app,
        name,
        if pressed {
            ShortcutState::Pressed
        } else {
            ShortcutState::Released
        },
    );
}

/// Replace the Herald shortcuts. Empty / missing entries are left unbound.
/// Returns one result per requested shortcut so the UI can show conflicts
/// (e.g. another app already owns the chord) and how each one is held.
#[tauri::command]
pub fn herald_set_shortcuts(app: AppHandle, config: ShortcutConfig) -> Vec<ShortcutResult> {
    let gs = app.global_shortcut();
    let state = app.state::<Registered>();
    let mut registered = state.0.lock().unwrap_or_else(|e| e.into_inner());
    for sc in registered.drain(..) {
        let _ = gs.unregister(sc);
    }
    let pt = &config.passthrough;
    let wanted: Vec<(&'static str, String, bool)> = [
        ("talk", config.talk, pt.talk),
        ("toggle", config.toggle, pt.toggle),
        ("brief", config.brief, pt.brief),
        ("stop", config.stop, pt.stop),
    ]
    .into_iter()
    .filter_map(|(name, accel, pass)| {
        accel
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .map(|a| (name, a, pass))
    })
    .collect();

    // Observed chords first (an empty list stops the hook).
    let observed = crate::passthrough::apply(
        &app,
        wanted
            .iter()
            .filter(|(_, _, pass)| *pass)
            .map(|(n, a, _)| (*n, a.clone()))
            .collect(),
    );
    let mut out = Vec::new();
    for (name, accel, pass) in wanted {
        let mut passthrough_error = None;
        if pass {
            match observed.iter().find(|(n, _)| *n == name).map(|(_, r)| r) {
                Some(Ok(())) => {
                    out.push(ShortcutResult {
                        name,
                        accelerator: accel,
                        ok: true,
                        error: None,
                        mode: "passthrough",
                        passthrough_error: None,
                    });
                    continue;
                }
                Some(Err(e)) => passthrough_error = Some(e.clone()),
                None => passthrough_error = Some("unsupported".into()),
            }
        }
        let result = accel
            .parse::<Shortcut>()
            .map_err(|e| e.to_string())
            .and_then(|sc| {
                gs.on_shortcut(sc, move |app, _sc, ev| on_shortcut(app, name, ev.state))
                    .map(|_| sc)
                    .map_err(|e| e.to_string())
            });
        match result {
            Ok(sc) => {
                registered.push(sc);
                out.push(ShortcutResult {
                    name,
                    accelerator: accel,
                    ok: true,
                    error: None,
                    mode: "exclusive",
                    passthrough_error,
                });
            }
            Err(e) => {
                log::warn!("herald shortcut {name} ({accel}) failed: {e}");
                out.push(ShortcutResult {
                    name,
                    accelerator: accel,
                    ok: false,
                    error: Some(e),
                    mode: "exclusive",
                    passthrough_error,
                });
            }
        }
    }
    out
}

#[tauri::command]
pub fn herald_native_info() -> NativeInfo {
    NativeInfo {
        os: std::env::consts::OS,
        wayland: is_wayland(),
        passthrough: crate::passthrough::supported(),
    }
}

/// Passthrough status: running, macOS permission, Windows elevation.
#[tauri::command]
pub fn herald_passthrough_status() -> crate::passthrough::Status {
    crate::passthrough::status()
}

/// macOS: ask for Input Monitoring (system prompt once, then the settings pane).
/// Returns true when already granted.
#[tauri::command]
pub fn herald_request_input_monitoring() -> bool {
    crate::passthrough::request_permission()
}

/// macOS: open System Settings > Privacy & Security > Input Monitoring
/// (no prompt). False elsewhere.
#[tauri::command]
pub fn herald_open_input_monitoring() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn()
            .is_ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Mirror the web "tones" preference and Herald's volume on the tray items.
#[tauri::command]
pub fn herald_set_tray_state(app: AppHandle, tones_muted: bool, volume: Option<f64>) {
    let tray = app.state::<TrayState>();
    if let Some(item) = tray
        .tones
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        let _ = item.set_checked(tones_muted);
    }
    if let Some(v) = volume {
        let pct = (v * 100.0).round() as i64;
        for (level, item) in tray.volumes.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            let _ = item.set_checked(i64::from(*level) == pct);
        }
    }
}

/// Tray menu ids for the volume levels: "herald-vol-80" -> 0.8.
pub fn tray_volume_level(id: &str) -> Option<f64> {
    let pct: u32 = id.strip_prefix("herald-vol-")?.parse().ok()?;
    TRAY_VOLUMES.contains(&pct).then(|| f64::from(pct) / 100.0)
}

fn is_wayland() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Let our own page use the microphone without a WebView prompt. macOS needs
/// nothing here: wry's WKUIDelegate grants media capture and macOS shows its
/// own one-time system prompt (NSMicrophoneUsageDescription in Info.plist).
pub fn setup_mic_permission(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    #[cfg(target_os = "linux")]
    {
        let _ = window.with_webview(|wv| {
            use webkit2gtk::glib::prelude::*;
            use webkit2gtk::{
                DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt,
                UserMediaPermissionRequest, WebViewExt,
            };
            let view = wv.inner();
            if let Some(settings) = WebViewExt::settings(&view) {
                settings.set_enable_media_stream(true);
                settings.set_media_playback_requires_user_gesture(false);
            }
            view.connect_permission_request(|view, req| {
                let ours = view
                    .uri()
                    .map(|u| is_own_origin(u.as_str()))
                    .unwrap_or(false);
                if ours
                    && (req.is::<UserMediaPermissionRequest>()
                        || req.is::<DeviceInfoPermissionRequest>())
                {
                    req.allow();
                    return true;
                }
                false
            });
        });
    }

    #[cfg(target_os = "windows")]
    {
        let _ = window.with_webview(|wv| unsafe {
            use webview2_com::{take_pwstr, Microsoft::Web::WebView2::Win32::*, *};
            let Ok(core) = wv.controller().CoreWebView2() else {
                return;
            };
            let mut token: i64 = 0;
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        return Ok(());
                    }
                    let mut uri = windows::core::PWSTR::null();
                    args.Uri(&mut uri)?;
                    if is_own_origin(&take_pwstr(uri)) {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                    Ok(())
                })),
                &mut token,
            );
        });
    }

    let _ = window;
}

/// The app's own page (bundled or the dev server), never a remote site.
#[allow(dead_code)]
fn is_own_origin(uri: &str) -> bool {
    [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost",
        "http://127.0.0.1",
    ]
    .iter()
    .any(|origin| {
        uri.strip_prefix(origin)
            .map(|rest| rest.is_empty() || rest.starts_with(['/', ':', '?', '#']))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orb_tray_item_says_what_it_will_do() {
        assert_eq!(orb_tray_label(true), "Hide floating orb");
        assert_eq!(orb_tray_label(false), "Show floating orb");
    }

    #[test]
    fn default_chords_parse() {
        for a in [
            "Ctrl+Alt+Space",
            "Ctrl+Alt+Shift+H",
            "Ctrl+Alt+Shift+B",
            "Ctrl+Alt+Shift+S",
            "Super+Shift+KeyK",
        ] {
            assert!(a.parse::<Shortcut>().is_ok(), "{a}");
        }
    }

    #[test]
    fn stop_chord_parses_and_tray_levels() {
        assert!("Ctrl+Alt+Shift+KeyS".parse::<Shortcut>().is_ok());
        assert_eq!(tray_volume_level("herald-vol-80"), Some(0.8));
        assert_eq!(tray_volume_level("herald-vol-150"), Some(1.5));
        assert_eq!(tray_volume_level("herald-vol-77"), None);
        assert_eq!(tray_volume_level("herald-vol-up"), None);
    }

    #[test]
    fn shortcut_config_defaults() {
        let c: ShortcutConfig =
            serde_json::from_str(r#"{"talk":"Ctrl+Alt+Space","toggle":null,"brief":null}"#).unwrap();
        assert!(c.stop.is_none());
        assert!(!c.passthrough.talk);
        let c: ShortcutConfig = serde_json::from_str(
            r#"{"talk":"Ctrl+Alt+Space","toggle":null,"brief":null,"stop":"Ctrl+Alt+Shift+KeyS","passthrough":{"talk":true}}"#,
        )
        .unwrap();
        assert!(c.passthrough.talk && !c.passthrough.stop);
        assert_eq!(c.stop.as_deref(), Some("Ctrl+Alt+Shift+KeyS"));
    }

    #[test]
    fn own_origin_only() {
        assert!(is_own_origin("tauri://localhost/index.html"));
        assert!(is_own_origin("http://tauri.localhost/"));
        assert!(!is_own_origin("https://example.com/"));
        assert!(!is_own_origin("http://tauri.localhost.evil.com/"));
    }
}
