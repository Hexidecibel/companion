//! Passthrough hotkeys: OBSERVE a chord without consuming it, so another app
//! (Discord push-to-mute on the same Ctrl+Alt+Space) still receives it.
//!
//! The global-shortcut plugin registers chords exclusively (RegisterHotKey on
//! Windows, Carbon hotkeys on macOS): the OS hands the keys to us and nobody
//! else. A passthrough chord is never registered there. Instead:
//!
//!   Windows  a low-level keyboard hook (WH_KEYBOARD_LL) on its own thread with
//!            a message loop; the callback only posts the key to a channel and
//!            always calls CallNextHookEx (it never swallows a key).
//!   macOS    a listen-only CGEventTap (needs Input Monitoring permission).
//!   Linux    not supported (X11 XRecord would work but is not wired; Wayland
//!            has no global key access at all): the chord stays exclusive.
//!
//! Every key event goes to ONE worker thread that runs the pure state machine
//! below (`ChordWatcher`: press / release / modifiers / auto-repeat) and emits
//! the same `herald-native` actions as the plugin (`talk_down`, `talk_up`,
//! `toggle`, `brief`, `stop`). Keys are only compared with the chords; nothing
//! is logged or stored.

// Linux has no hook: the platform glue (and what only it uses) is not built there.
#![cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]

use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

// ---------------------------------------------------------------- pure part

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

impl Mods {
    /// Every modifier `need` asks for is held.
    pub fn contains(&self, need: &Mods) -> bool {
        (!need.ctrl || self.ctrl)
            && (!need.alt || self.alt)
            && (!need.shift || self.shift)
            && (!need.meta || self.meta)
    }
}

/// A chord: modifiers + one main key (a `KeyboardEvent.code`-style name).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub mods: Mods,
    pub key: String,
}

/// "Ctrl+Alt+Space", "Ctrl+Alt+Shift+KeyH", "Super+F13" -> Chord.
pub fn parse_accelerator(accel: &str) -> Option<Chord> {
    let mut mods = Mods::default();
    let mut key: Option<String> = None;
    for part in accel.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods.ctrl = true,
            "alt" | "option" => mods.alt = true,
            "shift" => mods.shift = true,
            "super" | "meta" | "cmd" | "command" | "win" => mods.meta = true,
            "cmdorctrl" | "commandorcontrol" => {
                if cfg!(target_os = "macos") {
                    mods.meta = true
                } else {
                    mods.ctrl = true
                }
            }
            _ => {
                if key.is_some() {
                    return None;
                }
                key = Some(canonical_key(part)?);
            }
        }
    }
    Some(Chord { mods, key: key? })
}

/// "h" / "KeyH" -> "KeyH", "1" / "Digit1" -> "Digit1", "space" -> "Space".
pub fn canonical_key(k: &str) -> Option<String> {
    let lower = k.to_ascii_lowercase();
    if k.len() == 1 {
        let c = k.chars().next()?.to_ascii_uppercase();
        if c.is_ascii_alphabetic() {
            return Some(format!("Key{c}"));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{c}"));
        }
    }
    if let Some(rest) = lower.strip_prefix("key") {
        if rest.len() == 1 && rest.chars().all(|c| c.is_ascii_alphabetic()) {
            return Some(format!("Key{}", rest.to_ascii_uppercase()));
        }
    }
    if let Some(rest) = lower.strip_prefix("digit") {
        if rest.len() == 1 && rest.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("Digit{rest}"));
        }
    }
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=24).contains(&n) {
            return Some(format!("F{n}"));
        }
    }
    let named = match lower.as_str() {
        "space" => "Space",
        "enter" | "return" => "Enter",
        "tab" => "Tab",
        "escape" | "esc" => "Escape",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "arrowup" | "up" => "ArrowUp",
        "arrowdown" | "down" => "ArrowDown",
        "arrowleft" | "left" => "ArrowLeft",
        "arrowright" | "right" => "ArrowRight",
        "minus" => "Minus",
        "equal" => "Equal",
        "bracketleft" => "BracketLeft",
        "bracketright" => "BracketRight",
        "backslash" => "Backslash",
        "semicolon" => "Semicolon",
        "quote" => "Quote",
        "backquote" => "Backquote",
        "comma" => "Comma",
        "period" => "Period",
        "slash" => "Slash",
        _ => return None,
    };
    Some(named.to_string())
}

