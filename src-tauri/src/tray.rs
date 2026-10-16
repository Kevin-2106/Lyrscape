use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder,
};

#[derive(Default)]
pub struct ControlLifecycle {
    operation: Mutex<()>,
    geometry: Mutex<Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>, bool)>>,
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Lyrscape", true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", "显示 / 隐藏桌面歌词", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Lyrscape", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &overlay, &separator, &quit])?;
    TrayIconBuilder::with_id("lyrscape")
        .icon(
            app.default_window_icon()
                .expect("bundled application icon")
                .clone(),
        )
        .tooltip("Lyrscape · 点击打开，右键退出")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_control(app.clone()),
            "overlay" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = super::toggle_overlay(&app, "visibility") {
                        eprintln!("{error}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                open_control(tray.app_handle().clone());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn open_control(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = restore_control(&app) {
            eprintln!("Unable to restore control window: {error}");
        }
    });
}

fn restore_control(app: &AppHandle) -> Result<(), String> {
    let lifecycle = app.state::<ControlLifecycle>();
    let _operation = lifecycle
        .operation
        .lock()
        .map_err(|_| "Control window unavailable")?;
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("Missing control configuration")?;
    let window = WebviewWindowBuilder::from_config(app, config)
        .map_err(|e| e.to_string())?
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    if let Some((position, size, maximized)) = *lifecycle
        .geometry
        .lock()
        .map_err(|_| "Window geometry unavailable")?
    {
        window.set_position(position).map_err(|e| e.to_string())?;
        window.set_size(size).map_err(|e| e.to_string())?;
        if maximized {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }
    // The hydrated frontend shows the new window via control_ready.
    Ok(())
}

pub fn park_control(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<ControlLifecycle>();
        let Ok(_operation) = lifecycle.operation.lock() else {
            return;
        };
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let (Ok(position), Ok(size), Ok(maximized)) = (
            window.outer_position(),
            window.inner_size(),
            window.is_maximized(),
        ) {
            if let Ok(mut geometry) = lifecycle.geometry.lock() {
                *geometry = Some((position, size, maximized));
            }
        }
        app.state::<super::session::Session>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .control_active = false;
        let _ = app.emit_to(
            tauri::EventTarget::webview_window("overlay"),
            "control-presence",
            false,
        );
        // destroy bypasses close-requested and releases the actual WebView/controller.
        if let Err(error) = window.destroy() {
            app.state::<super::session::Session>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .control_active = true;
            let _ = app.emit("control-presence", true);
            eprintln!("Unable to release control window: {error}");
        } else {
            // Destruction is dispatched to the event loop. Keep a rapid tray
            // click from focusing the dying window instead of rebuilding it.
            for _ in 0..200 {
                if app.get_webview_window("main").is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    });
}

#[tauri::command]
pub fn control_loading(
    app: AppHandle,
    window: WebviewWindow,
    session: State<'_, super::session::Session>,
) -> Result<(), String> {
    super::require_control(&window)?;
    session
        .0
        .lock()
        .map_err(|_| "Session unavailable")?
        .control_active = false;
    app.emit_to(
        tauri::EventTarget::webview_window("overlay"),
        "control-presence",
        false,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn control_ready(
    app: AppHandle,
    window: WebviewWindow,
    session: State<'_, super::session::Session>,
    ready: Option<bool>,
) -> Result<(), String> {
    super::require_control(&window)?;
    if ready.unwrap_or(true) {
        session
            .0
            .lock()
            .map_err(|_| "Session unavailable")?
            .control_active = true;
        app.emit_to(
            tauri::EventTarget::webview_window("overlay"),
            "control-presence",
            true,
        )
        .map_err(|e| e.to_string())?;
        // Also hydrate older editable AMLL bundles that predate amll_replay.
        // Current adapters deduplicate these sequence-tagged messages.
        let mut status = app.state::<super::broker::Broker>().status().await;
        let selected = app.state::<super::audio::AudioHub>().selected_source();
        status
            .connections
            .sort_by_key(|id| selected.as_ref() != Some(id));
        for connection in status.connections {
            app.emit_to(
                tauri::EventTarget::webview_window("main"),
                "amll-connection",
                serde_json::json!({"connectionId": connection, "connected": true}),
            )
            .map_err(|e| e.to_string())?;
        }
        for message in session.control_replay() {
            app.emit_to(
                tauri::EventTarget::webview_window("main"),
                "amll-message",
                message,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
