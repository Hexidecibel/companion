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
//! Never stuck on screen: every update (and the cursor poller, as a backstop)
//! reconciles the window with the LATEST wanted view under one lock, so two
//! commands racing (a hide arriving while the first show is still creating
//! the window) can no longer leave it visible with nothing in it. The window
//! has no menu bar (Windows / Linux attach the app menu to every window), is
//! kept out of the window-state plugin (which would restore it visible), and
//! the tray's "Hide floating orb" turns it off at once.
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
    /// The orb is turned off (tray "Hide floating orb", or the web setting):
    /// never shown, whatever views arrive.
    suppressed: bool,
}

/// Serializes window changes (create / show / hide), so the latest wanted
/// view always wins.
fn apply_lock() -> std::sync::MutexGuard<'static, ()> {
    static APPLY: OnceLock<Mutex<()>> = OnceLock::new();
    APPLY
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The window should be on screen: a non-hidden view and the orb not turned off.
fn wants_visible(view: Option<&OverlayView>, suppressed: bool) -> bool {
    !suppressed && view.is_some_and(|v| v.phase != "hidden")
}

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Nothing,
    Hide,
    Show,
    CreateAndShow,
}

/// What to do to the window to match what is wanted. Pure, so it is unit tested.
fn plan(want_visible: bool, exists: bool, visible: bool) -> Step {
    match (want_visible, exists, visible) {
        (true, false, _) => Step::CreateAndShow,
        (true, true, false) => Step::Show,
        (false, true, true) => Step::Hide,
        _ => Step::Nothing,
    }
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
    // Windows / Linux attach the app menu ("Companion File Edit View Window")
    // to every window that does not have its own; on this frameless,
    // transparent window it would be the only visible thing. Remove it before
    // the window is ever shown, and restore the content size it took.
    // (macOS: the menu is app-wide, never part of a window.)
    #[cfg(not(target_os = "macos"))]
    {
        let _ = w.remove_menu();
        let _ = w.set_size(tauri::LogicalSize::new(WIDTH, HEIGHT));
    }
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
        // Backstop: visible while nothing is wanted (a lost or reordered
        // update) -> hide now.
        if visible {
            let want = {
                let st = lock();
                wants_visible(st.view.as_ref(), st.suppressed)
            };
            if !want {
                let _guard = apply_lock();
                let _ = w.hide();
                continue;
            }
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

/// Make the window match the latest wanted view (under the apply lock).
fn reconcile(app: &AppHandle) -> Result<(), String> {
    let _guard = apply_lock();
    let (view, suppressed) = {
        let st = lock();
        (st.view.clone(), st.suppressed)
    };
    let want = wants_visible(view.as_ref(), suppressed);
    let existing = app.get_webview_window(LABEL);
    let visible = existing
        .as_ref()
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let step = plan(want, existing.is_some(), visible);
    let w = match (step, existing) {
        (Step::CreateAndShow, _) => Some(create(app)?),
        (_, w) => w,
    };
    let Some(w) = w else { return Ok(()) };
    if let Some(v) = &view {
        let shown = if want {
            v.clone()
        } else {
            OverlayView {
                phase: "hidden".into(),
                ..v.clone()
            }
        };
        let _ = app.emit_to(LABEL, VIEW_EVENT, &shown);
    }
    match plan(want, true, w.is_visible().unwrap_or(false)) {
        Step::Show => {
            // Not focusable: showing never activates it (a game keeps focus).
            let _ = w.show();
            ensure_poller(app);
        }
        Step::Hide => {
            let _ = w.hide();
        }
        _ => {}
    }
    Ok(())
}

/// Show / update / hide the floating orb. `phase: "hidden"` hides it.
#[tauri::command]
pub async fn herald_overlay_update(app: AppHandle, view: OverlayView) -> Result<(), String> {
    lock().view = Some(view);
    reconcile(&app)
}

/// The floating orb is turned on / off for this device and profile (the web
/// setting, or the tray). Off hides it at once and keeps it hidden.
#[tauri::command]
pub async fn herald_overlay_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_enabled(&app, enabled)
}

pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    lock().suppressed = !enabled;
    crate::herald::set_orb_tray(app, enabled);
    reconcile(app)
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

    fn view(phase: &str) -> OverlayView {
        OverlayView {
            phase: phase.into(),
            orb: "speaking".into(),
            caption: "Hi".into(),
        }
    }

    #[test]
    fn wanted_only_with_a_live_view_and_not_suppressed() {
        assert!(!wants_visible(None, false));
        assert!(!wants_visible(Some(&view("hidden")), false));
        assert!(wants_visible(Some(&view("active")), false));
        assert!(wants_visible(Some(&view("fading")), false));
        // Turned off (tray / Gaming profile setting): never shown.
        assert!(!wants_visible(Some(&view("active")), true));
    }

    #[test]
    fn plan_matches_the_window_to_the_wanted_state() {
        assert_eq!(plan(true, false, false), Step::CreateAndShow);
        assert_eq!(plan(true, true, false), Step::Show);
        assert_eq!(plan(true, true, true), Step::Nothing);
        assert_eq!(plan(false, true, true), Step::Hide);
        assert_eq!(plan(false, true, false), Step::Nothing);
        // Nothing wanted and no window: never create one just to hide it.
        assert_eq!(plan(false, false, false), Step::Nothing);
    }

    /// The race behind a stuck, empty overlay: a "hidden" update lands while
    /// the first "active" one is still creating the window. Reconciling
    /// against the latest view (not the call's own argument) hides it.
    #[test]
    fn a_late_show_after_hide_reconciles_to_hidden() {
        let latest = view("hidden");
        // The slow show finishes creating the window and checks again.
        let step = plan(wants_visible(Some(&latest), false), true, false);
        assert_eq!(step, Step::Nothing);
        // A window someone left visible is hidden by the poller backstop.
        assert!(!wants_visible(Some(&latest), false));
        assert_eq!(plan(false, true, true), Step::Hide);
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