/// Windows virtual-key code for a canonical key.
pub fn windows_vk(key: &str) -> Option<u32> {
    if let Some(c) = key.strip_prefix("Key") {
        return c.chars().next().map(|c| c as u32); // 'A'..'Z' = 0x41..0x5A
    }
    if let Some(d) = key.strip_prefix("Digit") {
        return d.chars().next().map(|c| c as u32); // '0'..'9' = 0x30..0x39
    }
    if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return Some(0x6F + n); // F1 = 0x70 .. F24 = 0x87
    }
    Some(match key {
        "Space" => 0x20,
        "Enter" => 0x0D,
        "Tab" => 0x09,
        "Escape" => 0x1B,
        "Backspace" => 0x08,
        "Delete" => 0x2E,
        "Insert" => 0x2D,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Minus" => 0xBD,
        "Equal" => 0xBB,
        "BracketLeft" => 0xDB,
        "BracketRight" => 0xDD,
        "Backslash" => 0xDC,
        "Semicolon" => 0xBA,
        "Quote" => 0xDE,
        "Backquote" => 0xC0,
        "Comma" => 0xBC,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        _ => return None,
    })
}

/// macOS virtual keycode (kVK_*, ANSI layout positions) for a canonical key.
pub fn mac_keycode(key: &str) -> Option<u32> {
    const LETTERS: [(char, u32); 26] = [
        ('A', 0x00),
        ('S', 0x01),
        ('D', 0x02),
        ('F', 0x03),
        ('H', 0x04),
        ('G', 0x05),
        ('Z', 0x06),
        ('X', 0x07),
        ('C', 0x08),
        ('V', 0x09),
        ('B', 0x0B),
        ('Q', 0x0C),
        ('W', 0x0D),
        ('E', 0x0E),
        ('R', 0x0F),
        ('Y', 0x10),
        ('T', 0x11),
        ('O', 0x1F),
        ('U', 0x20),
        ('I', 0x22),
        ('P', 0x23),
        ('L', 0x25),
        ('J', 0x26),
        ('K', 0x28),
        ('N', 0x2D),
        ('M', 0x2E),
    ];
    const DIGITS: [u32; 10] = [0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19];
    const FKEYS: [u32; 20] = [
        0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71,
        0x6A, 0x40, 0x4F, 0x50, 0x5A,
    ];
    if let Some(c) = key.strip_prefix("Key").and_then(|c| c.chars().next()) {
        return LETTERS.iter().find(|(l, _)| *l == c).map(|(_, k)| *k);
    }
    if let Some(d) = key.strip_prefix("Digit").and_then(|d| d.parse::<usize>().ok()) {
        return DIGITS.get(d).copied();
    }
    if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<usize>().ok()) {
        return n.checked_sub(1).and_then(|i| FKEYS.get(i)).copied();
    }
    Some(match key {
        "Space" => 0x31,
        "Enter" => 0x24,
        "Tab" => 0x30,
        "Escape" => 0x35,
        "Backspace" => 0x33,
        "Delete" => 0x75,
        "Home" => 0x73,
        "End" => 0x77,
        "PageUp" => 0x74,
        "PageDown" => 0x79,
        "ArrowLeft" => 0x7B,
        "ArrowRight" => 0x7C,
        "ArrowDown" => 0x7D,
        "ArrowUp" => 0x7E,
        "Minus" => 0x1B,
        "Equal" => 0x18,
        "BracketLeft" => 0x21,
        "BracketRight" => 0x1E,
        "Backslash" => 0x2A,
        "Semicolon" => 0x29,
        "Quote" => 0x27,
        "Backquote" => 0x32,
        "Comma" => 0x2B,
        "Period" => 0x2F,
        "Slash" => 0x2C,
        _ => return None,
    })
}

