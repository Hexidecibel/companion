use serde::{ser::Serializer, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("FCM not available on this platform")]
    NotAvailable,
    #[error("Notification permission denied")]
    PermissionDenied,
    #[error("Failed to get FCM token: {0}")]
    TokenError(String),
    #[error("Plugin error: {0}")]
    PluginInvoke(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
