use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod error;
pub use error::Error;

#[cfg(mobile)]
mod mobile;

#[cfg(mobile)]
pub use mobile::Fcm;

/// Result type alias for the FCM plugin.
pub type Result<T> = std::result::Result<T, Error>;

/// Token received from FCM (Android) or APNs (iOS).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FcmToken {
    pub token: String,
    pub platform: String,
}

#[cfg(mobile)]
mod ext {
    use tauri::{Manager, Runtime};
    use super::mobile::Fcm;

    /// Extension trait to access the FCM plugin from the app handle.
    pub trait FcmExt<R: Runtime> {
        fn fcm(&self) -> &Fcm<R>;
    }

    impl<R: Runtime, T: Manager<R>> FcmExt<R> for T {
        fn fcm(&self) -> &Fcm<R> {
            self.state::<Fcm<R>>().inner()
        }
    }
}

#[cfg(mobile)]
pub use ext::FcmExt;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fcm")
        .setup(|app, api| {
            #[cfg(mobile)]
            {
                use tauri::Manager;
                let fcm = mobile::init(app, api)?;
                app.manage(fcm);
            }
            #[cfg(not(mobile))]
            {
                let _ = (app, api);
                log::debug!("FCM plugin: no-op on desktop");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_fcm_token,
            commands::request_notification_permission,
            commands::is_notification_permission_granted,
        ])
        .build()
}

mod commands {
    use tauri::{command, AppHandle, Runtime};

    #[command]
    pub async fn get_fcm_token<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
        #[cfg(mobile)]
        {
            use super::FcmExt;
            match app.fcm().get_token() {
                Ok(token) => Ok(token),
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(mobile))]
        {
            let _ = app;
            Ok(None)
        }
    }

    #[command]
    pub async fn request_notification_permission<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<bool, String> {
        #[cfg(mobile)]
        {
            use super::FcmExt;
            match app.fcm().request_permission() {
                Ok(granted) => Ok(granted),
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(mobile))]
        {
            let _ = app;
            Ok(true)
        }
    }

    #[command]
    pub async fn is_notification_permission_granted<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<bool, String> {
        #[cfg(mobile)]
        {
            use super::FcmExt;
            match app.fcm().is_permission_granted() {
                Ok(granted) => Ok(granted),
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(mobile))]
        {
            let _ = app;
            Ok(true)
        }
    }
}
