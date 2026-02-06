#[cfg(desktop)]
mod desktop;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        // FCM push notifications (no-op on desktop, active on mobile)
        .plugin(tauri_plugin_fcm::init());

    // Desktop-only plugins
    #[cfg(desktop)]
    {
        builder = desktop::setup_desktop_plugins(builder);
        builder = builder.invoke_handler(tauri::generate_handler![
            desktop::set_tray_tooltip,
            desktop::get_autostart_enabled,
            desktop::set_autostart_enabled,
        ]);
    }

    builder = builder.setup(|_app| {
        #[cfg(desktop)]
        desktop::setup_desktop(_app)?;

        Ok(())
    });

    #[cfg(desktop)]
    {
        builder = builder.on_window_event(|window, event| {
            desktop::on_desktop_window_event(window, event);
        });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running Companion");
}
