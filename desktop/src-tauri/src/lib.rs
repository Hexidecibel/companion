#[cfg(desktop)]
mod desktop;
mod external_links;
#[cfg(desktop)]
mod herald;
#[cfg(desktop)]
mod overlay;
#[cfg(desktop)]
mod passthrough;
#[cfg(desktop)]
mod updater;

/// WebView2 (Windows) browser arguments for every Companion webview: wry's
/// defaults plus no occlusion / background throttling, so Herald hands-free
/// keeps listening while the window is covered, minimised or in the tray. Must
/// equal `additionalBrowserArgs` in tauri.conf.json (the main window; tested).
#[cfg(desktop)]
#[allow(dead_code)]
pub(crate) const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding";

#[cfg(all(test, desktop))]
mod webview_args_tests {
    #[test]
    fn main_window_and_overlay_share_webview2_args() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &conf["app"]["windows"][0];
        assert_eq!(
            main["additionalBrowserArgs"].as_str(),
            Some(super::WEBVIEW2_ARGS)
        );
        assert_eq!(main["backgroundThrottling"].as_str(), Some("disabled"));
    }
}

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

    // Links never navigate a Companion webview away from the app: anything
    // that is not our own origin opens in the system browser instead.
    builder = builder.plugin(external_links::plugin());

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
            herald::herald_open_input_monitoring,
            overlay::herald_overlay_update,
            overlay::herald_overlay_set_enabled,
            overlay::herald_overlay_ready,
            overlay::herald_overlay_regions,
            overlay::herald_overlay_drag,
            overlay::herald_overlay_action,
            overlay::herald_bring_to_front,
            updater::updater_status,
            updater::updater_check,
            updater::updater_install,
            updater::updater_set_auto_install,
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
        .build(tauri::generate_context!())
        .expect("error while building Companion")
        .run(|_app, _event| {
            // Apply a downloaded update on quit ("install on quit" setting).
            #[cfg(desktop)]
            if let tauri::RunEvent::ExitRequested { .. } = _event {
                updater::on_exit(_app);
            }
            // macOS: a click on the Dock icon brings the main window back
            // (Cmd+W only hides it). `has_visible_windows` is no help: the
            // floating orb counts as a visible window.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                desktop::show_main_window(_app);
            }
        });
}
