//! Native desktop Herald: system-wide shortcuts (true hold-to-talk), tray
//! actions, and the WebView microphone permission.
//!
//! Everything here only *delivers* input to the web layer as a `herald-native`
//! event `{ action }`. The web layer owns the behaviour (push-to-talk, the
//! remote-trigger `toggle` / `brief` logic, tones), so nothing is duplicated.
//!
//! Actions: `talk_down`, `talk_up` (hold-to-talk), `toggle`, `brief`,
//! `mute_tones`.
//!
//! TODO(plan.md "Voice Front Layer" Phase 2 / "Native desktop Herald"): Discord
//! mic hiding and ducking other audio need native OS audio control (PipeWire,
//! Windows audio sessions, CoreAudio). They belong here, driven by the same
//! `herald_set_audio_focus`-style seam the mobile plugin exposes
//! (`plugin:herald-native|set_audio_focus`), which is a no-op on desktop today.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{menu::CheckMenuItem, AppHandle, Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const EVENT: &str = "herald-native";

#[derive(Clone, Serialize)]
struct NativeEvent {
    action: &'static str,
}

pub fn emit(app: &AppHandle, action: &'static str) {
    let _ = app.emit(EVENT, NativeEvent { action });
}

/// Shortcuts this module registered (so a reconfigure removes exactly those).
#[derive(Default)]
pub struct Registered(Mutex<Vec<Shortcut>>);

/// The tray's "Mute tones" check item, kept in sync with the web preference.
#[derive(Default)]
pub struct TrayState(pub Mutex<Option<CheckMenuItem<Wry>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutConfig {
    /// Hold to talk (pressed and released).
    pub talk: Option<String>,
    /// Tap: stop speaking / cancel listening / start listening.
    pub toggle: Option<String>,
    /// Tap: brief me.
    pub brief: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutResult {
    pub name: &'static str,
    pub accelerator: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInfo {
    pub os: &'static str,
    /// Running under a Wayland session (system-wide shortcuts are limited).
    pub wayland: bool,
}

fn on_shortcut(app: &AppHandle, name: &'static str, state: ShortcutState) {
    match (name, state) {
        ("talk", ShortcutState::Pressed) => emit(app, "talk_down"),
        ("talk", ShortcutState::Released) => emit(app, "talk_up"),
        ("toggle", ShortcutState::Pressed) => emit(app, "toggle"),
        ("brief", ShortcutState::Pressed) => emit(app, "brief"),
        _ => {}
    }
}

/// Replace the Herald shortcuts. Empty / missing entries are left unbound.
/// Returns one result per requested shortcut so the UI can show conflicts
/// (e.g. another app already owns the chord).
#[tauri::command]
pub fn herald_set_shortcuts(app: AppHandle, config: ShortcutConfig) -> Vec<ShortcutResult> {
    let gs = app.global_shortcut();
    let state = app.state::<Registered>();
    let mut registered = state.0.lock().unwrap_or_else(|e| e.into_inner());
    for sc in registered.drain(..) {
        let _ = gs.unregister(sc);
    }
    let mut out = Vec::new();
    for (name, accel) in [
        ("talk", config.talk),
        ("toggle", config.toggle),
        ("brief", config.brief),
    ] {
        let Some(accel) = accel
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
        else {
            continue;
        };
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
                });
            }
            Err(e) => {
                log::warn!("herald shortcut {name} ({accel}) failed: {e}");
                out.push(ShortcutResult {
                    name,
                    accelerator: accel,
                    ok: false,
                    error: Some(e),
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
    }
}

/// Mirror the web "tones" preference on the tray check item.
#[tauri::command]
pub fn herald_set_tray_state(app: AppHandle, tones_muted: bool) {
    if let Some(item) = app
        .state::<TrayState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        let _ = item.set_checked(tones_muted);
    }
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
    fn default_chords_parse() {
        for a in [
            "Ctrl+Alt+Space",
            "Ctrl+Alt+Shift+H",
            "Ctrl+Alt+Shift+B",
            "Super+Shift+KeyK",
        ] {
            assert!(a.parse::<Shortcut>().is_ok(), "{a}");
        }
    }

    #[test]
    fn own_origin_only() {
        assert!(is_own_origin("tauri://localhost/index.html"));
        assert!(is_own_origin("http://tauri.localhost/"));
        assert!(!is_own_origin("https://example.com/"));
        assert!(!is_own_origin("http://tauri.localhost.evil.com/"));
    }
}
