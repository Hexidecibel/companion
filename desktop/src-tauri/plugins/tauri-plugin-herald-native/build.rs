const COMMANDS: &[&str] = &[
    "set_media_session",
    "set_audio_focus",
    "get_audio_route",
    "start_capture",
    "stop_capture",
    "set_prefer_builtin_mic",
    "app_update_info",
    "app_update_fetch_feed",
    "app_update_install",
    "app_update_open_settings",
    "discover_daemons",
    "take_pending_link",
    "secure_get",
    "secure_set",
    "secure_delete",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
