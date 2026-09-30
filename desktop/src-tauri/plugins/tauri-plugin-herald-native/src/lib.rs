//! Herald native voice glue for the Companion mobile apps.
//!
//! * `set_media_session { active }` - while on, an earbud / headset play-pause
//!   press is sent to the web layer as a `media` plugin event
//!   `{ action: "toggle" }` (the same action a remote trigger uses).
//! * `set_audio_focus { active }` - Herald is about to speak (true) or is done
//!   (false). Android requests transient focus that lets other audio duck; iOS
//!   activates / releases its audio session so other audio ducks.
//!
//! Both are no-ops on desktop: desktop Herald uses global shortcuts and the tray
//! (see `desktop::herald` in the app crate).
//!
//! Audio (Herald's echo cancellation / Bluetooth handling, see
//! web/src/services/voice/nativeAudio.ts):
//! * `get_audio_route` - current output / input ports. Mobile: AVAudioSession /
//!   AudioManager (route changes arrive as `audioRoute` plugin events). Desktop:
//!   macOS / Linux from the system (route.rs); Windows: null.
//! * `start_capture { aec, avoidBluetooth, onAudio }` / `stop_capture` - Android
//!   only: the built-in mic captured natively (16 kHz PCM16 chunks on the
//!   `onAudio` channel), so Bluetooth earbuds stay in A2DP.
//! * `set_prefer_builtin_mic { on }` - iOS: keep A2DP output and listen on the
//!   built-in mic (no HFP); Android: capture preference; desktop: no-op.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(mobile)]
mod mobile;
#[cfg(desktop)]
pub mod route;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("herald-native")
        .setup(|app, api| {
            #[cfg(mobile)]
            {
                use tauri::Manager;
                app.manage(mobile::init(app, api)?);
            }
            #[cfg(not(mobile))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_media_session,
            commands::set_audio_focus,
            commands::get_audio_route,
            commands::start_capture,
            commands::stop_capture,
            commands::set_prefer_builtin_mic,
        ])
        .build()
}

mod commands {
    use tauri::{command, ipc::Channel, AppHandle, Runtime};

    /// The current audio route (see route.rs / the mobile plugins); null when unknown.
    #[command]
    pub async fn get_audio_route<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
        #[cfg(mobile)]
        {
            use tauri::Manager;
            app.state::<super::mobile::HeraldNative<R>>()
                .run("getAudioRoute", serde_json::json!({}))
        }
        #[cfg(desktop)]
        {
            let _ = app;
            // system_profiler takes ~0.5 s: keep it off the async runtime's workers.
            let route = tauri::async_runtime::spawn_blocking(super::route::current)
                .await
                .map_err(|e| e.to_string())?;
            Ok(route.map(|r| serde_json::to_value(r).unwrap_or_default()).unwrap_or(serde_json::Value::Null))
        }
    }

    /// Android: capture the mic natively and stream it to the page.
    #[command]
    pub async fn start_capture<R: Runtime>(
        app: AppHandle<R>,
        aec: bool,
        avoid_bluetooth: bool,
        on_audio: Channel<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            app.state::<super::mobile::HeraldNative<R>>().run(
                "startCapture",
                serde_json::json!({ "aec": aec, "avoidBluetooth": avoid_bluetooth, "onAudio": on_audio }),
            )
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, aec, avoid_bluetooth, on_audio);
            Err("native capture is only used on Android".into())
        }
    }

    #[command]
    pub async fn stop_capture<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            app.state::<super::mobile::HeraldNative<R>>()
                .run("stopCapture", serde_json::json!({}))
                .map(|_| ())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Ok(())
        }
    }

    /// iOS: listen on the built-in mic while Bluetooth headphones play (A2DP).
    #[command]
    pub async fn set_prefer_builtin_mic<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<(), String> {
        #[cfg(target_os = "ios")]
        {
            use tauri::Manager;
            app.state::<super::mobile::HeraldNative<R>>()
                .run("setPreferBuiltInMic", serde_json::json!({ "on": on }))
                .map(|_| ())
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = (app, on);
            Ok(())
        }
    }

    #[command]
    pub async fn set_media_session<R: Runtime>(
        app: AppHandle<R>,
        active: bool,
    ) -> Result<(), String> {
        #[cfg(mobile)]
        {
            use tauri::Manager;
            app.state::<super::mobile::HeraldNative<R>>()
                .call("setMediaSession", active)
        }
        #[cfg(not(mobile))]
        {
            let _ = (app, active);
            Ok(())
        }
    }

    #[command]
    pub async fn set_audio_focus<R: Runtime>(
        app: AppHandle<R>,
        active: bool,
    ) -> Result<(), String> {
        #[cfg(mobile)]
        {
            use tauri::Manager;
            app.state::<super::mobile::HeraldNative<R>>()
                .call("setAudioFocus", active)
        }
        #[cfg(not(mobile))]
        {
            let _ = (app, active);
            Ok(())
        }
    }
}
