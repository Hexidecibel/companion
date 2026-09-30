const COMMANDS: &[&str] = &[
    "set_media_session",
    "set_audio_focus",
    "get_audio_route",
    "start_capture",
    "stop_capture",
    "set_prefer_builtin_mic",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