/// One key event as the platform layer reports it. `mods` is the modifier
/// state AFTER this event. `code` is the platform key code (Windows VK, macOS
/// keycode); a modifier key's own event carries a code that never equals a
/// chord's main key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawKey {
    pub code: u32,
    pub down: bool,
    pub mods: Mods,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Pressed(&'static str),
    Released(&'static str),
}

#[derive(Debug)]
struct Watched {
    name: &'static str,
    mods: Mods,
    code: u32,
    active: bool,
}

/// Press / release detection for observed chords.
///
/// Pressed: the main key goes down while EXACTLY the chord's modifiers are held
/// (like the OS hotkey). Released: the main key goes up, or one of the chord's
/// modifiers is let go first (push-to-talk ends on whichever key is released
/// first, like Discord). A key-down while active is auto-repeat: ignored.
#[derive(Debug, Default)]
pub struct ChordWatcher {
    chords: Vec<Watched>,
}

impl ChordWatcher {
    /// Replace the chords. A chord that was held and is gone is released.
    pub fn set(&mut self, chords: Vec<(&'static str, Mods, u32)>) -> Vec<Edge> {
        let mut out = Vec::new();
        let mut next: Vec<Watched> = chords
            .into_iter()
            .map(|(name, mods, code)| Watched {
                name,
                mods,
                code,
                active: false,
            })
            .collect();
        for old in self.chords.iter().filter(|w| w.active) {
            match next
                .iter_mut()
                .find(|n| n.name == old.name && n.mods == old.mods && n.code == old.code)
            {
                Some(same) => same.active = true,
                None => out.push(Edge::Released(old.name)),
            }
        }
        self.chords = next;
        out
    }

    pub fn on_key(&mut self, ev: RawKey) -> Vec<Edge> {
        let mut out = Vec::new();
        for w in &mut self.chords {
            if w.active {
                if (ev.code == w.code && !ev.down) || !ev.mods.contains(&w.mods) {
                    w.active = false;
                    out.push(Edge::Released(w.name));
                }
                // else: auto-repeat of the main key, or an unrelated key: still held.
            } else if ev.down && ev.code == w.code && ev.mods == w.mods {
                w.active = true;
                out.push(Edge::Pressed(w.name));
            }
        }
        out
    }

    /// Release everything (the hook stopped, the session locked).
    pub fn release_all(&mut self) -> Vec<Edge> {
        let mut out = Vec::new();
        for w in &mut self.chords {
            if w.active {
                w.active = false;
                out.push(Edge::Released(w.name));
            }
        }
        out
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.chords.is_empty()
    }
}

/// Windows: the modifier state after a key event, from the per-side async
/// key state (`down(vk)`), with THIS event applied (the async state is only
/// updated after the low-level hook returns).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_mods(vk: u32, is_down: bool, down: impl Fn(u32) -> bool) -> Mods {
    let k = |v: u32| if vk == v { is_down } else { down(v) };
    // VK_LCONTROL/RCONTROL, VK_LMENU/RMENU, VK_LSHIFT/RSHIFT, VK_LWIN/RWIN.
    // A generic VK_CONTROL / VK_MENU / VK_SHIFT event (injected by some tools)
    // counts as the left key.
    let generic = |g: u32| if vk == g { Some(is_down) } else { None };
    Mods {
        ctrl: generic(0x11).unwrap_or_else(|| k(0xA2) || k(0xA3)),
        alt: generic(0x12).unwrap_or_else(|| k(0xA4) || k(0xA5)),
        shift: generic(0x10).unwrap_or_else(|| k(0xA0) || k(0xA1)),
        meta: k(0x5B) || k(0x5C),
    }
}

/// macOS: CGEventFlags -> Mods.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_mods(flags: u64) -> Mods {
    Mods {
        shift: flags & 0x0002_0000 != 0,
        ctrl: flags & 0x0004_0000 != 0,
        alt: flags & 0x0008_0000 != 0,
        meta: flags & 0x0010_0000 != 0,
    }
}

// ---------------------------------------------------------------- manager

pub(crate) enum Msg {
    Key(RawKey),
    Set(Vec<(&'static str, Mods, u32)>),
    /// The hook stopped: nothing is held any more.
    Stopped,
    /// Windows: the foreground window changed (its HWND as an integer).
    #[allow(dead_code)]
    Foreground(isize),
}

/// Status the UI shows next to the setting.
#[derive(Clone, Debug, Default, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This OS can observe keys without taking them.
    pub supported: bool,
    /// The hook / tap is running.
    pub running: bool,
    /// macOS: Input Monitoring permission is missing.
    pub needs_permission: bool,
    /// Windows: Companion itself runs as administrator.
    pub self_elevated: bool,
    /// Windows: the focused app runs as administrator and Companion does not:
    /// Windows hides its keys from us (UIPI).
    pub foreground_elevated: bool,
}

pub const STATUS_EVENT: &str = "herald-native-status";

static WORKER: OnceLock<Sender<Msg>> = OnceLock::new();
static STATUS: Mutex<Option<Status>> = Mutex::new(None);

pub(crate) fn sender() -> Option<&'static Sender<Msg>> {
    WORKER.get()
}

