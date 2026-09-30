const COMMANDS: &[&str] = &["set_media_session", "set_audio_focus"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
