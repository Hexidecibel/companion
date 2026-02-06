// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(desktop)]
mod desktop {
    use tauri::{
        menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        Emitter, Manager, WebviewWindow, WindowEvent,
    };
    use tauri_plugin_autostart::MacosLauncher;
    use tauri_plugin_autostart::ManagerExt;

    #[tauri::command]
    pub fn set_tray_tooltip(app: tauri::AppHandle, tooltip: String) {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_tooltip(Some(&tooltip));
        }
    }

    #[tauri::command]
    pub fn get_autostart_enabled(app: tauri::AppHandle) -> bool {
        app.autolaunch().is_enabled().unwrap_or(false)
    }

    #[tauri::command]
    pub fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
        let autolaunch = app.autolaunch();
        if enabled {
            autolaunch.enable().map_err(|e| format!("{e}"))
        } else {
            autolaunch.disable().map_err(|e| format!("{e}"))
        }
    }

    fn toggle_window(window: &WebviewWindow) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    pub fn setup_desktop(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
        // -- Custom menu bar --
        let app_menu = SubmenuBuilder::new(app, "Companion")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let file_menu = SubmenuBuilder::new(app, "File")
            .item(
                &MenuItemBuilder::with_id("new-session", "New Session")
                    .accelerator("CmdOrCtrl+N")
                    .build(app)?,
            )
            .separator()
            .close_window()
            .build()?;

        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let view_menu = SubmenuBuilder::new(app, "View")
            .item(
                &MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                    .accelerator("CmdOrCtrl+B")
                    .build(app)?,
            )
            .separator()
            .item(
                &MenuItemBuilder::with_id("reload", "Reload")
                    .accelerator("CmdOrCtrl+R")
                    .build(app)?,
            )
            .separator()
            .item(
                &MenuItemBuilder::with_id("zoom-in", "Zoom In")
                    .accelerator("CmdOrCtrl+Plus")
                    .build(app)?,
            )
            .item(
                &MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                    .accelerator("CmdOrCtrl+-")
                    .build(app)?,
            )
            .item(
                &MenuItemBuilder::with_id("zoom-reset", "Actual Size")
                    .accelerator("CmdOrCtrl+0")
                    .build(app)?,
            )
            .build()?;

        let window_menu = SubmenuBuilder::new(app, "Window")
            .minimize()
            .item(
                &MenuItemBuilder::with_id("fullscreen", "Toggle Full Screen")
                    .accelerator("Ctrl+CmdOrCtrl+F")
                    .build(app)?,
            )
            .build()?;

        let menu = Menu::with_items(
            app,
            &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
        )?;
        app.set_menu(menu)?;

        // Handle custom menu events
        let app_handle = app.handle().clone();
        app.on_menu_event(move |_app, event| {
            let id = event.id().0.as_str();
            match id {
                "new-session" | "toggle-sidebar" | "reload" | "zoom-in" | "zoom-out"
                | "zoom-reset" | "fullscreen" => {
                    let _ = app_handle.emit("menu-event", id);
                }
                _ => {}
            }
        });

        // -- System tray --
        let show_item = MenuItemBuilder::with_id("show", "Show Companion").build(app)?;
        let quit_item = MenuItemBuilder::with_id("quit-app", "Quit").build(app)?;
        let tray_menu = Menu::with_items(
            app,
            &[
                &show_item,
                &PredefinedMenuItem::separator(app)?,
                &quit_item,
            ],
        )?;

        let _tray = TrayIconBuilder::with_id("main-tray")
            .icon(app.default_window_icon().unwrap().clone())
            .menu(&tray_menu)
            .show_menu_on_left_click(false)
            .tooltip("Companion")
            .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        toggle_window(&window);
                    }
                }
            })
            .on_menu_event(|app: &tauri::AppHandle, event| {
                match event.id().0.as_str() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit-app" => {
                        app.exit(0);
                    }
                    _ => {}
                }
            })
            .build(app)?;

        Ok(())
    }

    pub fn setup_desktop_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
        builder
            .plugin(tauri_plugin_window_state::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                None,
            ))
    }

    pub fn on_desktop_window_event(window: &tauri::Window, event: &WindowEvent) {
        // Hide window on close instead of quitting (tray keeps running)
        if let WindowEvent::CloseRequested { api, .. } = event {
            let _ = window.hide();
            api.prevent_close();
        }
    }
}

fn main() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init());

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

    builder = builder.setup(|app| {
        #[cfg(desktop)]
        desktop::setup_desktop(app)?;

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