fn worker(app: &AppHandle) -> &'static Sender<Msg> {
    WORKER.get_or_init(|| {
        let (tx, rx) = channel::<Msg>();
        let app = app.clone();
        std::thread::Builder::new()
            .name("herald-keys".into())
            .spawn(move || {
                let mut watcher = ChordWatcher::default();
                for msg in rx {
                    let edges = match msg {
                        Msg::Key(k) => watcher.on_key(k),
                        Msg::Set(c) => watcher.set(c),
                        Msg::Stopped => watcher.release_all(),
                        Msg::Foreground(_hwnd) => {
                            #[cfg(target_os = "windows")]
                            update_status(&app, |s| {
                                s.foreground_elevated =
                                    !s.self_elevated && windows::window_is_elevated(_hwnd)
                            });
                            Vec::new()
                        }
                    };
                    for e in edges {
                        let (name, state) = match e {
                            Edge::Pressed(n) => (n, true),
                            Edge::Released(n) => (n, false),
                        };
                        crate::herald::on_observed(&app, name, state);
                    }
                }
            })
            .expect("spawn herald-keys");
        tx
    })
}

pub fn status() -> Status {
    let mut s = STATUS.lock().unwrap_or_else(|e| e.into_inner());
    s.get_or_insert_with(|| Status {
        supported: supported(),
        #[cfg(target_os = "windows")]
        self_elevated: windows::self_elevated(),
        #[cfg(target_os = "macos")]
        needs_permission: !macos::has_permission(),
        ..Default::default()
    })
    .clone()
}

#[allow(dead_code)]
fn update_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    let before = status();
    let mut after = before.clone();
    f(&mut after);
    if after == before {
        return;
    }
    *STATUS.lock().unwrap_or_else(|e| e.into_inner()) = Some(after.clone());
    let _ = app.emit(STATUS_EVENT, after);
}

pub fn supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

/// The platform key code for a canonical key name.
fn platform_code(key: &str) -> Option<u32> {
    if cfg!(target_os = "macos") {
        mac_keycode(key)
    } else {
        windows_vk(key)
    }
}

