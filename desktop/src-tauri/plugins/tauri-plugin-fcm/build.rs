const COMMANDS: &[&str] = &[
    "get_fcm_token",
    "request_notification_permission",
    "is_notification_permission_granted",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
