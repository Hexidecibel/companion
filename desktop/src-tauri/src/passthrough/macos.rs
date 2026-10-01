//! macOS: a LISTEN-ONLY CGEventTap. It sees key events system-wide without
//! being able to change or drop them, so every key still reaches Discord and
//! the focused app. It needs the Input Monitoring permission (System Settings >
//! Privacy & Security > Input Monitoring); without it the tap cannot be
//! created and the chord stays an exclusive shortcut until the user allows it.
//!
//! The tap runs on its own thread's CFRunLoop; the callback only posts the key
//! to the worker channel.

use super::{sender, Msg, RawKey};
use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::mpsc::channel;
use std::sync::Mutex;

type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFStringRef = *const c_void;
type CGEventRef = *mut c_void;
type CGEventTapProxy = *mut c_void;
type TapCallback = extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: TapCallback,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: CFMachPortRef,
        order: isize,
    ) -> CFRunLoopSourceRef;
    fn CFMachPortInvalidate(port: CFMachPortRef);
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRun();
    fn CFRunLoopStop(rl: CFRunLoopRef);
    fn CFRelease(cf: *const c_void);
    static kCFRunLoopCommonModes: CFStringRef;
}

const SESSION_EVENT_TAP: u32 = 1; // kCGSessionEventTap
const HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
const LISTEN_ONLY: u32 = 1; // kCGEventTapOptionListenOnly
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
const FIELD_KEYCODE: u32 = 9; // kCGKeyboardEventKeycode
/// Modifier-key events carry this bit so they never equal a chord's main key.
const MODIFIER_CODE: u32 = 0x1_0000;

/// The running tap (to re-enable it after a timeout) and its run loop (to stop it).
static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static RUN_LOOP: Mutex<Option<usize>> = Mutex::new(None);

extern "C" fn tap_callback(
    _proxy: CGEventTapProxy,
    kind: u32,
    event: CGEventRef,
    _user: *mut c_void,
) -> CGEventRef {
    unsafe {
        if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
            let tap = TAP.load(Ordering::Acquire);
            if !tap.is_null() {
                CGEventTapEnable(tap, true);
            }
            return event;
        }
        if kind != KEY_DOWN && kind != KEY_UP && kind != FLAGS_CHANGED {
            return event;
        }
        if let Some(tx) = sender() {
            let code = CGEventGetIntegerValueField(event, FIELD_KEYCODE) as u32;
            let mods = super::mac_mods(CGEventGetFlags(event));
            let ev = match kind {
                KEY_DOWN => RawKey { code, down: true, mods },
                KEY_UP => RawKey { code, down: false, mods },
                _ => RawKey {
                    code: code | MODIFIER_CODE,
                    down: false,
                    mods,
                },
            };
            let _ = tx.send(Msg::Key(ev));
        }
    }
    // Listen-only: the return value is ignored; the event is never changed.
    event
}

pub fn has_permission() -> bool {
    unsafe { CGPreflightListenEventAccess() }
}

/// Show the system prompt (once per app) and open the Input Monitoring pane.
pub fn request_permission() -> bool {
    let granted = unsafe { CGRequestListenEventAccess() };
    if !granted {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn();
    }
    granted
}

pub fn start() -> Result<(), String> {
    let mut rl = RUN_LOOP.lock().unwrap_or_else(|e| e.into_inner());
    if rl.is_some() {
        return Ok(());
    }
    if !has_permission() {
        return Err("needs_permission".into());
    }
    let (ready_tx, ready_rx) = channel::<Result<usize, String>>();
    std::thread::Builder::new()
        .name("herald-event-tap".into())
        .spawn(move || unsafe {
            let mask: u64 = (1 << KEY_DOWN) | (1 << KEY_UP) | (1 << FLAGS_CHANGED);
            let tap = CGEventTapCreate(
                SESSION_EVENT_TAP,
                HEAD_INSERT,
                LISTEN_ONLY,
                mask,
                tap_callback,
                std::ptr::null_mut(),
            );
            if tap.is_null() {
                let _ = ready_tx.send(Err("needs_permission".into()));
                return;
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            if source.is_null() {
                CFMachPortInvalidate(tap);
                CFRelease(tap);
                let _ = ready_tx.send(Err("tap_failed".into()));
                return;
            }
            let run_loop = CFRunLoopGetCurrent();
            CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
            TAP.store(tap, Ordering::Release);
            let _ = ready_tx.send(Ok(run_loop as usize));
            CFRunLoopRun();
            TAP.store(std::ptr::null_mut(), Ordering::Release);
            CGEventTapEnable(tap, false);
            CFMachPortInvalidate(tap);
            CFRelease(source);
            CFRelease(tap);
            if let Some(tx) = sender() {
                let _ = tx.send(Msg::Stopped);
            }
        })
        .map_err(|e| format!("thread_failed: {e}"))?;
    match ready_rx.recv() {
        Ok(Ok(run_loop)) => {
            *rl = Some(run_loop);
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("tap_failed".into()),
    }
}

pub fn stop() {
    if let Some(run_loop) = RUN_LOOP.lock().unwrap_or_else(|e| e.into_inner()).take() {
        unsafe { CFRunLoopStop(run_loop as CFRunLoopRef) };
    }
}