/// Observe these chords (and only these). Returns, per chord, Ok or why it
/// cannot be observed (the caller then registers it exclusively instead).
/// An empty list stops the hook.
pub fn apply(app: &AppHandle, chords: Vec<(&'static str, String)>) -> Vec<(&'static str, Result<(), String>)> {
    if !supported() {
        return chords
            .into_iter()
            .map(|(n, _)| (n, Err("unsupported".to_string())))
            .collect();
    }
    let mut ok: Vec<(&'static str, Mods, u32)> = Vec::new();
    let mut out = Vec::new();
    for (name, accel) in chords {
        match parse_accelerator(&accel).and_then(|c| platform_code(&c.key).map(|code| (c.mods, code))) {
            Some((mods, code)) => ok.push((name, mods, code)),
            None => out.push((name, Err("key_unsupported".to_string()))),
        }
    }
    let tx = worker(app);
    if ok.is_empty() {
        let _ = tx.send(Msg::Set(Vec::new()));
        stop_hook();
        update_status(app, |s| s.running = false);
        return out;
    }
    match start_hook() {
        Ok(()) => {
            update_status(app, |s| {
                s.running = true;
                s.needs_permission = false;
            });
            out.extend(ok.iter().map(|(n, _, _)| (*n, Ok(()))));
            let _ = tx.send(Msg::Set(ok));
        }
        Err(e) => {
            let _ = tx.send(Msg::Set(Vec::new()));
            update_status(app, |s| {
                s.running = false;
                s.needs_permission = e == "needs_permission";
            });
            out.extend(ok.iter().map(|(n, _, _)| (*n, Err(e.clone()))));
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn start_hook() -> Result<(), String> {
    windows::start()
}
#[cfg(target_os = "windows")]
fn stop_hook() {
    windows::stop()
}

#[cfg(target_os = "macos")]
fn start_hook() -> Result<(), String> {
    macos::start()
}
#[cfg(target_os = "macos")]
fn stop_hook() {
    macos::stop()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn start_hook() -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn stop_hook() {}

/// macOS: ask for Input Monitoring (shows the system prompt once) and open the
/// settings pane. Elsewhere a no-op.
pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL_ALT: Mods = Mods {
        ctrl: true,
        alt: true,
        shift: false,
        meta: false,
    };
    const NONE: Mods = Mods {
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
    };
    const SPACE: u32 = 0x20;
    const LCTRL: u32 = 0xA2;

    fn key(code: u32, down: bool, mods: Mods) -> RawKey {
        RawKey { code, down, mods }
    }

    fn talk() -> ChordWatcher {
        let mut w = ChordWatcher::default();
        assert!(w.set(vec![("talk", CTRL_ALT, SPACE)]).is_empty());
        w
    }

    #[test]
    fn parses_accelerators() {
        let c = parse_accelerator("Ctrl+Alt+Space").unwrap();
        assert_eq!(c.mods, CTRL_ALT);
        assert_eq!(c.key, "Space");
        let c = parse_accelerator("Ctrl+Alt+Shift+KeyS").unwrap();
        assert!(c.mods.shift && c.mods.ctrl && c.mods.alt && !c.mods.meta);
        assert_eq!(c.key, "KeyS");
        assert_eq!(parse_accelerator("Super+h").unwrap().key, "KeyH");
        assert_eq!(parse_accelerator("Ctrl+F13").unwrap().key, "F13");
        assert_eq!(parse_accelerator("Ctrl+Digit1").unwrap().key, "Digit1");
        assert!(parse_accelerator("Ctrl+Alt").is_none());
        assert!(parse_accelerator("Ctrl+A+B").is_none());
        assert!(parse_accelerator("Ctrl+Nonsense").is_none());
    }

    #[test]
    fn key_tables() {
        assert_eq!(windows_vk("Space"), Some(0x20));
        assert_eq!(windows_vk("KeyH"), Some(0x48));
        assert_eq!(windows_vk("KeyS"), Some(0x53));
        assert_eq!(windows_vk("Digit0"), Some(0x30));
        assert_eq!(windows_vk("F1"), Some(0x70));
        assert_eq!(windows_vk("F13"), Some(0x7C));
        assert_eq!(windows_vk("F24"), Some(0x87));
        assert_eq!(mac_keycode("Space"), Some(0x31));
        assert_eq!(mac_keycode("KeyH"), Some(0x04));
        assert_eq!(mac_keycode("KeyS"), Some(0x01));
        assert_eq!(mac_keycode("KeyB"), Some(0x0B));
        assert_eq!(mac_keycode("Digit1"), Some(0x12));
        assert_eq!(mac_keycode("F13"), Some(0x69));
        assert_eq!(mac_keycode("F21"), None);
        // Every letter maps on both platforms.
        for c in 'A'..='Z' {
            assert!(windows_vk(&format!("Key{c}")).is_some());
            assert!(mac_keycode(&format!("Key{c}")).is_some(), "{c}");
        }
    }

    #[test]
    fn press_and_release() {
        let mut w = talk();
        assert!(w.on_key(key(LCTRL, true, Mods { ctrl: true, ..NONE })).is_empty());
        assert_eq!(w.on_key(key(SPACE, true, CTRL_ALT)), vec![Edge::Pressed("talk")]);
        assert_eq!(w.on_key(key(SPACE, false, CTRL_ALT)), vec![Edge::Released("talk")]);
    }

    #[test]
    fn auto_repeat_is_ignored() {
        let mut w = talk();
        assert_eq!(w.on_key(key(SPACE, true, CTRL_ALT)), vec![Edge::Pressed("talk")]);
        for _ in 0..20 {
            assert!(w.on_key(key(SPACE, true, CTRL_ALT)).is_empty());
        }
        assert_eq!(w.on_key(key(SPACE, false, CTRL_ALT)), vec![Edge::Released("talk")]);
        // A stray key-up afterwards does nothing.
        assert!(w.on_key(key(SPACE, false, CTRL_ALT)).is_empty());
    }

    #[test]
    fn releasing_a_modifier_first_releases() {
        let mut w = talk();
        w.on_key(key(SPACE, true, CTRL_ALT));
        assert_eq!(
            w.on_key(key(LCTRL, false, Mods { alt: true, ..NONE })),
            vec![Edge::Released("talk")]
        );
        // Space still physically down, auto-repeating: no new press without Ctrl.
        assert!(w.on_key(key(SPACE, true, Mods { alt: true, ..NONE })).is_empty());
        assert!(w.on_key(key(SPACE, false, Mods { alt: true, ..NONE })).is_empty());
    }

    #[test]
    fn exact_modifiers_only() {
        let mut w = talk();
        // Ctrl+Alt+Shift+Space is a different chord.
        assert!(w.on_key(key(SPACE, true, Mods { shift: true, ..CTRL_ALT })).is_empty());
        assert!(w.on_key(key(SPACE, true, Mods { ctrl: true, ..NONE })).is_empty());
        assert!(w.on_key(key(SPACE, true, NONE)).is_empty());
        // Space first, then the modifiers: not a press (only a key-down presses).
        w.on_key(key(SPACE, false, NONE));
        assert_eq!(w.on_key(key(SPACE, true, CTRL_ALT)), vec![Edge::Pressed("talk")]);
    }

    #[test]
    fn other_keys_while_held_do_not_release() {
        let mut w = talk();
        w.on_key(key(SPACE, true, CTRL_ALT));
        assert!(w.on_key(key(0x57, true, CTRL_ALT)).is_empty()); // W
        assert!(w.on_key(key(0x57, false, CTRL_ALT)).is_empty());
        // Adding Shift while held keeps it held (Ctrl and Alt are still down).
        assert!(w
            .on_key(key(0xA0, true, Mods { shift: true, ..CTRL_ALT }))
            .is_empty());
        assert_eq!(w.on_key(key(SPACE, false, CTRL_ALT)), vec![Edge::Released("talk")]);
    }

    #[test]
    fn several_chords_and_reconfigure() {
        let mut w = ChordWatcher::default();
        let stop_mods = Mods { shift: true, ..CTRL_ALT };
        w.set(vec![("talk", CTRL_ALT, SPACE), ("stop", stop_mods, 0x53)]);
        assert_eq!(w.on_key(key(0x53, true, stop_mods)), vec![Edge::Pressed("stop")]);
        assert_eq!(w.on_key(key(0x53, false, stop_mods)), vec![Edge::Released("stop")]);
        w.on_key(key(SPACE, true, CTRL_ALT));
        // Reconfigured while held: same chord stays held, a removed one is released.
        assert!(w
            .set(vec![("talk", CTRL_ALT, SPACE), ("stop", stop_mods, 0x53)])
            .is_empty());
        assert_eq!(w.on_key(key(SPACE, false, CTRL_ALT)), vec![Edge::Released("talk")]);
        w.on_key(key(SPACE, true, CTRL_ALT));
        assert_eq!(w.set(vec![]), vec![Edge::Released("talk")]);
        assert!(w.is_empty());
    }

    #[test]
    fn release_all_on_stop() {
        let mut w = talk();
        w.on_key(key(SPACE, true, CTRL_ALT));
        assert_eq!(w.release_all(), vec![Edge::Released("talk")]);
        assert!(w.release_all().is_empty());
    }

    #[test]
    fn windows_modifier_state_applies_this_event() {
        // Async state says nothing is down; this event is LCtrl going down.
        let m = windows_mods(0xA2, true, |_| false);
        assert!(m.ctrl && !m.alt);
        // RCtrl held, LCtrl released: still ctrl.
        let m = windows_mods(0xA2, false, |vk| vk == 0xA3);
        assert!(m.ctrl);
        // LCtrl released, async state (stale) still says LCtrl down: this event wins.
        let m = windows_mods(0xA2, false, |vk| vk == 0xA2 || vk == 0xA4);
        assert!(!m.ctrl && m.alt);
        // A generic VK_SHIFT event.
        assert!(windows_mods(0x10, true, |_| false).shift);
        let m = windows_mods(0x5B, true, |_| false);
        assert!(m.meta);
    }

    #[test]
    fn mac_flags() {
        let m = mac_mods(0x0004_0000 | 0x0008_0000);
        assert_eq!(m, CTRL_ALT);
        assert!(mac_mods(0x0010_0000).meta);
        assert!(mac_mods(0x0002_0000).shift);
    }
}
