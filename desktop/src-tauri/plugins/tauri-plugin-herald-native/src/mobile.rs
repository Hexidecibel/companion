use serde::Serialize;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_herald_native);

pub struct HeraldNative<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>(
    _app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> Result<HeraldNative<R>, Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    let handle =
        api.register_android_plugin("com.hexidecibel.companion.herald", "HeraldNativePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_herald_native)?;
    Ok(HeraldNative(handle))
}

#[derive(Serialize)]
struct ActiveArgs {
    active: bool,
}

impl<R: Runtime> HeraldNative<R> {
    pub fn call(&self, method: &str, active: bool) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>(method, ActiveArgs { active })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Any method with any JSON payload (channels serialize to their id).
    pub fn run(&self, method: &str, payload: impl Serialize) -> Result<serde_json::Value, String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>(method, payload)
            .map_err(|e| e.to_string())
    }
}
