//! Herald floating orb: a small always-on-top, frameless, transparent window
//! that shows what Herald is doing (listening, thinking, speaking, a tone for
//! news) with a one-line caption, while the Companion window is elsewhere.
//!
//! The web layer decides *what* to show (`herald_overlay_update` with a view
//! computed by `web/src/services/heraldSetup/overlay.ts`); this module owns the
//! window: lazy creation, showing without taking focus, click-through except
//! over the orb and the stop button, dragging, and remembering the position.
//!
//! Focus and games: the window is created unfocused and not focusable
//! (Windows: WS_EX_NOACTIVATE + SW_SHOWNOACTIVATE via tao), skips the taskbar,
//! and never activates, so a full-screen game keeps focus. macOS: it joins all
//! Spaces and may sit over full-screen apps (FullScreenAuxiliary, status level).
//!
//! Also here: `herald_bring_to_front` (wake word / trigger shows Companion).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

pub const LABEL: &str = "herald-overlay";
const VIEW_EVENT: &str = "herald-overlay-view";
/// Logical size of the overlay window (the pill inside is smaller; the rest is transparent).
const WIDTH: f64 = 400.0;
const HEIGHT: f64 = 88.0;
/// Distance of the default position above the bottom of the screen (clears docks and taskbars).
const BOTTOM_GAP: f64 = 120.0;
const POLL: Duration = Duration::from_millis(40);
const SAVE_AFTER: Duration = Duration::from_millis(700);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayView {
    /// hidden | active | fading
    pub phase: String,
    /// listening | thinking | speaking | tone
    pub orb: String,
    pub caption: String,
}

/// An interactive area of the overlay page, in CSS pixels from its top-left.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }
}

#[derive(Default)]
struct Inner {
    view: Option<OverlayView>,
    regions: Vec<Rect>,
    /// Last value given to set_ignore_cursor_events (None: not set yet).
    ignoring: Option<bool>,
    /// Latest position and when it last changed (saved once it settles).
    moved: Option<(PhysicalPosition<i32>, Instant)>,
    polling: bool,
}

fn state() -> &'static Mutex<Inner> {
    static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Inner::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Inner> {
    state().lock().unwrap_or_else(|e| e.into_inner())
}

/// Is a cursor at `(cx, cy)` (physical, screen) over an interactive region of a
/// window at `origin` (physical) with `scale`? Pure, so it is unit tested.
fn over_regions(regions: &[Rect], origin: (f64, f64), scale: f64, cursor: (f64, f64)) -> bool {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let x = (cursor.0 - origin.0) / scale;
    let y = (cursor.1 - origin.1) / scale;
    regions.iter().any(|r| r.contains(x, y))
}

// ---------------------------------------------------------------- position

#[derive(Serialize, Deserialize)]
struct SavedPos {
    x: i32,
    y: i32,
}

fn pos_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("herald-overlay.json"))
}

fn load_pos(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let raw = std::fs::read_to_string(pos_file(app)?).ok()?;
    let p: SavedPos = serde_json::from_str(&raw).ok()?;
    let pos = PhysicalPosition::new(p.x, p.y);
    // A monitor that is gone would strand the orb off-screen: only reuse a
    // position that is still on one.
    let monitors = app.available_monitors().ok()?;
    monitors
        .iter()
        .any(|m| {
            let (mp, ms) = (m.position(), m.size());
            pos.x >= mp.x
                && pos.y >= mp.y
                && pos.x < mp.x + ms.width as i32 - 40
                && pos.y < mp.y + ms.height as i32 - 40
        })
        .then_some(pos)
}

fn save_pos(app: &AppHandle, pos: PhysicalPosition<i32>) {
    let Some(file) = pos_file(app) else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_string(&SavedPos { x: pos.x, y: pos.y }).unwrap_or_default();
    if let Err(e) = std::fs::write(&file, json) {
        log::warn!("herald overlay: could not save position: {e}");
    }
}

