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
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(mobile)]
mod mobile;

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
        ])
        .build()
}

mod commands {
    use tauri::{command, AppHandle, Runtime};

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
