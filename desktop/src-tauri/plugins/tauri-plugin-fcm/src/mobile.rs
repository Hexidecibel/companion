use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::Error;

/// Manages the mobile FCM plugin handle.
pub struct Fcm<R: Runtime>(Option<PluginHandle<R>>);

/// Initializes the mobile FCM plugin.
pub fn init<R: Runtime>(
    app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> crate::Result<Fcm<R>> {
    #[cfg(target_os = "android")]
    {
        let handle = api.register_android_plugin("com.hexidecibel.companion.fcm", "FcmPlugin")?;
        let _ = app;
        Ok(Fcm(Some(handle)))
    }
    #[cfg(not(target_os = "android"))]
    {
        // No iOS native plugin yet — return a no-op handle
        let _ = (app, api);
        Ok(Fcm(None))
    }
}

impl<R: Runtime> Fcm<R> {
    /// Get the current FCM token, if available.
    pub fn get_token(&self) -> crate::Result<Option<String>> {
        let Some(handle) = &self.0 else {
            return Ok(None);
        };

        #[derive(serde::Deserialize)]
        struct TokenResponse {
            token: Option<String>,
        }

        let result: TokenResponse = handle
            .run_mobile_plugin("getToken", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(result.token)
    }

    /// Request notification permission (Android 13+, iOS always).
    pub fn request_permission(&self) -> crate::Result<bool> {
        let Some(handle) = &self.0 else {
            return Ok(true);
        };

        #[derive(serde::Deserialize)]
        struct PermResponse {
            granted: bool,
        }

        let result: PermResponse = handle
            .run_mobile_plugin("requestPermission", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(result.granted)
    }

    /// Check if notification permission is already granted.
    pub fn is_permission_granted(&self) -> crate::Result<bool> {
        let Some(handle) = &self.0 else {
            return Ok(true);
        };

        #[derive(serde::Deserialize)]
        struct PermResponse {
            granted: bool,
        }

        let result: PermResponse = handle
            .run_mobile_plugin("isPermissionGranted", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(result.granted)
    }
}
