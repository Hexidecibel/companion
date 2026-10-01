//! Windows: a low-level keyboard hook (WH_KEYBOARD_LL) that only OBSERVES.
//!
//! It runs on its own thread with a message loop (a low-level hook is called
//! on the thread that installed it, through that thread's message loop). The
//! callback reads the key and the modifier state, posts them to the worker
//! channel and ALWAYS calls CallNextHookEx with the original arguments: every
//! key still reaches Discord, the game and everything else. Nothing blocking
//! happens in the callback (Windows drops a hook that is too slow).
//!
//! The same thread also watches the foreground window (SetWinEventHook,
//! out of context), so the UI can say when the focused game runs as
//! administrator: Windows does not deliver an elevated window's keys to a
//! hook in a non-elevated process (UIPI).

use super::{sender, Msg, RawKey};
use std::sync::mpsc::channel;
use std::sync::Mutex;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    PeekMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    EVENT_SYSTEM_FOREGROUND, HC_ACTION, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

/// The hook thread's id (to post WM_QUIT to), while it runs.
static THREAD: Mutex<Option<u32>> = Mutex::new(None);

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam.0 != 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let msg = wparam.0 as u32;
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        if down || up {
            if let Some(tx) = sender() {
                let mods = super::windows_mods(kb.vkCode, down, |vk| {
                    (GetAsyncKeyState(vk as i32) as u16) & 0x8000 != 0
                });
                // Never blocks (unbounded channel). Injected keys count too, so
                // the AutoHotkey bridge script can hold the chord.
                let _ = tx.send(Msg::Key(RawKey {
                    code: kb.vkCode,
                    down,
                    mods,
                }));
            }
        }
    }
    // Always pass the key on: we observe, never consume.
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn foreground_proc(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if let Some(tx) = sender() {
        let _ = tx.send(Msg::Foreground(hwnd.0 as isize));
    }
}

pub fn start() -> Result<(), String> {
    let mut thread = THREAD.lock().unwrap_or_else(|e| e.into_inner());
    if thread.is_some() {
        return Ok(());
    }
    let (ready_tx, ready_rx) = channel::<Result<u32, String>>();
    std::thread::Builder::new()
        .name("herald-kbd-hook".into())
        .spawn(move || unsafe {
            // Create this thread's message queue before anyone posts to it.
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
            let module = GetModuleHandleW(None).ok();
            let hook = match SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard_proc),
                module.map(|m| m.into()),
                0,
            ) {
                Ok(h) => h,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("hook_failed: {e}")));
                    return;
                }
            };
            let fg = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(foreground_proc),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            // The window focused right now.
            if let Some(tx) = sender() {
                let _ = tx.send(Msg::Foreground(GetForegroundWindow().0 as isize));
            }
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !fg.is_invalid() {
                let _ = UnhookWinEvent(fg);
            }
            let _ = UnhookWindowsHookEx(hook);
            if let Some(tx) = sender() {
                let _ = tx.send(Msg::Stopped);
            }
        })
        .map_err(|e| format!("thread_failed: {e}"))?;
    match ready_rx.recv() {
        Ok(Ok(id)) => {
            *thread = Some(id);
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("hook_failed".into()),
    }
}

pub fn stop() {
    if let Some(id) = THREAD.lock().unwrap_or_else(|e| e.into_inner()).take() {
        unsafe {
            let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

/// The process token is elevated (runs as administrator). An elevated process
/// we cannot even query is assumed elevated (that is the usual reason).
fn process_elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
            return None;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok.then_some(elevation.TokenIsElevated != 0)
    }
}

pub fn self_elevated() -> bool {
    process_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false)
}

/// The window's process runs elevated (keys typed into it never reach our hook).
pub fn window_is_elevated(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(HWND(hwnd as *mut core::ffi::c_void), Some(&mut pid));
        if pid == 0 {
            return false;
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            // Cannot even open it for a limited query: protected / elevated.
            return true;
        };
        let elevated = process_elevated(process).unwrap_or(true);
        let _ = CloseHandle(process);
        elevated
    }
}