/// Bottom centre of the primary monitor, above the taskbar / dock.
fn default_pos(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let m = app.primary_monitor().ok().flatten()?;
    let s = m.scale_factor();
    let (mp, ms) = (m.position(), m.size());
    let x = mp.x + ((ms.width as f64 - WIDTH * s) / 2.0) as i32;
    let y = mp.y + (ms.height as f64 - (HEIGHT + BOTTOM_GAP) * s) as i32;
    Some(PhysicalPosition::new(x, y))
}

// ---------------------------------------------------------------- window

fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Herald")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        // The web bundle renders the overlay page instead of the app.
        .initialization_script("window.__HERALD_OVERLAY__ = true;");
    // Windows: every webview of the app shares one WebView2 environment, which
    // refuses a second webview with different browser arguments. Same as the
    // main window's (tauri.conf.json).
    #[cfg(windows)]
    let builder = builder.additional_browser_args(crate::WEBVIEW2_ARGS);
    let w = builder.build().map_err(|e| e.to_string())?;
    if let Some(pos) = load_pos(app).or_else(|| default_pos(app)) {
        let _ = w.set_position(pos);
    }
    let _ = w.set_ignore_cursor_events(false);
    lock().ignoring = Some(false);
    w.on_window_event(|ev| {
        if let WindowEvent::Moved(p) = ev {
            lock().moved = Some((*p, Instant::now()));
        }
    });
    #[cfg(target_os = "macos")]
    macos_float_over_fullscreen(&w);
    Ok(w)
}

/// macOS: stay visible on every Space and over full-screen apps, and never
/// join the Cmd+` window cycle.
#[cfg(target_os = "macos")]
fn macos_float_over_fullscreen(w: &WebviewWindow) {
    let win = w.clone();
    let _ = w.run_on_main_thread(move || {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let Ok(ptr) = win.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        // SAFETY: ns_window() is the live NSWindow of this window; we are on the main thread.
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let behavior = ns.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle;
        ns.setCollectionBehavior(behavior);
        // NSStatusWindowLevel: above normal and floating windows, below menus.
        ns.setLevel(25);
    });
}

/// Click-through everywhere except the orb and the stop button: watch the
/// cursor while the overlay is up and flip ignore-cursor-events as it enters
/// and leaves those regions. Also saves the position once a drag settles.
fn ensure_poller(app: &AppHandle) {
    {
        let mut st = lock();
        if st.polling {
            return;
        }
        st.polling = true;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        let Some(w) = app.get_webview_window(LABEL) else {
            lock().polling = false;
            return;
        };
        let visible = w.is_visible().unwrap_or(false);
        // Position first, so a drag that ends as the orb hides is still saved.
        let settled = {
            let mut st = lock();
            match st.moved {
                Some((pos, at)) if at.elapsed() >= SAVE_AFTER => {
                    st.moved = None;
                    Some(pos)
                }
                _ => None,
            }
        };
        if let Some(pos) = settled {
            save_pos(&app, pos);
        }
        if !visible {
            let mut st = lock();
            if st.moved.is_none() {
                st.polling = false;
                return;
            }
            continue;
        }
        let want_ignore = match (w.cursor_position(), w.outer_position(), w.scale_factor()) {
            (Ok(c), Ok(o), Ok(s)) => {
                let regions = lock().regions.clone();
                !over_regions(&regions, (o.x as f64, o.y as f64), s, (c.x, c.y))
            }
            // No cursor position (some Wayland sessions): stay clickable.
            _ => false,
        };
        let changed = {
            let mut st = lock();
            let changed = st.ignoring != Some(want_ignore);
            st.ignoring = Some(want_ignore);
            changed
        };
        if changed {
            let _ = w.set_ignore_cursor_events(want_ignore);
        }
    });
}

