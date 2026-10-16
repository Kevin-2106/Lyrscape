mod amll_protocol;
mod audio;
mod broker;
mod plugin_source;
mod shortcuts;

use broker::{Broker, BrokerStatus};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayStatus {
    visible: bool,
    always_on_top: bool,
    click_through: bool,
    border_visible: bool,
}

impl Default for OverlayStatus {
    fn default() -> Self {
        Self {
            visible: false,
            always_on_top: true,
            click_through: false,
            border_visible: false,
        }
    }
}

#[derive(Default)]
struct OverlayState(Mutex<OverlayStatus>, Mutex<()>);

fn require_control(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("This command is available only to the control window".into())
    }
}

#[tauri::command]
async fn amll_start(
    app: AppHandle,
    window: WebviewWindow,
    broker: State<'_, Broker>,
    port: Option<u16>,
    allowed_origins: Option<Vec<String>>,
) -> Result<BrokerStatus, String> {
    require_control(&window)?;
    broker
        .start(app, port.unwrap_or(11444), allowed_origins)
        .await
}

#[tauri::command]
async fn amll_stop(
    window: WebviewWindow,
    broker: State<'_, Broker>,
) -> Result<BrokerStatus, String> {
    require_control(&window)?;
    broker.stop().await
}

#[tauri::command]
async fn amll_status(
    window: WebviewWindow,
    broker: State<'_, Broker>,
) -> Result<BrokerStatus, String> {
    require_control(&window)?;
    Ok(broker.status().await)
}

#[tauri::command]
fn overlay_status(app: AppHandle, state: State<'_, OverlayState>) -> Result<OverlayStatus, String> {
    let mut status = state.0.lock().map_err(|_| "Overlay state is unavailable")?;
    status.visible = match app.get_webview_window("overlay") {
        Some(overlay) => overlay.is_visible().map_err(|error| error.to_string())?,
        None => false,
    };
    Ok(status.clone())
}

#[tauri::command]
fn overlay_exists(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    require_control(&window)?;
    Ok(app.get_webview_window("overlay").is_some())
}

// Creation runs off the UI thread (including calls from global shortcuts).
fn ensure_overlay(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        return Ok(window);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "overlay")
        .ok_or("Overlay configuration is unavailable")?;
    WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())
}

