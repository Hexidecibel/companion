use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::Error;

/// Manages the mobile FCM plugin handle.
pub struct Fcm<R: Runtime>(PluginHandle<R>);

/// Initializes the mobile FCM plugin.
pub fn init<R: Runtime>(
    app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> crate::Result<Fcm<R>> {
    let handle = api.register_android_plugin("com.hexidecibel.companion.fcm", "FcmPlugin")?;
    let _ = app;
    Ok(Fcm(handle))
}

impl<R: Runtime> Fcm<R> {
    /// Get the current FCM token, if available.
    pub fn get_token(&self) -> crate::Result<Option<String>> {
        #[derive(serde::Deserialize)]
        struct TokenResponse {
            token: Option<String>,
        }

        let result: TokenResponse = self
            .0
            .run_mobile_plugin("getToken", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(result.token)
    }

    /// Request notification permission (Android 13+, iOS always).
    pub fn request_permission(&self) -> crate::Result<bool> {
        #[derive(serde::Deserialize)]
        struct PermResponse {
            granted: bool,
        }

        let result: PermResponse = self
            .0
            .run_mobile_plugin("requestPermission", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(result.granted)
    }

    /// Check if notification permission is already granted.
    pub fn is_permission_granted(&self) -> crate::Result<bool> {
        #[derive(serde::Deserialize)]
        struct PermResponse {
            granted: bool,
        }

        let result: PermResponse = self
            .0
            .run_mobile_plugin("isPermissionGranted", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(result.granted)
    }
}
