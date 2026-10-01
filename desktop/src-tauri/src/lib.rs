#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod herald;
#[cfg(desktop)]
mod overlay;
#[cfg(desktop)]
mod passthrough;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // FCM push notifications (no-op on desktop, active on mobile)
        .plugin(tauri_plugin_fcm::init())
        // Herald native voice glue (earbud button, audio focus; no-op on desktop)
        .plugin(tauri_plugin_herald_native::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    // On mobile, intercept external link navigation and open in system browser
    #[cfg(mobile)]
    {
        builder = builder.plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("external-links")
                .on_navigation(|webview, url| {
                    use tauri::Manager;

                    let scheme = url.scheme();

                    // Allow internal URLs
                    if scheme == "tauri" || scheme == "asset" {
                        return true;
                    }

                    if scheme == "http" || scheme == "https" {
                        if let Some(host) = url.host_str() {
                            // Allow local/dev URLs
                            if host == "localhost"
                                || host == "tauri.localhost"
                                || host == "0.0.0.0"
                                || host == "127.0.0.1"
                            {
                                return true;
                            }
                        }
                        // Open in system browser on a background thread to avoid ANR
                        let handle = webview.app_handle().clone();
                        let url_string = url.as_str().to_string();
                        std::thread::spawn(move || {
                            use tauri_plugin_opener::OpenerExt;
                            let _ = handle.opener().open_url(&url_string, None::<&str>);
                        });
                        return false;
                    }

                    true
                })
                .build(),
        );
    }

    // Desktop-only plugins
    #[cfg(desktop)]
    {
        builder = desktop::setup_desktop_plugins(builder);
        builder = builder.invoke_handler(tauri::generate_handler![
            desktop::set_tray_tooltip,
            desktop::get_autostart_enabled,
            desktop::set_autostart_enabled,
            herald::herald_set_shortcuts,
            herald::herald_native_info,
            herald::herald_set_tray_state,
            herald::herald_passthrough_status,
            herald::herald_request_input_monitoring,
            overlay::herald_overlay_update,
            overlay::herald_overlay_ready,
            overlay::herald_overlay_regions,
            overlay::herald_overlay_drag,
            overlay::herald_overlay_action,
            overlay::herald_bring_to_front,
        ]);
    }

    builder = builder.setup(|app| {
        #[cfg(desktop)]
        desktop::setup_desktop(app)?;

        // Desktop-only setup is handled above
        let _ = app;

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