/// Inactive views may discard browser caches; playback and plugin IPC stay live.
fn set_inactive_memory(window: &WebviewWindow, inactive: bool) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        let _ = window.with_webview(move |webview| unsafe {
            if let Ok(core) = webview.controller().CoreWebView2() {
                if let Ok(core) = core.cast::<ICoreWebView2_19>() {
                    let level = if inactive {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    };
                    let _ = core.SetMemoryUsageTargetLevel(level);
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (window, inactive);
}

#[tauri::command]
async fn overlay_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    visible: Option<bool>,
    always_on_top: Option<bool>,
    click_through: Option<bool>,
    border_visible: Option<bool>,
) -> Result<OverlayStatus, String> {
    require_control(&window)?;
    update_overlay(
        &app,
        &state,
        visible,
        always_on_top,
        click_through,
        border_visible,
    )
}

fn update_overlay(
    app: &AppHandle,
    state: &OverlayState,
    visible: Option<bool>,
    always_on_top: Option<bool>,
    click_through: Option<bool>,
    border_visible: Option<bool>,
) -> Result<OverlayStatus, String> {
    let _operation = state.1.lock().map_err(|_| "Overlay state is unavailable")?;
    apply_overlay(
        app,
        state,
        visible,
        always_on_top,
        click_through,
        border_visible,
    )
}

fn apply_overlay(
    app: &AppHandle,
    state: &OverlayState,
    visible: Option<bool>,
    always_on_top: Option<bool>,
    click_through: Option<bool>,
    border_visible: Option<bool>,
) -> Result<OverlayStatus, String> {
    let mut result = state
        .0
        .lock()
        .map_err(|_| "Overlay state is unavailable")?
        .clone();
    if let Some(value) = always_on_top {
        result.always_on_top = value;
    }
    if let Some(value) = click_through {
        result.click_through = value;
    }
    if let Some(value) = border_visible {
        result.border_visible = value;
    }
    if let Some(value) = visible {
        result.visible = value;
    }
    // Keep flags usable before the first show, without allocating another renderer process.
    let overlay = if result.visible {
        Some(ensure_overlay(app)?)
    } else {
        app.get_webview_window("overlay")
    };
    if let Some(overlay) = overlay {
        overlay
            .set_always_on_top(result.always_on_top)
            .map_err(|error| error.to_string())?;
        overlay
            .set_ignore_cursor_events(result.click_through)
            .map_err(|error| error.to_string())?;
        if result.visible {
            set_inactive_memory(&overlay, false);
            overlay.show()
        } else {
            overlay.hide()
        }
        .map_err(|error| error.to_string())?;
        if !result.visible {
            set_inactive_memory(&overlay, true);
        }
    }
    *state.0.lock().map_err(|_| "Overlay state is unavailable")? = result.clone();
    app.emit("overlay-status", &result)
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn toggle_overlay(app: &AppHandle, action: &str) -> Result<OverlayStatus, String> {
    let state = app.state::<OverlayState>();
    let _operation = state.1.lock().map_err(|_| "Overlay state is unavailable")?;
    // Read actual visibility because the overlay can also be closed by the window manager.
    let visible = app
        .get_webview_window("overlay")
        .map(|overlay| overlay.is_visible())
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    let mut status = state.0.lock().map_err(|_| "Overlay state is unavailable")?;
    let change = match action {
        "visibility" => (Some(!visible), None, None),
        "clickthrough" => (None, Some(!status.click_through), None),
        "border" => (None, None, Some(!status.border_visible)),
        _ => return Err("未知桌面歌词操作".into()),
    };
    status.visible = visible;
    drop(status);
    apply_overlay(app, &state, change.0, None, change.1, change.2)
}

#[tauri::command]
fn overlay_fit(window: WebviewWindow, height: f64) -> Result<f64, String> {
    if window.label() != "overlay" {
        return Err("Only the overlay can fit its content height".into());
    }
    if !height.is_finite() || height <= 0.0 {
        return Err("Overlay height must be a positive finite number".into());
    }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?;
    let max_height = monitor
        .as_ref()
        .map(|monitor| monitor.size().height as f64 / monitor.scale_factor())
        .unwrap_or(1080.0)
        .max(90.0);
    let fitted = height.ceil().clamp(90.0, max_height);
    let size = window.inner_size().map_err(|error| error.to_string())?;
    if (size.height as f64 / scale - fitted).abs() > 0.5 {
        window
            .set_size(tauri::LogicalSize::new(size.width as f64 / scale, fitted))
            .map_err(|error| error.to_string())?;
    }
    if let Some(monitor) = monitor {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let top = monitor.position().y;
        let bottom = top + monitor.size().height as i32 - (fitted * scale).ceil() as i32;
        let y = position.y.clamp(top, bottom.max(top));
        if y != position.y {
            window
                .set_position(tauri::PhysicalPosition::new(position.x, y))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(fitted)
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Broker::default())
        .manage(OverlayState::default())
        .manage(shortcuts::ShortcutRegistry::default())
        .manage(audio::AudioHub::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| shortcuts::handle(app, shortcut, event.state))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            amll_start,
            amll_stop,
            amll_status,
            overlay_update,
            overlay_status,
            overlay_exists,
            overlay_fit,
            shortcuts::shortcuts_status,
            shortcuts::shortcut_set,
            shortcuts::shortcuts_clear,
            audio::amll_audio_subscribe,
            audio::amll_audio_unsubscribe,
            audio::amll_audio_ack,
            audio::amll_audio_select,
            plugin_source::plugin_source,
            plugin_source::plugin_catalog,
            plugin_source::plugin_install,
            plugin_source::plugin_uninstall,
            plugin_source::plugin_export_save,
            plugin_source::plugins_folder_open
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                if let Some(webview) = window.app_handle().get_webview_window("main") {
                    set_inactive_memory(&webview, window.is_minimized().unwrap_or(false));
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => window.app_handle().exit(0),
                    "overlay" => {
                        api.prevent_close();
                        let state = window.app_handle().state::<OverlayState>();
                        let _ = update_overlay(
                            window.app_handle(),
                            &state,
                            Some(false),
                            None,
                            None,
                            None,
                        );
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize Lyrscape desktop host");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Broker>().shutdown_on_exit();
        }
    });
}