/// Show / update / hide the floating orb. `phase: "hidden"` hides it.
#[tauri::command]
pub async fn herald_overlay_update(app: AppHandle, view: OverlayView) -> Result<(), String> {
    let hidden = view.phase == "hidden";
    lock().view = Some(view.clone());
    let existing = app.get_webview_window(LABEL);
    if hidden {
        if let Some(w) = existing {
            let _ = app.emit_to(LABEL, VIEW_EVENT, &view);
            let _ = w.hide();
        }
        return Ok(());
    }
    let w = match existing {
        Some(w) => w,
        None => create(&app)?,
    };
    let _ = app.emit_to(LABEL, VIEW_EVENT, &view);
    if !w.is_visible().unwrap_or(false) {
        // Not focusable: showing never activates it (a game keeps focus).
        let _ = w.show();
        ensure_poller(&app);
    }
    Ok(())
}

/// The overlay page loaded: send it the current view (it may have missed it).
#[tauri::command]
pub fn herald_overlay_ready(app: AppHandle) {
    if let Some(view) = lock().view.clone() {
        let _ = app.emit_to(LABEL, VIEW_EVENT, &view);
    }
}

/// Interactive regions (orb, stop button) in CSS pixels; everything else clicks through.
#[tauri::command]
pub fn herald_overlay_regions(regions: Vec<Rect>) {
    let mut st = lock();
    st.regions = regions.into_iter().take(8).collect();
    // Re-evaluate on the next poll.
    st.ignoring = None;
}

/// Start dragging the overlay (pointer down on the orb).
#[tauri::command]
pub fn herald_overlay_drag(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.start_dragging();
    }
}

/// Overlay buttons: `stop` stops Herald (same as the stop trigger), `open`
/// brings Companion to the front.
#[tauri::command]
pub fn herald_overlay_action(app: AppHandle, action: String) {
    match action.as_str() {
        "stop" => crate::herald::emit(&app, "stop"),
        "open" => bring_main_to_front(&app),
        _ => {}
    }
}

fn bring_main_to_front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// "Hey Jarvis" or a trigger: show and focus the Companion window (the web
/// layer gates it: setting on, never in the Gaming profile).
#[tauri::command]
pub fn herald_bring_to_front(app: AppHandle) {
    bring_main_to_front(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_hit_test_in_css_pixels() {
        let regions = [
            Rect {
                x: 10.0,
                y: 10.0,
                w: 60.0,
                h: 60.0,
            },
            Rect {
                x: 340.0,
                y: 28.0,
                w: 32.0,
                h: 32.0,
            },
        ];
        // Window at (1000, 500) on a 2x display: CSS (20, 20) is physical (1040, 540).
        assert!(over_regions(
            &regions,
            (1000.0, 500.0),
            2.0,
            (1040.0, 540.0)
        ));
        assert!(over_regions(
            &regions,
            (1000.0, 500.0),
            2.0,
            (1000.0 + 350.0 * 2.0, 500.0 + 40.0 * 2.0)
        ));
        // The caption between them clicks through.
        assert!(!over_regions(
            &regions,
            (1000.0, 500.0),
            2.0,
            (1000.0 + 200.0 * 2.0, 540.0)
        ));
        // Outside the window entirely.
        assert!(!over_regions(&regions, (1000.0, 500.0), 2.0, (10.0, 10.0)));
        // A zero scale is treated as 1.
        assert!(over_regions(&regions, (0.0, 0.0), 0.0, (20.0, 20.0)));
        assert!(!over_regions(&[], (0.0, 0.0), 1.0, (20.0, 20.0)));
    }

    #[test]
    fn view_uses_camel_case_json() {
        let v: OverlayView =
            serde_json::from_str(r#"{"phase":"active","orb":"speaking","caption":"Hi"}"#).unwrap();
        assert_eq!(v.orb, "speaking");
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"phase":"active","orb":"speaking","caption":"Hi"}"#
        );
    }
}
